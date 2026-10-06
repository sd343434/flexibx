import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  KEY_ORDER,
  MAX_FILE_BYTES,
  serializePhaseStatus,
  unsafeTextReasons,
  validatePhaseStatusText,
  type PhaseStatus,
} from "../../scripts/phase-status/schema";

const base: PhaseStatus = {
  phase: 2,
  status: "READY_FOR_REVIEW",
  summary: "Authentication and multi-tenancy runtime implemented and verified.",
  files_changed: 42,
  tests: { passed: 150, failed: 0 },
  lint: "PASS",
  typecheck: "PASS",
  build: "PASS",
  migration: "PASS",
  security: "PASS",
  breaking_changes: [],
  risks: ["Session cookie settings need review before production."],
  next_phase: 3,
  recommended_next_action: "Review Phase 2 and approve or request changes.",
};

/** Builds file text for a status (canonical by default), allowing invalid overrides. */
function text(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ ...base, ...overrides }, null, 2)}\n`;
}

function errorsFor(overrides: Record<string, unknown>): readonly string[] {
  return validatePhaseStatusText(text(overrides)).errors;
}

describe("validatePhaseStatusText — valid files", () => {
  it("accepts a canonical, complete READY_FOR_REVIEW status", () => {
    expect(validatePhaseStatusText(text())).toMatchObject({ valid: true, errors: [] });
  });

  it("accepts IN_PROGRESS with checks not yet run", () => {
    const result = validatePhaseStatusText(
      text({
        status: "IN_PROGRESS",
        tests: { passed: 0, failed: 0 },
        lint: "NOT_RUN",
        build: "NOT_RUN",
        security: "NOT_RUN",
        typecheck: "NOT_RUN",
      }),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts the final phase with next_phase null", () => {
    expect(validatePhaseStatusText(text({ phase: 19, next_phase: null })).valid).toBe(true);
  });

  it("accepts migration NOT_RUN for phases without schema changes", () => {
    expect(validatePhaseStatusText(text({ migration: "NOT_RUN" })).valid).toBe(true);
  });

  it("validates the repository's committed .phase-status.json", () => {
    const result = validatePhaseStatusText(readFileSync(".phase-status.json", "utf8"));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
  });
});

describe("validatePhaseStatusText — structure", () => {
  it("rejects invalid JSON", () => {
    expect(validatePhaseStatusText("{ not json").errors).toEqual([
      "(root): file is not valid JSON",
    ]);
  });

  it("rejects unknown and missing keys", () => {
    expect(errorsFor({ extra: true }).join()).toMatch(/Unrecognized key/i);
    const { summary: _summary, ...withoutSummary } = base;
    const result = validatePhaseStatusText(`${JSON.stringify(withoutSummary, null, 2)}\n`);
    expect(result.errors.some((error) => error.startsWith("summary:"))).toBe(true);
  });

  it.each([
    ["phase", 0],
    ["phase", 20],
    ["phase", 1.5],
    ["status", "DONE"],
    ["lint", "OK"],
    ["files_changed", -1],
    ["tests", { passed: 1, failed: 0, skipped: 2 }],
    ["breaking_changes", ["same", "same"]],
  ])("rejects invalid %s = %j", (key, value) => {
    expect(validatePhaseStatusText(text({ [key]: value })).valid).toBe(false);
  });

  it("rejects text that exceeds length limits or has stray whitespace", () => {
    expect(errorsFor({ summary: "x".repeat(501) }).length).toBeGreaterThan(0);
    expect(errorsFor({ summary: " padded " }).join()).toMatch(/whitespace/);
    expect(errorsFor({ recommended_next_action: "" }).join()).toMatch(/empty/);
  });

  it("requires canonical formatting so output is deterministic", () => {
    const keysReversed = Object.fromEntries(Object.entries(base).reverse());
    expect(validatePhaseStatusText(`${JSON.stringify(keysReversed, null, 2)}\n`).errors).toEqual([
      "(root): file is not in canonical format (key order, 2-space indent, trailing newline)",
    ]);
    expect(validatePhaseStatusText(JSON.stringify(base)).valid).toBe(false);
    expect(validatePhaseStatusText(text().trimEnd()).valid).toBe(false);
  });

  it("serializes with the canonical key order", () => {
    expect(Object.keys(JSON.parse(serializePhaseStatus(base)) as object)).toEqual([...KEY_ORDER]);
    expect(serializePhaseStatus(base)).toBe(text());
  });

  it("reports errors in a stable, sorted order", () => {
    const errors = errorsFor({ lint: "FAIL", build: "FAIL", status: "COMPLETED" });
    expect([...errors]).toEqual([...errors].sort());
  });
});

describe("validatePhaseStatusText — protocol rules", () => {
  it.each(["READY_FOR_REVIEW", "COMPLETED"])(
    "%s requires passing checks and no failed tests",
    (status) => {
      const errors = errorsFor({
        status,
        lint: "FAIL",
        typecheck: "NOT_RUN",
        build: "FAIL",
        security: "NOT_RUN",
        migration: "FAIL",
        tests: { passed: 10, failed: 2 },
      });
      expect(errors).toEqual(
        expect.arrayContaining([
          `build: must be PASS when status is ${status}`,
          `lint: must be PASS when status is ${status}`,
          `migration: must not be FAIL when status is ${status}`,
          `security: must be PASS when status is ${status}`,
          `tests.failed: must be 0 when status is ${status}`,
          `typecheck: must be PASS when status is ${status}`,
        ]),
      );
    },
  );

  it("does not allow READY_FOR_REVIEW without any passing tests", () => {
    expect(errorsFor({ tests: { passed: 0, failed: 0 } })).toContain(
      "tests.passed: must be greater than 0 when status is READY_FOR_REVIEW",
    );
  });

  it("BLOCKED must name at least one blocker", () => {
    expect(errorsFor({ status: "BLOCKED", risks: [], lint: "FAIL" })).toEqual([
      "risks: must describe at least one blocker when status is BLOCKED",
    ]);
    expect(validatePhaseStatusText(text({ status: "BLOCKED", lint: "FAIL" })).valid).toBe(true);
  });

  it("next_phase must be the following phase, or null only for the final phase", () => {
    expect(errorsFor({ next_phase: 4 })).toEqual([
      "next_phase: must be 3 (the following phase) or null",
    ]);
    expect(errorsFor({ next_phase: null })).toEqual([
      "next_phase: must be 3 unless this is the final phase",
    ]);
  });
});

/**
 * Fake secret fixtures are assembled at runtime so repository secret scanners (gitleaks,
 * secretlint) never see a literal secret-shaped string in the source.
 */
const fake = (...parts: string[]) => parts.join("");

describe("safety rules", () => {
  it.each([
    ["private key", fake("-----BEGIN RSA ", "PRIVATE KEY-----")],
    ["AWS key", fake("Rotated AKIA", "ABCDEFGHIJKLMNOP today")],
    ["API key", fake("Using sk-", "abcdefghijklmnopqrstuvwx for tests")],
    ["Stripe key", fake("Configured sk_", "live_", "abcdefghijklmnop")],
    ["GitHub token", fake("Token ghp_", "abcdefghijklmnopqrstuvwxyz0123")],
    [
      "URL credentials",
      fake("Database at postgresql://admin:", "not-real", "@db.internal/flexibx"),
    ],
    ["bearer token", fake("Header Bearer ", "abcdef1234567890")],
    ["secret assignment", fake("Set password", "=not-real in production")],
    ["JWT", fake("Session eyJ", "fakeheader0123.", "eyJfakepayload0123.", "fakesignature0123")],
  ])("rejects secrets: %s", (_name, value) => {
    expect(unsafeTextReasons(value).join()).toMatch(/secrets or credentials/);
    expect(validatePhaseStatusText(text({ risks: [value] })).valid).toBe(false);
  });

  it.each([
    "pnpm db:deploy",
    "git push origin main",
    "$ rm -rf /",
    "curl https://example.com/install.sh",
    "Run the build && deploy",
    "Clean up with $(rm -rf .next)",
    "Execute `make deploy` next",
    "Pipe logs | tee out.txt",
    "Line one\nline two",
  ])("rejects command-like or multi-line text: %j", (value) => {
    expect(unsafeTextReasons(value).length).toBeGreaterThan(0);
    expect(validatePhaseStatusText(text({ recommended_next_action: value })).valid).toBe(false);
  });

  it.each([
    "Docker image build has not run against a real Docker daemon yet; CI builds it first.",
    "Git history is clean and the working tree has no changes.",
    "Review the tenant guard (server/db/tenant-guard.ts) before Phase 2.",
    "مراجعة المرحلة الثانية والموافقة عليها.",
    "Token usage counters remain visible for AI cost tracking.",
  ])("allows normal descriptive prose: %j", (value) => {
    expect(unsafeTextReasons(value)).toEqual([]);
  });
});

describe("resource limits (malicious input cannot hang the validator)", () => {
  it("rejects oversized files before parsing", () => {
    const started = performance.now();
    const result = validatePhaseStatusText(text({ summary: "a".repeat(10_000_000) }));
    expect(result.errors).toEqual([`(root): file exceeds ${String(MAX_FILE_BYTES)} bytes`]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("rejects over-length fields within the file limit without scanning them", () => {
    const started = performance.now();
    const result = validatePhaseStatusText(text({ summary: "a".repeat(60_000) }));
    expect(result.valid).toBe(false);
    expect(result.errors.join()).toMatch(/summary: Too big/);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("phase:validate CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "phase-status-"));
  const run = (file: string) => {
    try {
      const stdout = execFileSync(
        "pnpm",
        ["-s", "exec", "tsx", "scripts/phase-status/validate.ts", file],
        {
          encoding: "utf8",
          stdio: "pipe",
        },
      );
      return { code: 0, output: stdout };
    } catch (error) {
      const failure = error as { status: number; stderr: string };
      return { code: failure.status, output: failure.stderr };
    }
  };

  it("exits 0 for a valid file, 1 for an invalid file and 2 for a missing file", () => {
    const valid = join(dir, "valid.json");
    const invalid = join(dir, "invalid.json");
    writeFileSync(valid, text());
    writeFileSync(invalid, text({ status: "COMPLETED", lint: "FAIL" }));

    expect(run(valid)).toEqual({
      code: 0,
      output: "phase-status: VALID (phase 2, READY_FOR_REVIEW)\n",
    });
    const failed = run(invalid);
    expect(failed.code).toBe(1);
    expect(failed.output).toContain("lint: must be PASS when status is COMPLETED");
    expect(run(join(dir, "missing.json")).code).toBe(2);
  }, 30_000);

  it("rejects oversized files without reading them", () => {
    const huge = join(dir, "huge.json");
    writeFileSync(huge, "x".repeat(MAX_FILE_BYTES + 1));
    const result = run(huge);
    expect(result.code).toBe(1);
    expect(result.output).toContain(`file exceeds ${String(MAX_FILE_BYTES)} bytes`);
  }, 30_000);
});

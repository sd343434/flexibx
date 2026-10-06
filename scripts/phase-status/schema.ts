// Phase completion protocol — schema, safety rules and canonical serialization for
// `.phase-status.json`. See docs/PHASE_COMPLETION_PROTOCOL.md.
//
// The file is read by humans and (later) by automated reviewers/orchestrators. It must be:
//  - deterministic: one canonical serialization (fixed key order, 2-space indent, LF),
//  - safe: no secrets/credentials, and no text shaped like executable shell commands,
//  - closed: unknown keys are rejected.
// Consumers must treat every string as display text and never execute it.
import { z } from "zod";

export const PHASE_STATUSES = ["IN_PROGRESS", "READY_FOR_REVIEW", "COMPLETED", "BLOCKED"] as const;
export const CHECK_RESULTS = ["PASS", "FAIL", "NOT_RUN"] as const;

/** Highest phase in the Flexibx roadmap (Phase 19: production deployment). */
export const MAX_PHASE = 19;

export const LIMITS = {
  summary: 500,
  listItem: 300,
  listItems: 20,
  recommendedNextAction: 300,
} as const;

/**
 * Maximum file size. A maximal valid file is ~15 KB; anything larger is rejected before
 * parsing so oversized or malicious input cannot exhaust memory or CPU.
 */
export const MAX_FILE_BYTES = 64 * 1024;

/** Canonical key order. Serialization always follows this order. */
export const KEY_ORDER = [
  "phase",
  "status",
  "summary",
  "files_changed",
  "tests",
  "lint",
  "typecheck",
  "build",
  "migration",
  "security",
  "breaking_changes",
  "risks",
  "next_phase",
  "recommended_next_action",
] as const;

/** Patterns that look like secrets or credentials. Matching text is rejected outright. */
export const SECRET_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: "private key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "AWS access key", pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: "API key (sk-…)", pattern: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: "Stripe key", pattern: /\b[sr]k_(live|test)_[A-Za-z0-9]{10,}/ },
  { name: "GitHub token", pattern: /\b(ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/ },
  { name: "Slack token", pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/ },
  { name: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
  { name: "credentials in URL", pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i },
  { name: "bearer token", pattern: /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i },
  {
    name: "secret assignment",
    pattern: /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key)\s*[:=]\s*\S+/i,
  },
];

/** Shell metacharacters / substitution syntax. Prose never needs these. */
const SHELL_SYNTAX = /`|\$\(|\$\{|&&|\|\||\||>>|<</;

/**
 * Text that starts like a command line (e.g. "pnpm test", "git push", "$ rm -rf").
 * Case-sensitive: shell commands are lowercase, while prose starts with a capital
 * ("Docker image…", "Git history…").
 */
const COMMAND_PREFIX =
  /^\s*(\$\s|#!|(sudo|rm|curl|wget|bash|sh|zsh|node|npx|npm|pnpm|yarn|git|docker|psql|prisma|chmod|chown|eval|exec|python3?|ssh|scp|kubectl)(\s|$))/;

// eslint-disable-next-line no-control-regex -- intentionally detects control characters
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** Returns the reasons a string is unsafe for the status file (empty = safe). */
export function unsafeTextReasons(value: string): string[] {
  const reasons: string[] = [];
  if (CONTROL_CHARACTERS.test(value))
    reasons.push("must be a single line without control characters");
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(value)) reasons.push(`must not contain secrets or credentials (${name})`);
  }
  if (SHELL_SYNTAX.test(value))
    reasons.push("must not contain shell syntax (` $( ${ && || | >> <<)");
  if (COMMAND_PREFIX.test(value)) reasons.push("must be descriptive prose, not a command line");
  return reasons;
}

const safeText = (max: number, options: { readonly allowEmpty?: boolean } = {}) =>
  z
    .string()
    .max(max)
    .refine((value) => options.allowEmpty === true || value.trim().length > 0, {
      message: "must not be empty",
    })
    .refine((value) => value === value.trim(), {
      message: "must not have leading or trailing whitespace",
    })
    .superRefine((value, ctx) => {
      // Over-length text is already rejected by `.max()`; skip the pattern scan so the
      // safety regexes only ever run on bounded input.
      if (value.length > max) return;
      for (const reason of unsafeTextReasons(value))
        ctx.addIssue({ code: "custom", message: reason });
    });

const safeList = z
  .array(safeText(LIMITS.listItem))
  .max(LIMITS.listItems)
  .refine((items) => new Set(items).size === items.length, {
    message: "must not contain duplicates",
  });

const phaseNumber = z.number().int().min(1).max(MAX_PHASE);
const count = z.number().int().min(0).max(1_000_000);
const checkResult = z.enum(CHECK_RESULTS);

const baseSchema = z
  .object({
    phase: phaseNumber,
    status: z.enum(PHASE_STATUSES),
    summary: safeText(LIMITS.summary),
    files_changed: count,
    tests: z.object({ passed: count, failed: count }).strict(),
    lint: checkResult,
    typecheck: checkResult,
    build: checkResult,
    migration: checkResult,
    security: checkResult,
    breaking_changes: safeList,
    risks: safeList,
    next_phase: phaseNumber.nullable(),
    recommended_next_action: safeText(LIMITS.recommendedNextAction),
  })
  .strict();

export type PhaseStatus = z.infer<typeof baseSchema>;

/** Checks that must PASS before a phase may be READY_FOR_REVIEW or COMPLETED. */
export const REQUIRED_PASSING_CHECKS = ["lint", "typecheck", "build", "security"] as const;

/** Full schema: field rules plus cross-field protocol rules. */
export const phaseStatusSchema = baseSchema.superRefine((status, ctx) => {
  const issue = (path: PropertyKey[], message: string) => {
    ctx.addIssue({ code: "custom", path, message });
  };

  if (status.next_phase !== null && status.next_phase !== status.phase + 1) {
    issue(["next_phase"], `must be ${String(status.phase + 1)} (the following phase) or null`);
  }
  if (status.next_phase === null && status.phase < MAX_PHASE) {
    issue(["next_phase"], `must be ${String(status.phase + 1)} unless this is the final phase`);
  }

  const isDone = status.status === "READY_FOR_REVIEW" || status.status === "COMPLETED";
  if (isDone) {
    for (const check of REQUIRED_PASSING_CHECKS) {
      if (status[check] !== "PASS") issue([check], `must be PASS when status is ${status.status}`);
    }
    if (status.migration === "FAIL")
      issue(["migration"], `must not be FAIL when status is ${status.status}`);
    if (status.tests.failed !== 0)
      issue(["tests", "failed"], `must be 0 when status is ${status.status}`);
    if (status.tests.passed === 0)
      issue(["tests", "passed"], `must be greater than 0 when status is ${status.status}`);
  }

  if (status.status === "BLOCKED" && status.risks.length === 0) {
    issue(["risks"], "must describe at least one blocker when status is BLOCKED");
  }
});

/** Deterministic serialization: canonical key order, 2-space indent, trailing newline. */
export function serializePhaseStatus(status: PhaseStatus): string {
  const ordered: Record<string, unknown> = {};
  for (const key of KEY_ORDER) {
    ordered[key] =
      key === "tests" ? { passed: status.tests.passed, failed: status.tests.failed } : status[key];
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

export interface ValidationResult {
  readonly valid: boolean;
  readonly errors: readonly string[];
  readonly status?: PhaseStatus;
}

/**
 * Validates raw file contents: JSON syntax, schema, protocol rules, safety rules and
 * canonical formatting. Errors are sorted so output is deterministic.
 */
export function validatePhaseStatusText(text: string): ValidationResult {
  if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
    return { valid: false, errors: [`(root): file exceeds ${String(MAX_FILE_BYTES)} bytes`] };
  }

  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return { valid: false, errors: ["(root): file is not valid JSON"] };
  }

  const result = phaseStatusSchema.safeParse(data);
  if (!result.success) {
    const errors = result.error.issues
      .map(
        (issue) => `${issue.path.length === 0 ? "(root)" : issue.path.join(".")}: ${issue.message}`,
      )
      .sort();
    return { valid: false, errors: [...new Set(errors)] };
  }

  if (text !== serializePhaseStatus(result.data)) {
    return {
      valid: false,
      errors: [
        "(root): file is not in canonical format (key order, 2-space indent, trailing newline)",
      ],
      status: result.data,
    };
  }

  return { valid: true, errors: [], status: result.data };
}

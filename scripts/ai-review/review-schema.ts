// AI Reviewer response contract — strict schema, safety rules and decision rules.
// See REVIEW_CONTRACT.md. Pure module: no I/O, no network, no process execution.
//
// Every string in a review is UNTRUSTED data produced by an AI. Validation proves only
// that a response is well-formed and internally consistent — never that it is correct.
import { z } from "zod";

import { SECRET_PATTERNS } from "../phase-status/schema";

export const REVIEW_SCHEMA_VERSION = 1;

export const DECISIONS = [
  "APPROVE_NEXT_PHASE",
  "FIX_REQUIRED",
  "BLOCKED",
  "HUMAN_REVIEW_REQUIRED",
] as const;
export const SEVERITIES = ["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export const CATEGORIES = [
  "CORRECTNESS",
  "SECURITY",
  "TESTING",
  "ARCHITECTURE",
  "DATABASE",
  "PERFORMANCE",
  "DX",
  "OTHER",
] as const;

export const MIN_PHASE = 1;
export const MAX_PHASE = 19;

/** Strict size limits. A response exceeding the file cap is rejected before parsing. */
export const REVIEW_LIMITS = {
  fileBytes: 256 * 1024,
  summary: 2000,
  title: 160,
  description: 2000,
  evidence: 2000,
  nextPrompt: 8000,
  findings: 50,
  requiredActions: 30,
} as const;

// ── Text rules ───────────────────────────────────────────────────────────────

/** Shell metacharacters / substitution syntax rejected in executable-adjacent text. */
export const SHELL_SYNTAX: readonly { readonly token: string; readonly pattern: RegExp }[] = [
  { token: "`", pattern: /`/ },
  { token: "$(", pattern: /\$\(/ },
  { token: "${", pattern: /\$\{/ },
  { token: "&&", pattern: /&&/ },
  { token: "||", pattern: /\|\|/ },
  { token: "|", pattern: /\|/ },
  { token: ">>", pattern: />>/ },
  { token: "<<", pattern: /<</ },
];

// eslint-disable-next-line no-control-regex -- intentionally detects control characters
const CONTROL_EXCEPT_NEWLINE = /[\u0000-\u0009\u000b-\u001f\u007f]/;
// eslint-disable-next-line no-control-regex -- intentionally detects control characters
const ANY_CONTROL = /[\u0000-\u001f\u007f]/;
/** Bidirectional overrides/isolates can make text display differently from what it is. */
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/;

/** Secret-like content found in a string, as rule names (empty = none). */
export function secretFindings(value: string): string[] {
  return SECRET_PATTERNS.filter(({ pattern }) => pattern.test(value)).map(({ name }) => name);
}

/** Shell tokens found in a string (empty = none). */
export function shellTokens(value: string): string[] {
  return SHELL_SYNTAX.filter(({ pattern }) => pattern.test(value)).map(({ token }) => token);
}

interface TextRules {
  readonly max: number;
  readonly multiline?: boolean;
  readonly rejectShell?: boolean;
}

/**
 * Untrusted text field. Checks run only on bounded input: over-length strings are
 * rejected by `.max()` and skip the pattern scans.
 */
const untrustedText = ({ max, multiline = false, rejectShell = false }: TextRules) =>
  z
    .string()
    .max(max)
    .superRefine((value, ctx) => {
      if (value.length > max) return;
      const issue = (message: string) => {
        ctx.addIssue({ code: "custom", message });
      };
      if (value.trim().length === 0) issue("must not be empty");
      if ((multiline ? CONTROL_EXCEPT_NEWLINE : ANY_CONTROL).test(value)) {
        issue(
          multiline
            ? "must not contain control characters other than newlines"
            : "must be a single line without control characters",
        );
      }
      if (BIDI_CONTROLS.test(value)) issue("must not contain bidirectional control characters");
      for (const name of secretFindings(value))
        issue(`must not contain secrets or credentials (${name})`);
      if (rejectShell) {
        for (const token of shellTokens(value)) issue(`must not contain shell syntax (${token})`);
      }
    });

// ── Schema ───────────────────────────────────────────────────────────────────

const phaseNumber = z.number().int().min(MIN_PHASE).max(MAX_PHASE);

const findingSchema = z
  .object({
    severity: z.enum(SEVERITIES),
    category: z.enum(CATEGORIES),
    title: untrustedText({ max: REVIEW_LIMITS.title }),
    description: untrustedText({ max: REVIEW_LIMITS.description, multiline: true }),
    evidence: untrustedText({ max: REVIEW_LIMITS.evidence, multiline: true }),
    blocking: z.boolean(),
  })
  .strict();

const requiredActionSchema = z
  .object({
    title: untrustedText({ max: REVIEW_LIMITS.title, rejectShell: true }),
    description: untrustedText({
      max: REVIEW_LIMITS.description,
      multiline: true,
      rejectShell: true,
    }),
    blocking: z.boolean(),
  })
  .strict();

const baseReviewSchema = z
  .object({
    schema_version: z.literal(REVIEW_SCHEMA_VERSION),
    decision: z.enum(DECISIONS),
    phase: phaseNumber,
    next_phase: phaseNumber.nullable(),
    confidence: z.number().min(0).max(1),
    summary: untrustedText({ max: REVIEW_LIMITS.summary, multiline: true }),
    findings: z.array(findingSchema).max(REVIEW_LIMITS.findings),
    required_actions: z.array(requiredActionSchema).max(REVIEW_LIMITS.requiredActions),
    next_prompt: untrustedText({
      max: REVIEW_LIMITS.nextPrompt,
      multiline: true,
      rejectShell: true,
    }).nullable(),
  })
  .strict();

export type AiReview = z.infer<typeof baseReviewSchema>;
export type ReviewDecision = (typeof DECISIONS)[number];

/** Full contract: field rules plus decision rules. */
export const aiReviewSchema = baseReviewSchema.superRefine((review, ctx) => {
  const issue = (path: PropertyKey[], message: string) => {
    ctx.addIssue({ code: "custom", path, message });
  };

  const blockingFinding = review.findings.some((finding) => finding.blocking);
  const blockingAction = review.required_actions.some((action) => action.blocking);

  if (review.next_phase !== null && review.next_phase !== review.phase + 1) {
    issue(["next_phase"], `must be ${String(review.phase + 1)} (the following phase) or null`);
  }

  if (review.decision !== "APPROVE_NEXT_PHASE" && review.next_prompt !== null) {
    issue(["next_prompt"], `must be null unless decision is APPROVE_NEXT_PHASE`);
  }

  switch (review.decision) {
    case "APPROVE_NEXT_PHASE": {
      if (review.phase === MAX_PHASE) {
        issue(
          ["decision"],
          `APPROVE_NEXT_PHASE is not allowed for the final phase (${String(MAX_PHASE)})`,
        );
      } else if (review.next_phase !== review.phase + 1) {
        issue(
          ["next_phase"],
          `must be ${String(review.phase + 1)} when decision is APPROVE_NEXT_PHASE`,
        );
      }
      if (review.next_prompt === null) {
        issue(["next_prompt"], "is required when decision is APPROVE_NEXT_PHASE");
      }
      review.findings.forEach((finding, index) => {
        if (finding.blocking && (finding.severity === "HIGH" || finding.severity === "CRITICAL")) {
          issue(
            ["findings", index],
            `blocking ${finding.severity} finding is not allowed when decision is APPROVE_NEXT_PHASE`,
          );
        }
      });
      review.required_actions.forEach((action, index) => {
        if (action.blocking) {
          issue(
            ["required_actions", index],
            "blocking action is not allowed when decision is APPROVE_NEXT_PHASE",
          );
        }
      });
      break;
    }
    case "FIX_REQUIRED":
    case "BLOCKED": {
      if (!blockingFinding && !blockingAction) {
        issue(
          ["decision"],
          `${review.decision} requires at least one blocking finding or blocking required action`,
        );
      }
      break;
    }
    case "HUMAN_REVIEW_REQUIRED":
      break;
  }
});

// ── Validation entry point ───────────────────────────────────────────────────

export interface ReviewValidationResult {
  readonly valid: boolean;
  /** Sorted, de-duplicated `path: message` strings. */
  readonly errors: readonly string[];
  /** The validated review (only when valid). Consumers must use this, never re-parse. */
  readonly review?: AiReview;
}

/** Validates raw AI review text. Pure and deterministic: same input, same result. */
export function validateReviewText(text: string): ReviewValidationResult {
  if (Buffer.byteLength(text, "utf8") > REVIEW_LIMITS.fileBytes) {
    return {
      valid: false,
      errors: [`(root): review exceeds ${String(REVIEW_LIMITS.fileBytes)} bytes`],
    };
  }

  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    return { valid: false, errors: ["(root): review is not valid JSON"] };
  }

  const result = aiReviewSchema.safeParse(data);
  if (!result.success) {
    const errors = result.error.issues.map(
      (issue) =>
        `${issue.path.length === 0 ? "(root)" : issue.path.map(String).join(".")}: ${issue.message}`,
    );
    return { valid: false, errors: [...new Set(errors)].sort() };
  }
  return { valid: true, errors: [], review: result.data };
}

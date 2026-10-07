// AI review input — types. This package only PREPARES input for a future AI Reviewer;
// it never calls an AI provider or any network service.
import type { PhaseStatus } from "../phase-status/schema";

/** Bump when the review-input shape changes in a way consumers must know about. */
export const REVIEW_INPUT_SCHEMA_VERSION = 2;

/**
 * The ONLY git operations this package can perform. Each name maps to a fixed argument
 * builder in collect.ts. The only variable arguments are commit IDs that have passed
 * the full 40-hex-character check (or the literal `HEAD`); nothing else from the status
 * file, the repository or the environment can reach git's argument list.
 */
export type GitCommandName =
  | "branch"
  | "head"
  | "parent"
  | "workingTreeStatus"
  | "verifyCommit"
  | "isAncestor"
  | "rangeLog"
  | "rangeStat"
  | "rangeFiles"
  | "rangePatch";

/** A verified full commit ID (40 lowercase hex characters), or the literal `HEAD`. */
export type CommitRef = string & { readonly __commitRef: true };

export interface GitParams {
  /** Range start (exclusive). `null` means "from the empty tree" (repository root). */
  readonly from?: CommitRef | null;
  readonly to?: CommitRef;
  readonly commit?: CommitRef;
}

/** Runs one allowlisted git command. Returns stdout, or null if git reported an error. */
export type GitReader = (command: GitCommandName, params?: GitParams) => string | null;

/** Reads the raw `.phase-status.json` text; returns null if the file does not exist. */
export type StatusFileReader = () => StatusFileRead;

export type StatusFileRead =
  | { readonly kind: "missing" }
  | { readonly kind: "too_large"; readonly bytes: number }
  | { readonly kind: "ok"; readonly text: string };

export interface FileChange {
  /** Git status code, e.g. `M`, `A`, `D`, `R100`, `??`. */
  readonly status: string;
  readonly path: string;
}

export interface CommitSummary {
  readonly hash: string;
  readonly subject: string;
}

export type PhaseSection =
  | { readonly state: "VALID"; readonly errors: readonly []; readonly status: PhaseStatus }
  | { readonly state: "INVALID"; readonly errors: readonly string[]; readonly status: null }
  | { readonly state: "MISSING"; readonly errors: readonly string[]; readonly status: null };

/** Why the phase implementation boundary could not be verified. Fixed codes only. */
export type BoundaryFailure =
  | "STATUS_MISSING"
  | "STATUS_INVALID"
  | "BOUNDARY_NOT_DECLARED"
  | "HEAD_UNAVAILABLE"
  | "COMMIT_NOT_FOUND"
  | "NOT_ANCESTOR_OF_HEAD"
  | "BASE_NOT_FOUND"
  | "BASE_NOT_ANCESTOR"
  | "HISTORY_UNAVAILABLE";

export interface PatchFile {
  readonly path: string;
  /** Sanitized unified diff for this file (secrets redacted, lines bounded). */
  readonly diff: string;
  /** True when this file's diff was cut at the per-file limit. */
  readonly truncated: boolean;
}

export interface PatchEvidence {
  readonly files: readonly PatchFile[];
  /** Files in the range whose diff is not included, with a fixed reason. */
  readonly omitted: readonly {
    readonly path: string;
    readonly reason: "BUDGET" | "LOCKFILE" | "SENSITIVE";
  }[];
  readonly char_budget: number;
  readonly per_file_char_limit: number;
}

export interface ValidationEvidence {
  readonly unit_test_files: readonly string[];
  readonly integration_test_files: readonly string[];
  readonly e2e_test_files: readonly string[];
  readonly ci_files: readonly string[];
  readonly docker_files: readonly string[];
  readonly migration_files: readonly string[];
  readonly security_relevant_files: readonly string[];
}

export type PhaseImplementationEvidence =
  | {
      readonly state: "VERIFIED";
      /** Range (base, head]; base null = from the repository root. */
      readonly base: string | null;
      readonly head: string;
      readonly commits: readonly CommitSummary[];
      readonly diff_stat: readonly string[];
      readonly files: readonly FileChange[];
      readonly sensitive_paths: readonly string[];
      readonly patch: PatchEvidence;
      readonly validation: ValidationEvidence;
      readonly truncated: boolean;
    }
  | { readonly state: "UNDETERMINED"; readonly reason: BoundaryFailure };

export type PostPhaseEvidence =
  | {
      readonly state: "VERIFIED";
      /** Commits after the phase head up to HEAD (e.g. review tooling). Not part of the phase. */
      readonly commits: readonly CommitSummary[];
      readonly files: readonly FileChange[];
      /** Post-phase changes to application/runtime paths, which deserve reviewer attention. */
      readonly application_paths_changed: readonly string[];
      readonly truncated: boolean;
    }
  | { readonly state: "UNDETERMINED"; readonly reason: BoundaryFailure };

export interface ReviewInput {
  readonly schema_version: number;
  readonly protocol: {
    readonly name: string;
    readonly document: string;
    readonly status_file: string;
    readonly purpose: string;
    readonly reviewer_constraints: readonly string[];
  };
  readonly repository: {
    readonly branch: string | null;
    readonly head: string | null;
    readonly parent: string | null;
    readonly working_tree: {
      readonly clean: boolean;
      readonly entries: readonly FileChange[];
      readonly truncated: boolean;
      /** Paths that look like secret files (e.g. `.env`). Their contents are never read. */
      readonly sensitive_paths: readonly string[];
    };
  };
  readonly phase: PhaseSection;
  readonly evidence: {
    readonly phase_implementation: PhaseImplementationEvidence;
    readonly post_phase: PostPhaseEvidence;
  };
}

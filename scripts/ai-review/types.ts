// AI review input — types. This package only PREPARES input for a future AI Reviewer;
// it never calls an AI provider or any network service.
import type { PhaseStatus } from "../phase-status/schema";

/** Bump when the review-input shape changes in a way consumers must know about. */
export const REVIEW_INPUT_SCHEMA_VERSION = 1;

/**
 * The ONLY git operations this package can perform. Each name maps to a fixed argument
 * list in collect.ts; nothing from the status file or the environment can add arguments.
 */
export type GitCommandName =
  | "branch"
  | "head"
  | "parent"
  | "latestCommitStat"
  | "latestCommitFiles"
  | "rootCommitStat"
  | "rootCommitFiles"
  | "workingTreeStatus";

/** Runs one allowlisted git command. Returns stdout, or null if git reported an error. */
export type GitReader = (command: GitCommandName) => string | null;

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

export type PhaseSection =
  | { readonly state: "VALID"; readonly errors: readonly []; readonly status: PhaseStatus }
  | { readonly state: "INVALID"; readonly errors: readonly string[]; readonly status: null }
  | { readonly state: "MISSING"; readonly errors: readonly string[]; readonly status: null };

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
    readonly latest_commit: {
      readonly is_root_commit: boolean;
      readonly diff_stat: readonly string[];
      readonly files: readonly FileChange[];
      readonly truncated: boolean;
      readonly sensitive_paths: readonly string[];
    };
  };
}

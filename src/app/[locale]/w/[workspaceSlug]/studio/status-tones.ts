import type { BadgeTone } from "@/components/marketing/page-parts";

export const PROJECT_STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  DRAFT: "muted",
  UPLOADING: "accent",
  READY: "outline",
  PROCESSING: "accent",
  NEEDS_REVIEW: "soft",
  COMPLETED: "solid",
  FAILED: "danger",
  DELETING: "muted",
};

export const JOB_STATE_TONES: Readonly<Record<string, BadgeTone>> = {
  QUEUED: "muted",
  RUNNING: "accent",
  SUCCEEDED: "soft",
  FAILED: "danger",
  CANCELLED: "muted",
};

export const CLIP_STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  SUGGESTED: "outline",
  APPROVED: "solid",
  REJECTED: "muted",
};

export const EXPORT_STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  QUEUED: "muted",
  RENDERING: "accent",
  READY: "solid",
  FAILED: "danger",
  CANCELLED: "muted",
};

export const SOURCE_STATUS_TONES: Readonly<Record<string, BadgeTone>> = {
  PENDING_UPLOAD: "muted",
  UPLOADED: "accent",
  VERIFIED: "soft",
  REJECTED: "danger",
  EXPIRED: "muted",
};

import { z } from "zod";

// Input schemas for the video-generation server actions (pure, strict). They accept only
// the form's own fields: anything else — a workspace id, a role, a budget, a price, a
// provider or a number of attempts — is rejected as an unknown key. The workspace comes
// from the session's membership (by slug); money and limits come from the server.
// Value rules (lengths, allowed shapes, tiers) are checked by `videoBriefSchema` and the
// service's `videoRequestSchema`, so a form and a direct call get the same field errors.

const slug = z.string().min(1).max(100);
const text = z.string().max(5000);
/**
 * Form values arrive as strings; empty means "not chosen" (reported as a missing value by
 * the request validation, together with the other fields), anything else must be numeric.
 */
const formNumber = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.coerce.number().optional(),
);
/** An unchecked checkbox is absent; a checked one sends "on". */
const checkbox = z.preprocess((value) => value === "on" || value === true, z.boolean());

export const requestVideoInputSchema = z.strictObject({
  slug,
  title: text,
  // The creative brief (validated by `videoBriefSchema`, compiled into the prompt).
  objective: text,
  audience: text,
  description: text,
  platform: z.string().max(40),
  style: z.string().max(40),
  language: z.string().max(10),
  durationSeconds: formNumber,
  aspectRatio: z.string().max(10),
  resolution: z.string().max(10),
  audio: checkbox,
  tier: z.string().max(20),
});

export const videoJobInputSchema = z.strictObject({
  slug,
  jobId: z.string().min(1).max(100),
});

export const reviewVideoInputSchema = z.strictObject({
  slug,
  jobId: z.string().min(1).max(100),
  decision: z.enum(["accept", "reject"]),
});

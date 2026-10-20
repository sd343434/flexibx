// Next.js build ID for release builds. Pure and dependency-free (read by next.config.ts).

const COMMIT_SHA = /^[0-9a-f]{40}$/;

/**
 * The build ID of a release build: its commit (`GIT_SHA`, passed by the Dockerfile), so
 * two builds of one commit do not differ by a random ID (docs/runbooks/RELEASE_PIPELINE.md
 * § 4). The hex letters a–f are spelled g–l: Next.js keeps "ad" out of the build IDs it
 * generates (ad blockers block such asset URLs), and an ID without "a" or "d" cannot hold
 * it. Anything but a full commit SHA (local builds, `GIT_SHA=unknown`) returns null, which
 * keeps Next.js's random ID.
 */
export function buildIdFromCommit(sha: string | undefined): string | null {
  if (sha === undefined || !COMMIT_SHA.test(sha)) return null;
  return sha.replace(/[a-f]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 6));
}

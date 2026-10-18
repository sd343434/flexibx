import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Scratch directories of the media worker: one private directory per job run, removed
// when the run ends (success, failure, timeout or lost lease). A crash can leave one
// behind: `sweepStaleWorkDirs` removes this worker's directories older than a bound —
// never anything outside the prefix, never a directory a running job could still use
// (runs are far shorter than the bound). Pure (no `server-only`).

const PREFIX = "flexibx-creator-";
/** Longer than any job can run (job deadline), so a live run is never swept. */
export const STALE_WORK_DIR_MS = 6 * 3_600_000;

export async function createWorkDir(base: string = tmpdir()): Promise<string> {
  return mkdtemp(join(base, PREFIX));
}

export async function removeWorkDir(path: string): Promise<void> {
  if (!path.includes(PREFIX)) return;
  await rm(path, { recursive: true, force: true });
}

export async function sweepStaleWorkDirs(
  base: string = tmpdir(),
  now: number = Date.now(),
): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.startsWith(PREFIX)) continue;
    const path = join(base, entry);
    try {
      const info = await stat(path);
      if (info.isDirectory() && now - info.mtimeMs > STALE_WORK_DIR_MS) {
        await rm(path, { recursive: true, force: true });
        removed += 1;
      }
    } catch {
      // Removed meanwhile by its own run: nothing to do.
    }
  }
  return removed;
}

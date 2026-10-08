// Pure helper (no `server-only`): constant-shape response times for flows whose work
// differs between existing and unknown accounts.

/**
 * Responses to requests that must not reveal whether an account exists (sign-up,
 * password-reset request) take at least this long. It is above the slowest normal path
 * today and leaves room for a real email provider, which will make the "account
 * exists" branch slower. Better Auth pads verification resends the same way (500 ms).
 */
export const ENUMERATION_SAFE_MIN_DURATION_MS = 500;

/**
 * Runs `work` and resolves (or rejects) no earlier than `minimumMs` after it started,
 * so the time to answer does not depend on which branch the work took.
 */
export async function withMinimumDuration<T>(
  minimumMs: number,
  work: () => Promise<T>,
): Promise<T> {
  const started = Date.now();
  try {
    return await work();
  } finally {
    const remaining = minimumMs - (Date.now() - started);
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, remaining));
  }
}

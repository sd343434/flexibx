import type { PrismaClient } from "@/generated/prisma/client";
import { createAuth, type Auth, type AuthConfigInput } from "@/server/auth/auth-config";
import type { CredentialsDeps } from "@/server/auth/credentials";
import { createRateLimiter, type RateLimiter } from "@/server/auth/rate-limit";
import { MemoryMailer } from "@/server/mail/mailer";

// Builds the production auth configuration (createAuth) for integration tests, with an
// in-memory mailer, a recorded security-event list and the real limiter checkpoint.

export const TEST_BASE_URL = "http://localhost:3000";
/** Trusted client-IP header used by tests that need distinct clients. */
export const TEST_IP_HEADER = "x-test-client-ip";

export interface TestAuth {
  readonly auth: Auth;
  readonly mailer: MemoryMailer;
  readonly events: { action: string; userId: string }[];
  readonly limit: RateLimiter;
  readonly secret: string;
}

export function createTestAuth(
  system: PrismaClient,
  secret: string,
  overrides: Partial<AuthConfigInput> = {},
): TestAuth {
  const mailer = new MemoryMailer();
  const events: { action: string; userId: string }[] = [];
  const auth = createAuth({
    db: system,
    secret,
    baseURL: TEST_BASE_URL,
    appUrl: TEST_BASE_URL,
    isProduction: false,
    requireEmailVerification: false,
    mailer,
    onSecurityEvent: (action, userId) => {
      events.push({ action, userId });
      return Promise.resolve();
    },
    log: () => undefined,
    ...overrides,
  });
  const limit = createRateLimiter(auth, {
    secret,
    baseURL: overrides.baseURL ?? TEST_BASE_URL,
    ipHeader: overrides.ipHeader,
  });
  return { auth, mailer, events, limit, secret };
}

/** Credentials dependencies for a request with these headers. */
export function depsFor(test: TestAuth, headers: Headers = new Headers()): CredentialsDeps {
  return { limit: test.limit, headers };
}

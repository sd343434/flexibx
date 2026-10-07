import { hashPassword } from "better-auth/crypto";
import { z } from "zod";

import { AppError } from "../errors/app-error";
import { parseInput } from "../validation/parse";

import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, type Auth } from "./auth-config";

// Flexibx's email/password entry points. Better Auth's own sign-up/sign-in HTTP
// endpoints are disabled (DISABLED_HTTP_PATHS); these functions are the only way in and
// never reveal whether an email address is registered.

const emailSchema = z.string().trim().toLowerCase().max(254).pipe(z.email());

export const signUpInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: emailSchema,
  password: z.string().min(PASSWORD_MIN_LENGTH).max(PASSWORD_MAX_LENGTH),
});

export const signInInputSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export type SignUpInput = z.input<typeof signUpInputSchema>;
export type SignInInput = z.input<typeof signInInputSchema>;

/** The same result for a new account and an already-registered email. */
export interface SignUpResult {
  readonly status: "ACCEPTED";
}

export type SignInResult =
  | { readonly status: "SIGNED_IN"; readonly setCookie: readonly string[] }
  | { readonly status: "INVALID_CREDENTIALS" };

const EXISTING_USER_CODES = new Set([
  "USER_ALREADY_EXISTS",
  "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
]);

async function errorCode(response: Response): Promise<string | undefined> {
  try {
    const body = (await response.json()) as { code?: unknown };
    return typeof body.code === "string" ? body.code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Registers an account. Invalid input throws VALIDATION_FAILED (about the input only).
 * An existing email yields the same ACCEPTED result as a new one, after an equivalent
 * password hash so response time does not reveal the difference either.
 */
export async function signUpWithEmail(auth: Auth, input: SignUpInput): Promise<SignUpResult> {
  const body = parseInput(signUpInputSchema, input, "sign-up");

  const response = await auth.api.signUpEmail({ body, asResponse: true });
  if (response.ok) return { status: "ACCEPTED" };

  const code = await errorCode(response);
  if (code !== undefined && EXISTING_USER_CODES.has(code)) {
    await hashPassword(body.password);
    return { status: "ACCEPTED" };
  }
  throw new AppError("INTERNAL", {
    message: "Sign-up failed",
    metadata: { status: response.status, code: code ?? null },
  });
}

/**
 * Signs in. Every failure — malformed input, unknown email, wrong password — returns
 * the single INVALID_CREDENTIALS result. On success the caller forwards `setCookie`.
 */
export async function signInWithEmail(
  auth: Auth,
  input: SignInInput,
  headers: Headers,
): Promise<SignInResult> {
  const parsed = signInInputSchema.safeParse(input);
  if (!parsed.success) return { status: "INVALID_CREDENTIALS" };

  const response = await auth.api.signInEmail({ body: parsed.data, headers, asResponse: true });
  if (!response.ok) return { status: "INVALID_CREDENTIALS" };
  return { status: "SIGNED_IN", setCookie: response.headers.getSetCookie() };
}

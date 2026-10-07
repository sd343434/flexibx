import "server-only";

import { headers } from "next/headers";
import { z } from "zod";

import { withAction } from "../http/action-handler";

import { getAuth } from "./auth";
import {
  signInWithEmail,
  signOutCurrentSession,
  signUpInputSchema,
  signUpWithEmail,
} from "./credentials";

// Server actions behind the authentication pages. Session cookies are written (and
// cleared) by Better Auth's nextCookies() plugin; nothing here touches tokens. Next.js
// rejects cross-origin server action calls.

/** Registers an account. ACCEPTED for a new and an already-registered email alike. */
export const signUpAction = withAction({
  name: "auth.signUp",
  input: signUpInputSchema,
  handler: (input) => signUpWithEmail(getAuth(), input),
});

/**
 * Signs in. The schema only checks the shape; every content problem — malformed email,
 * unknown account, wrong password — comes back as the same INVALID_CREDENTIALS.
 */
export const signInAction = withAction({
  name: "auth.signIn",
  input: z.object({ email: z.string(), password: z.string() }),
  handler: async (input) => {
    const result = await signInWithEmail(getAuth(), input, new Headers(await headers()));
    return { status: result.status };
  },
});

/** Ends the current session: deletes it in the database and expires the cookie. */
export const signOutAction = withAction({
  name: "auth.signOut",
  input: z.object({}),
  handler: async () => {
    await signOutCurrentSession(getAuth(), new Headers(await headers()));
    return { status: "SIGNED_OUT" as const };
  },
});

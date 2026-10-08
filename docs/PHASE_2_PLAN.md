# Phase 2 execution plan — authentication and runtime multi-tenancy

> **This is the canonical Phase 2 execution plan.** It is the source of truth for future
> Claude implementation prompts. Phase 2 was planned as **12 steps**; by human instruction
> they were executed as **9 implementation steps** (mapping in §1). All planned scope is
> implemented; Phase 2 awaits the **human completion review** (C9).
>
> - Any change to this plan (scope, order, decisions) requires explicit human approval.
> - Updating this document never starts implementation. Each step begins only after an
>   explicit human instruction for that step, and ends with a report and a human review
>   before anything is committed or pushed.
> - The open questions C1–C9 were decided by a human review (§6) and are binding. Any new
>   open question must be marked **NEEDS HUMAN CONFIRMATION** and decided by a human
>   before the step that depends on it starts; implementers must not guess.

Related documents: [`ARCHITECTURE.md`](ARCHITECTURE.md) (current system and rules),
[`PHASE_COMPLETION_PROTOCOL.md`](PHASE_COMPLETION_PROTOCOL.md) (`.phase-status.json`).

## 1. Status

| Step | Title                                          | Status                                                                              |
| ---- | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1    | Better Auth integration spike                  | Done — integration spike completed before Step 2; temporary spike artifacts removed |
| 2    | Better Auth foundation                         | Complete — `8727e38`                                                                |
| 3    | Runtime auth and workspace access              | Complete — `82fd5ab` (status `02f9530`)                                             |
| 4    | Workspace creation and workspace selection     | Complete — `194e4f5`                                                                |
| 5    | Authentication UI (sign-up, sign-in, sign-out) | Complete — `0328856`                                                                |
| 6    | Workspace app shell and switching              | Complete — `8eaaf4a`                                                                |
| 7    | Member management                              | Complete — `f12cea0` (executed Step 7, together with plan Steps 8–9)                |
| 8    | Mailer abstraction                             | Complete — `f12cea0` (executed Step 7)                                              |
| 9    | Invitations                                    | Complete — `f12cea0` (executed Step 7)                                              |
| 10   | Email verification and password reset          | Complete — `d9a5bbd` (executed Step 8, together with plan Step 11)                  |
| 11   | Authentication rate limiting                   | Complete — `d9a5bbd` (executed Step 8); limits approved as a human decision         |
| 12   | Phase 2 hardening and completion               | Executed Step 9 — implemented, awaiting human review (not committed yet)            |

Executed steps (human instructions) → plan steps: 1–6 → 1–6; 7 → 7, 8, 9; 8 → 10, 11;
9 → 12. The plan's scope, decisions and step definitions below are unchanged.

`.phase-status.json`: phase 2, `IN_PROGRESS`, interim range
`228701e…` (end of Phase 1) `..d9a5bbd…` (executed Step 8). `READY_FOR_REVIEW` and
`COMPLETED` are set only after the human approvals required by C9.

## 2. Scope

**In scope (approved):** sign-up, sign-in, sign-out; workspace creation; workspace URLs
`/{locale}/w/{slug}`; membership switching; member management; invitations;
authentication rate limiting; Arabic and English with RTL/LTR; runtime multi-tenancy;
server-side authorization; session management; protected routes and actions.

**Out of scope (approved):** OAuth (Google deferred); 2FA and passkeys; platform admin;
billing; brand/content functionality; account deletion; PostgreSQL RLS; AGENCY/client
workspaces (deferred to Phase 14); ownership transfer; a session list/revoke UI; a real
production email provider.

## 3. Approved decisions (fixed for all steps)

1. **Better Auth `1.7.7` exactly** — the only new authentication library.
2. **Email:** a mailer abstraction with a development transport; no real SMTP/provider
   dependency yet; email verification must not block development.
3. **OAuth:** Google OAuth deferred (not in Phase 2).
4. **Invitations:** random token stored **hashed only**; single use; 7-day expiry; the
   accepting account's email must match the invited email; **no OWNER invitations**.
5. **Sessions:** database sessions; 7-day lifetime, rolling; cookie cache disabled;
   sign-out invalidates the session; password change/reset invalidates the other sessions.
6. **IDs:** PostgreSQL-generated UUIDs; Better Auth runs with `generateId: false`
   (verified in Step 1).
7. **Session tokens:** Better Auth stores the raw token in `sessions.token` (accepted).
   Controls: application code never reads session tokens; `AUTH_SECRET` is separate from
   database credentials; rotating it invalidates cookies; no tokens in logs; no custom
   adapter.
8. **Rate limiting:** never trust `X-Forwarded-For` blindly; client IP comes from an
   explicitly configured trusted source (`AUTH_IP_HEADER` / `AUTH_TRUSTED_PROXIES`).
9. **Email enumeration:** generic responses wherever an account's existence could leak.
10. **Last workspace:** a non-sensitive cookie may remember it; server-side membership
    validation on every use; never a security reference.
11. **Agency/client workspaces:** deferred from Phase 2 (to Phase 14, C2).

Additional decisions approved during Steps 2–3 (already implemented):

- `AUTH_SECRET` is validated on first auth use (lazy), not at boot.
- `autoSignIn: false` after sign-up (needed for decision 9).
- `requireEmailVerification: false` for now.
- Rate limiting is disabled in code until Step 11 (documented known gap).
- Better Auth's email/password sign-up/sign-in HTTP endpoints are disabled; Flexibx
  server code (`server/auth/credentials.ts`) is the only entry point.
- Interim AI reviews are possible for an `IN_PROGRESS` phase; `APPROVE_NEXT_PHASE` is
  rejected for it. The OpenAI reviewer is not used in this workflow; the Phase 2
  completion review is human only (C9).

The human decisions C1–C9 (§6) are part of these approved decisions.

## 4. Steps

Each step lists: objective, scope, security requirements, tests / definition of done,
explicitly out of scope, and dependencies. "Done" for every step also means:
`pnpm test`, `pnpm test:integration`, `pnpm typecheck`, `pnpm lint`,
`pnpm format:check`, `pnpm build`, `pnpm phase:validate`, `pnpm db:validate` and
`git diff --check` all pass, existing tests are not weakened or skipped, and a report is
delivered before any commit.

---

### Step 1 — Better Auth integration spike _(done — completed before Step 2; temporary spike artifacts removed)_

- **Objective:** prove Better Auth 1.7.7 works with this stack before committing to it.
- **Scope (done):** Prisma 7 adapter via the system client, real PostgreSQL, existing
  `users` table, Postgres UUIDs with `generateId: false`, DB sessions, scrypt password
  hashing, sign-up/sign-in/sign-out, session expiry and revocation, cookie attributes,
  origin checking; security findings (raw token storage, test-mode origin-check default,
  sign-up enumeration, IP header trust) documented and decided.
- **Security:** findings 5–9 in §3 originate here.
- **Tests / DoD:** spike integration test (9 cases) passed before Step 2 started. The
  temporary spike artifacts (test file and temporary schema models) were removed; the
  findings fed the Step 2 implementation.
- **Out of scope:** any production code or migration.
- **Dependencies:** Phase 1.

### Step 2 — Better Auth foundation _(complete — `8727e38`)_

- **Objective:** production auth layer and schema, with no UI.
- **Scope (done):** `sessions` / `accounts` / `verifications` models and migration
  `20261007103240_auth_tables` (additive only); `server/auth/auth-config.ts`
  (`createAuth`), `server/auth/auth.ts` (`getAuth`), `server/auth/credentials.ts`
  (enumeration-safe `signUpWithEmail` / `signInWithEmail`); `/api/auth/[...all]` handler
  with sign-up/sign-in disabled over HTTP; `authEnvSchema` (`AUTH_SECRET`,
  `AUTH_IP_HEADER`, `AUTH_TRUSTED_PROXIES`); tenant guard blocks auth tables on the
  application client; Better Auth logs reduced to redacted message text.
- **Security:** explicit `disableOriginCheck: false`; secure cookies in production/https;
  `isPlatformAdmin`/`locale` not settable from input; no client IP trusted by default.
- **Tests / DoD:** auth integration tests (24 + 3 route tests), config and boundary unit
  tests; `next build` and a real-server HTTP check.
- **Out of scope:** UI, workspace access, mailer, rate limiting.
- **Dependencies:** Step 1.

### Step 3 — Runtime auth and workspace access _(complete — `82fd5ab`)_

- **Objective:** server-side primitives every later step uses.
- **Scope (done):** `server/auth/session.ts` (`getCurrentUser`, `requireUser`,
  `AuthUser`); `server/tenancy/access.ts` (`requireWorkspaceAccess(slug, action?)` — the
  only producer of `TenantContext`, built from the membership row);
  `server/http/route-handler.ts` same-origin check for cookie-bearing mutations;
  `server/http/action-handler.ts` (`withAction`); `server/auth/safe-redirect.ts`
  (`safeNextPath`); rolling-session fix: `nextCookies()` plugin plus proxy-side session
  cookie renewal (`server/auth/session-refresh.ts`).
- **Security:** unknown/foreign/deleted/malformed workspace → identical `NOT_FOUND`;
  client-supplied ids/roles ignored; static tests keep `createTenantContext`, Better Auth
  imports and the system client inside their boundaries.
- **Tests / DoD:** 461 unit + 80 integration tests at completion (`workspace-access`,
  `session-refresh` suites, mutation-checked); real-server check of cookie renewal.
- **Out of scope:** pages, UI, workspace creation.
- **Dependencies:** Step 2.

---

### Step 4 — Workspace creation and workspace selection _(complete — `194e4f5`)_

- **Objective:** a signed-in user can create a workspace and reach the workspaces they
  belong to. Workspace creation is the precondition for every workspace-scoped page.
- **Scope:**
  - `createWorkspace` service (name, slug, default locale): creates the workspace, the
    creator's `OWNER` membership and a `workspace.created` audit entry in one
    transaction; slug validation identical to the DB `CHECK`; slug conflicts reported as
    a field error.
  - Server actions via `withAction` that authorize from `requireUser()` only.
  - `/{locale}/workspaces` (list of the user's memberships via the reviewed system path;
    zero → redirect to new; exactly one → redirect into it) and
    `/{locale}/workspaces/new`.
  - Minimal localized pages (ar/en, RTL/LTR) — no app shell yet.
  - **Who may create (C1):** any authenticated user. Email verification is **not**
    required for workspace creation in Phase 2 (verification policy belongs to Step 10).
  - **Workspace type (C2):** `BUSINESS` only. The type is set by the server, never taken
    from input; `AGENCY`/client workspaces are deferred to Phase 14.
- **Security:** creator always becomes `OWNER`; no client-supplied owner, role or type
  (type is always `BUSINESS`); unauthenticated → sign-in redirect (target page arrives in Step 5;
  until then `UNAUTHENTICATED`); `no-store` on authenticated pages.
- **Tests / DoD:** integration — creation is atomic (workspace + OWNER + audit), slug
  rules and conflicts, unauthenticated rejection, an unverified user can create, a
  client-supplied type is ignored or rejected, the list shows only the user's own
  non-deleted memberships, redirect rules for zero/one/many; unit — input schemas.
- **Explicitly out of scope:** sign-in UI, app shell, switcher, members, invitations,
  `AGENCY`/client creation (Phase 14), workspace settings/editing.
- **Dependencies:** Steps 2–3.
- **As implemented (approved):** `/{locale}/w/{workspaceSlug}` exists as a minimal
  Step 4 bridge/landing page — the redirect target after creation and for a single
  membership — authorized through `requireWorkspaceAccess`. Step 6 replaces it with the
  workspace layout, home page and shell.

### Step 5 — Authentication UI (sign-up, sign-in, sign-out) _(next)_

- **Objective:** users can register, sign in and sign out through localized pages.
- **Scope:**
  - `/{locale}/sign-up`, `/{locale}/sign-in` pages and server actions calling
    `signUpWithEmail` / `signInWithEmail`; sign-out action; cookies written through
    `nextCookies()`.
  - After sign-in: `safeNextPath(next)` or `/{locale}/workspaces`. Signed-in users visiting
    auth pages are redirected away.
  - Generic results: sign-up always "accepted" (no auto sign-in); sign-in failures
    one generic message.
  - New `auth` message namespace (ar/en), RTL/LTR forms, email/password inputs `dir="ltr"`,
    Better Auth error codes mapped to Flexibx message keys (no library text shown).
- **Security:** no email enumeration on any path; open-redirect protection via
  `safeNextPath`; server actions rely on Next's origin check; passwords never logged;
  sign-out deletes the DB session and clears the cookie.
- **Tests / DoD:** integration for the actions (generic results, cookie set/cleared,
  redirect sanitizing); unit for message-key mapping and ar/en key parity; e2e (Playwright)
  sign-up → sign-in → sign-out in `/ar` (RTL) and `/en` (LTR).
- **Explicitly out of scope:** email verification, password reset, OAuth, 2FA,
  account deletion.
- **Dependencies:** Steps 2–4 (post-sign-in landing is `/workspaces`).

### Step 6 — Workspace app shell and switching

- **Objective:** an authenticated, workspace-scoped area at `/{locale}/w/{slug}` and the
  ability to switch between memberships.
- **Scope:**
  - `/{locale}/w/[workspaceSlug]` layout + home page; **every** page and action calls
    `requireWorkspaceAccess` (layouts are not re-run on client navigation).
  - Minimal shell: workspace name, workspace switcher (user's memberships), user menu
    with sign-out.
  - Last-workspace cookie (non-sensitive slug only), validated against memberships on
    every use; used by `/workspaces` to pick a default.
  - `NOT_FOUND` page for foreign/unknown slugs; `no-store` responses.
- **Security:** decision 10 — the cookie is never trusted; switching is plain navigation to
  another slug with full server-side checks; no workspace identity in client state.
- **Tests / DoD:** integration — last-workspace cookie ignored when invalid or foreign;
  e2e — unauthenticated `/w/x` → sign-in with safe `next`; foreign slug → 404; switching
  between two workspaces; RTL/LTR; back button after sign-out shows no workspace data.
- **Explicitly out of scope:** product navigation for later phases, workspace settings
  beyond what Step 7 needs, agency/client views.
- **Dependencies:** Steps 3–5.

### Step 7 — Member management

- **Objective:** workspace admins can see and manage existing members.
- **Scope:**
  - Members page under `/{locale}/w/{slug}/…`; list (`member.view`), change role
    (`member.updateRole`), remove (`member.remove`).
  - Rules: `canAssignRole` (only OWNER grants OWNER; ADMIN grants non-owner roles); the
    last OWNER can be neither removed nor demoted (checked inside a transaction); no
    self role change; every change audited (`member.role_changed`, `member.removed`)
    in the same transaction.
  - **Leave workspace (C5):** any member, including a non-last OWNER, may leave; the
    **last OWNER cannot leave or remove themselves**. Same transaction and audit rules.
- **Security:** all writes through the guarded client with `TenantContext`; targets are
  resolved inside the context's workspace (foreign member ids → `NOT_FOUND`); no member
  data (e.g. `isPlatformAdmin`, sessions) beyond what the page needs.
- **Tests / DoD:** integration — permission matrix per role, last-owner protection
  (including concurrent attempts), leaving (non-last owner and members allowed, last
  owner refused), cross-workspace member ids rejected, audit entries; e2e — role change,
  removal and leaving.
- **Explicitly out of scope:** adding members (Step 9 via invitations); **ownership
  transfer** (deferred, C5).
- **Dependencies:** Steps 3, 6.

### Step 8 — Mailer abstraction

- **Objective:** one server-side interface for sending email, used by Steps 9–10.
- **Scope:**
  - `Mailer` interface (`send({ to, template, locale, data })`) with a development
    transport (writes a redacted record of the message for local use) and a test transport
    (captures messages in memory).
  - Localized templates (ar/en) for the Phase 2 emails: invitation, email verification,
    password reset. Template data is escaped; links are built from `APP_URL` only.
  - **Production without a provider (C3):** no real provider is required in Phase 2.
    In production, an email-dependent operation with no configured provider must **fail
    safely and explicitly** (a clear error, nothing reported as sent). The development
    and test transports are never used in production, and the system never pretends an
    email was sent. Documented here; implemented in this step.
- **Security:** no tokens or links in production logs; the dev transport must never be
  selectable in production silently; no new dependency (decision 2).
- **Tests / DoD:** unit — transport selection per environment, production without a
  provider fails explicitly (no dev/test transport fallback, no "sent" result), template
  rendering per locale, escaping, link origin; no network calls.
- **Explicitly out of scope:** real SMTP/provider integration, marketing email.
- **Dependencies:** none functionally (only the env/config conventions); placed before
  Step 9, its first consumer.

### Step 9 — Invitations

- **Objective:** admins invite people by email; invitees join the workspace.
- **Scope:**
  - `workspace_invitations` table (tenant-owned, registered in the tenant guard and in
    `TENANT_ROOT_RELATIONS`): email (citext), role, `token_hash` (SHA-256), inviter,
    `expires_at`, `accepted_at`, `revoked_at`; partial unique index on pending
    `(workspace_id, email)`; `CHECK role <> 'OWNER'`.
  - Create / list / revoke (`member.invite`), resend; email via the Step 8 mailer.
  - Accept page `/{locale}/invite/[token]`: requires sign-in with the **same email**;
    creates the membership and marks the invitation used in one transaction; audit
    entries (`member.invited`, `invitation.accepted`).
  - **Manual sharing (C4):** the invitation link may also be copied and shared manually,
    in addition to email delivery. The plaintext token exists only in that link (shown
    once at creation/resend) and is never stored or logged; all security rules below
    still apply.
- **Security (decision 4):** random token, stored hashed only; single use; 7-day expiry;
  email match; no OWNER invitations; invalid/expired/used tokens all look identical; the
  inviter can only invite to roles they may assign (`canAssignRole`).
- **Tests / DoD:** integration — hash-only storage, expiry, single use (including
  concurrent accepts), email mismatch, revoked, OWNER rejected, role ceiling, cross-
  workspace isolation, audit; e2e — invite → sign up/in → accept → workspace visible.
- **Explicitly out of scope:** bulk invites, domain-based auto-join, agency/client
  invitations.
- **Dependencies:** Steps 6–8 (and Step 5 for the sign-in redirect on accept).

### Step 10 — Email verification and password reset

- **Objective:** complete the account lifecycle that depends on email.
- **Scope:**
  - Better Auth `sendVerificationEmail` / `sendResetPassword` wired to the Step 8 mailer.
  - Pages: request reset, reset password, verify email (ar/en, RTL/LTR).
  - Reset invalidates the other sessions (already configured:
    `revokeSessionsOnPasswordReset`); signed-in password change with
    `revokeOtherSessions`.
  - **Verification policy (C6):** in production, email verification is **required** for
    operations that need a verified account; development and test stay usable without
    verification. The policy is configuration/environment driven, so environments
    remain distinguishable (not a hardcoded switch). The exact enforcement points are
    defined in this step.
    **As implemented (human decision, Step 9):** sign-in and workspace creation never
    require a verified email, in production too (C1 unchanged). The policy applies only
    to verified-only operations; in Phase 2 that is accepting (and previewing) an
    invitation, because the invited address is its only proof of identity (C4).
  - **Sessions (C7):** no session-management UI (session list/revoke is deferred). This
    step must guarantee: sign-out invalidates the current session; password change and
    reset invalidate the other sessions.
- **Security:** generic "if the account exists, we sent an email" responses (decision 9);
  single-use, short-lived tokens; no tokens in logs; reset links built from `APP_URL`.
- **Tests / DoD:** integration — generic responses for known/unknown emails, token
  single use and expiry, other sessions revoked after reset/change; e2e — reset flow with
  the test transport.
- **Explicitly out of scope:** account deletion, email change, OAuth, 2FA, a session
  list/revoke UI (C7).
- **Dependencies:** Steps 5 and 8.

### Step 11 — Authentication rate limiting

- **Objective:** limit brute force and abuse on authentication entry points.
- **Scope:**
  - Trusted client-IP abstraction built on `AUTH_IP_HEADER` / `AUTH_TRUSTED_PROXIES`
    (decision 8); no IP available → a documented fallback key, never a spoofable header.
  - Limits on sign-in, sign-up, password-reset request, verification resend and
    invitation acceptance (Flexibx server actions and Better Auth endpoints), keyed by
    trusted IP and, where useful, normalized email.
  - **Limiter (C8):** Better Auth's built-in limiter — no parallel rate-limit system —
    fed only by the trusted client-IP abstraction; `X-Forwarded-For` is never trusted
    blindly. Storage: database (no Redis in Phase 2), with a `rate_limits` table and
    migration if Better Auth's database storage needs one.
  - **Concrete limits** per endpoint are **not** fixed by this plan: they are defined and
    reviewed by a human as the first part of Step 11, before implementation.
  - Coverage check (first part of Step 11): Flexibx's sign-in/sign-up run through
    server-side `auth.api` calls rather than Better Auth's HTTP router. The step must
    verify that Better Auth's limiter applies to those calls (and to invitation
    acceptance, which is Flexibx code). Any entry point it cannot cover goes back to
    human review — **NEEDS HUMAN CONFIRMATION** if a gap is found — rather than being
    solved with a parallel limiter.
- **Security:** `RATE_LIMITED` responses do not reveal whether an account exists;
  limiter keys contain no raw IP/email in logs.
- **Tests / DoD:** integration — limits trigger and reset, spoofed `X-Forwarded-For` is
  ignored without a configured trusted source, configured trusted header is used,
  generic responses under limit; unit — IP resolution.
- **Explicitly out of scope:** API/AI rate limiting (Phase 6), Redis.
- **Dependencies:** Steps 5, 9, 10 (all limited entry points exist).

### Step 12 — Phase 2 hardening and completion

- **Objective:** verify Phase 2 end to end and hand it to human review.
- **Scope:**
  - Full e2e suite across Steps 4–11 in `/ar` and `/en`; cross-tenant e2e; session
    expiry/revocation e2e.
  - Security pass: CSRF/origin, open redirects, enumeration, logs (no tokens/IPs/
    passwords), tenant guard coverage of new tables, `no-store` on authenticated pages.
  - Documentation: `ARCHITECTURE.md` updated to describe Phase 2 as built; README setup
    for auth env vars.
  - `.phase-status.json` → `READY_FOR_REVIEW` (only after human approval) with the real
    results and the range `228701e…..<final head>`; `COMPLETED` only after a further
    human approval.
  - **Review (C9):** the Phase 2 completion review is **human only**; the OpenAI
    reviewer is not used. Human approval is required before the phase is marked
    `READY_FOR_REVIEW`, and again before `COMPLETED`.
- **Security:** no new features; only fixes found by the pass.
- **Tests / DoD:** all quality gates green locally (and in CI once pushed);
  `pnpm phase:validate` VALID as `READY_FOR_REVIEW`; human approvals recorded for
  `READY_FOR_REVIEW` and for `COMPLETED`.
- **Explicitly out of scope:** anything not in §2.
- **Dependencies:** Steps 1–11.
- **As executed (Step 9):** session expiry is verified by integration tests (expired
  sessions rejected; the real proxy clears an expired session's cookie) rather than e2e:
  the e2e suite has no database access, and expiring a browser session there would need
  clock manipulation or new test infrastructure (deferred). Revocation is covered e2e
  (password reset and change sign out other browsers).

## 5. Why this order

1. **Foundation before use (1 → 3):** library proven, then auth layer, then the runtime
   primitives (`requireUser`, `requireWorkspaceAccess`, `withAction`) every page needs.
2. **Workspace creation (4) before the shell (6):** a workspace URL needs a workspace;
   `/workspaces` is also where sign-in lands.
3. **Auth UI (5) after creation (4):** the post-sign-in destination exists; both depend
   only on Steps 2–3.
4. **Shell and switching (6) before members (7):** member pages live inside the shell.
5. **Members (7) before invitations (9):** invitations create memberships and reuse the
   role rules (`canAssignRole`, last-owner) established in Step 7.
6. **Mailer (8) before its consumers (9, 10).**
7. **Invitations (9) before verification/reset (10):** both need the mailer; invitations
   carry the core multi-user value, and verification/reset complete the lifecycle.
8. **Rate limiting (11) after every limited entry point exists (5, 9, 10).**
9. **Hardening (12) last:** end-to-end verification and phase completion.

## 6. Human decisions on the former open items (approved)

| ID  | Decision                                                                                                                                                                                                                                                      | Applies to |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| C1  | Any authenticated user may create a workspace. Email verification is not required for workspace creation in Phase 2; verification policy is handled in Step 10.                                                                                               | Step 4     |
| C2  | Phase 2 workspace creation supports `BUSINESS` workspaces only. `AGENCY`/client workspaces are deferred to Phase 14.                                                                                                                                          | Step 4     |
| C3  | No real production email provider in Phase 2. The mailer supports development/test transports. Production email flows never silently use a development transport or pretend an email was sent; without a configured provider they fail safely and explicitly. | Step 8     |
| C4  | Invitation links may be copied/shared manually in addition to email delivery. All invitation security rules remain (hashed token, single use, 7-day expiry, invited email must match, no OWNER invitations).                                                  | Step 9     |
| C5  | Ownership transfer is deferred. A non-last owner or a member may leave the workspace under the Step 7 rules; the last OWNER cannot leave or remove themselves.                                                                                                | Step 7     |
| C6  | Email verification becomes required in production for operations that need a verified account; development/test remain usable without blocking verification. The policy is configuration/environment driven. Enforcement points are defined in Step 10.       | Step 10    |
| C7  | No session-management UI in Phase 2 (session list/revoke deferred). Sign-out invalidates the current session; password change/reset invalidates the other sessions.                                                                                           | Step 10    |
| C8  | Use Better Auth's limiter, not a parallel system, behind the trusted-client-IP abstraction; never trust `X-Forwarded-For` blindly. Concrete limits are defined and reviewed in Step 11 before implementation.                                                 | Step 11    |
| C9  | The Phase 2 completion review is human only; the OpenAI reviewer is not used. Human approval is required before Phase 2 is marked `READY_FOR_REVIEW` or `COMPLETED`.                                                                                          | Step 12    |

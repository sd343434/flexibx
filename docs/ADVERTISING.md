# Advertising platforms

Flexibx connects a workspace to its advertising accounts, reads campaigns and results,
proposes new campaigns with AI, creates them (paused) and activates them only through the
approval workflow, and sends WhatsApp messages to opted-in contacts, one approved message
at a time.
This document describes what exists, how a new platform plugs in, and what each platform
requires. Status as of 2026-10-10.

## What works today (implemented and tested)

| Capability                                    | Meta (Facebook & Instagram)                                                                                                    | Snapchat                                                                                                                            | TikTok                                                                                                                            | WhatsApp Business                                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Connect (official OAuth)                      | ✅ implemented, tested against a deterministic Graph stand-in; **not yet exercised against real Meta** (needs app credentials) | ✅ implemented, tested against a deterministic Snap stand-in; **not yet exercised against real Snap** (needs OAuth app credentials) | ✅ implemented, tested against a deterministic TikTok stand-in; **not yet exercised against real TikTok** (needs app credentials) | ❌ not implemented                                                                                  |
| Encrypted token storage & lifecycle           | ✅                                                                                                                             | ✅ refresh token stored encrypted; access token minted per use                                                                      | ✅ long-term token stored encrypted (no expiry)                                                                                   | —                                                                                                   |
| Ad account discovery & selection              | ✅                                                                                                                             | ✅ (organizations → ad accounts)                                                                                                    | ✅ (authorized advertisers → details)                                                                                             | —                                                                                                   |
| Read campaigns, ad sets, ads, 30-day insights | ✅ read-only                                                                                                                   | ✅ read-only (campaigns, ad squads, ads, campaign totals; clicks = swipe-ups)                                                       | ✅ read-only (campaigns, ad groups, ads, basic report)                                                                            | —                                                                                                   |
| AI campaign planner + review screen           | ✅ (fake AI provider in tests)                                                                                                 | ✅ shared planner; placement is automatic only                                                                                      | ✅ shared planner; placement is automatic only                                                                                    | —                                                                                                   |
| Create campaigns (paused) / activate          | ⚠️ **implemented, off by default** (`ADS_EXECUTION_ENABLED`); tested only against a stand-in — **never against real Meta**     | ❌ **blocked** — writer boundary not ready (profile id, update semantics unverified)                                                | ❌ **blocked** — writer boundary not ready (identity, ad fields, status update unverified)                                        | —                                                                                                   |
| Send messages                                 | —                                                                                                                              | —                                                                                                                                   | —                                                                                                                                 | ⚠️ **implemented, off by default** (`WHATSAPP_SENDING_ENABLED`); stand-in only, never sent for real |
| Optimization recommendations                  | ✅ from historical results (suggestions only)                                                                                  | ✅ same (from synced results)                                                                                                       | ✅ same                                                                                                                           | —                                                                                                   |

Everything marked unavailable is shown as unavailable in the UI, never as working.

## Architecture

```
UI (/{locale}/w/{slug}/ads, /ads/plans/{id})        Autopilot (approvals)
        │ server actions (strict input, membership, permission)
        ▼
src/server/ads/
  connections.ts   OAuth start/callback, token access, accounts, sync, disconnect
  planner.ts       AI proposal (shared AI engine, AD_PLAN), edit, review, submit
  planner-math.ts  deterministic money, dates and estimates (pure)
  model.ts         the unified advertising model (pure)
  adapter.ts       the platform contract (pure types)
  token-vault.ts   AES-256-GCM token encryption (pure)
  registry.ts      which platforms this deployment can use
  adapters/meta.ts the Meta Graph / Marketing API adapter
  adapters/snapchat.ts the Snap Marketing API (Ads API v1) adapter
  adapters/tiktok.ts the TikTok API for Business (Marketing API v1.3) adapter
  oauth-callback.ts the shared /api/integrations/{platform}/callback handler
        │
        ▼
src/server/orchestration/workflows/ad-launch.ts  validate → launch (SPEND) → report
```

Rules later work must keep:

- **The adapter is the only place a platform's API exists.** URLs, field names, error
  codes, pagination and objective/placement mappings stay in `adapters/<platform>.ts`.
  Everything above speaks the unified model (`model.ts`): money is integer minor units +
  ISO 4217, statuses and objectives are unified enums.
- **Capabilities are explicit.** `AdPlatformAdapter.capabilities` says what an adapter can
  do; callers check it and show the rest as unavailable. `launchCampaign` exists only on
  an adapter with a real, tested write path.
- **Writes only through approvals.** The `ad_launch` workflow's `launch` task is `SPEND`.
  Its `describe` returns every external call (`adapter.describeLaunch`) plus the total
  amount; the engine stores that snapshot, a person approves exactly it, the engine
  re-describes before running (plan version, account, connection version, budget, dates
  and calls are all in the hash) and runs it once. A failed launch is never retried
  automatically. The emergency stop overrides everything. The orchestration engine knows
  nothing about advertising.
- **Tokens.** Stored only as `v1.<iv>.<tag>.<ciphertext>` (AES-256-GCM, key
  `ENCRYPTION_KEY`), bound by additional authenticated data to workspace + platform: a
  ciphertext copied elsewhere does not decrypt. Decrypted only inside
  `withPlatformToken` for the duration of a call. Never logged, audited, rendered or
  returned. Expired/rejected tokens update the connection status (`EXPIRED`, `ERROR`).
  Rotating `ENCRYPTION_KEY` makes stored tokens unreadable (connections show
  "reconnect"); no re-encryption job exists yet. An adapter declares what is stored
  (`credential`): the access token (Meta) or a refresh token (Snapchat), from which
  `withPlatformToken` mints a short-lived access token per call through
  `refreshAccessToken` — the access token is never stored; a rotated refresh token
  replaces the stored one (compare-and-set on the old ciphertext).
- **OAuth state.** 32 random bytes, only the SHA-256 stored, 10-minute TTL, single use
  (atomic consume), bound to the person, workspace **and platform** that started it (a
  state arriving at another platform's callback is refused); the callback re-checks that
  the person still holds `ads.manage`. At most 10 pending states per workspace.
- **Placements.** `PLATFORM_PLACEMENTS` (model.ts) lists what each platform can express;
  the planner keeps only those (none left → `AUTOMATIC`), and the AI is told them.
- **Permissions.** `ads.view` and `ads.plan` (managers and above), `ads.manage`
  (owners/admins: connect, select accounts, disconnect), submitting a launch also needs
  `automation.manage`; approving needs `automation.approve`.
- **AI.** The planner uses the shared AI engine (`AD_PLAN` operation: daily cap, usage
  record, audit, schema validation). The model proposes objective, audience, placements
  and creative and may cite an image handle (M1…M9); it never sees ids or tokens and
  never decides money. Expected results are computed from the account's own last-30-day
  results (≥ 5,000 impressions) as a ±30 % range with its basis, or not shown at all.

Execution tables (migration `20261010160000_ad_execution_messaging`, not applied):
`ad_execution_steps`, `ad_spend_limits`, `whatsapp_contacts`, `whatsapp_messages`, plus
identity/activation columns on `ad_plans`.

Tables (migration `20261010140000_advertising_core`, not yet applied anywhere):
`ad_oauth_states`, `ad_connections`, `ad_accounts` (with the last read-only snapshot),
`ad_plans`; plus `AD_PLAN` in `ai_operation`.

## Execution: creating, activating and recovering campaigns

```
propose (AI planner) → validate and show (review) → owner/admin approves the exact action
→ executor re-checks the snapshot → executes and records → monitors (reconcile)
```

- **Shared executor** (`src/server/ads/execution.ts`), the only code that writes to an ad
  platform, always inside an approved orchestration task: `ad_launch` (create, SPEND) and
  `ad_activate` (turn on, SPEND). Each platform contributes an `AdWriter`
  (`adapters/meta-writer.ts`; `adapters/blocked-writers.ts` for Snapchat and TikTok).
- **Before any external call** (`execution-preflight.ts`, at submission and again in the
  task): the person still holds `ads.plan` + `automation.manage`; the platform has a ready
  writer that supports the objective and the account currency; `ADS_EXECUTION_ENABLED` is
  `true`; the plan has an https destination; the connection is ACTIVE and holds the
  writer's permissions; the budget is within the workspace's **spending limits** for its
  currency (plan total and average daily, `ad_spend_limits`, owners/admins). The engine
  then re-describes the action (plan version, identity, destination, media, every call,
  amount, connection version) — any change needs a new approval — and checks the
  emergency stop.
- **Creation is always PAUSED** (image → campaign → ad set → creative → ad). Every step is
  written to the ledger (`ad_execution_steps`) as `IN_FLIGHT` before it is sent and
  `SUCCEEDED` (with the external id) / `FAILED` / `UNCERTAIN` after. Resubmitting (new
  approval) reuses SUCCEEDED steps: nothing is created twice.
- **Unknown outcomes are never retried blindly.** A network failure, a 5xx or an
  unreadable answer to a write is `UNCERTAIN`; the next attempt first looks the object up
  by the plan's tag (`fx-<12 hex>` in every object name). Found → reused (`ads.step_reconciled`);
  proven absent → written once more; lookup fails → stops with `ads_outcome_unknown`.
  The engine never repeats a SPEND task by itself, and a task interrupted mid-flight is
  marked `outcome_unknown` by recovery.
- **Activation** is a separate request (`requestActivation`) and a separate approval
  (`activate_ad_campaign`, with the ids and the budget). It reads the platform first when a
  previous activation's outcome is unknown. The plan records `activationStatus`
  (REQUESTED/ACTIVE/UNCERTAIN/FAILED) and the platform's `externalStatus` (reconciled).
  ACTIVE means Meta accepted the status change; whether the campaign delivers is shown
  by `externalStatus` (e.g. PENDING_REVIEW). If the writes were accepted but the status
  cannot be read back, the activation is UNCERTAIN (`ads_outcome_unknown`), never FAILED,
  and the next approved attempt reads the platform before writing anything.
- **A plan with objects on the platform can no longer be edited** (`ads_external_objects_exist`)
  and keeps the identity (Page) it was created with.
- **No standing auto-approval:** every creation, activation and budget change is a new run
  with its own approval; recommendations (below) never execute anything.

### Meta write path — status as of 2026-10-11

**Never exercised against Meta.** Every statement below is about request construction and
Flexibx's own safety logic, tested only against a deterministic stand-in. Status per item
(Documented = found in Meta's official documentation; Assumption = not verifiable here,
with the fail-safe that applies; Refused = rejected before any external call):

| Item                   | What Flexibx does                                                                                                                                                                                                                                                                                                                                                                                                                   | Status                                                                                                                                                                                                            |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API version            | Graph/Marketing API `v26.0` (`META_GRAPH_VERSION`)                                                                                                                                                                                                                                                                                                                                                                                  | Documented: latest version, released 2026-07-29                                                                                                                                                                   |
| Objectives             | AWARENESS → OUTCOME_AWARENESS/REACH; TRAFFIC → OUTCOME_TRAFFIC/LINK_CLICKS                                                                                                                                                                                                                                                                                                                                                          | Documented. ENGAGEMENT, SALES, LEADS, APP_PROMOTION, MESSAGES: **Refused** (need a post, pixel, lead form, app or messaging destination Flexibx does not set up; ENGAGEMENT's destination rules are unverified)   |
| Placements             | explicit `publisher_platforms: ["facebook"]` + `facebook_positions` (feed, story, facebook_reels), editable on the plan                                                                                                                                                                                                                                                                                                             | Documented. AUTOMATIC and any Instagram placement: **Refused** — Meta's default placements include Instagram, and Instagram placements need an Instagram account ID (`instagram_user_id`) Flexibx does not select |
| Currency / budget unit | `lifetime_budget` in the account currency's minor unit                                                                                                                                                                                                                                                                                                                                                                              | Documented (budget limits table states minor units). **Refused**: 0- and 3-decimal currencies and currencies with Meta's own offset (CLP, COP, CRC, HUF, IDR, ISK, JPY, KRW, PYG, TWD, VND)                       |
| Page                   | `GET /me/accounts?fields=id,name,tasks` (all result pages); only Pages whose `tasks` include ADVERTISE; a person picks one on the plan (stored, audited, part of the approval with its name); one eligible Page in a complete list is selected automatically; several → `ads_identity_ambiguous` until a person picks; a picked Page no longer listed at submission → `ads_identity_missing`                                        | Documented (`tasks`, ADVERTISE). Never guesses                                                                                                                                                                    |
| Image                  | `POST /act_{id}/adimages` multipart `filename`; hash from `images.*.hash`                                                                                                                                                                                                                                                                                                                                                           | Documented                                                                                                                                                                                                        |
| Campaign               | `objective`, `status=PAUSED`, `special_ad_categories=[]`, `buying_type=AUCTION`                                                                                                                                                                                                                                                                                                                                                     | Documented                                                                                                                                                                                                        |
| Campaign               | `is_adset_budget_sharing_enabled=false`                                                                                                                                                                                                                                                                                                                                                                                             | **Assumption** (third-party report that v26.0 requires it without a campaign budget). Fail-safe: if Meta rejects it, the campaign step fails definitively — nothing is created, nothing duplicates                |
| Ad set                 | `lifetime_budget`, `start_time`/`end_time`, `billing_event=IMPRESSIONS`, `optimization_goal`, `bid_strategy=LOWEST_COST_WITHOUT_CAP`, `targeting`, `status=PAUSED`                                                                                                                                                                                                                                                                  | Documented                                                                                                                                                                                                        |
| Ad set                 | `targeting.targeting_automation.advantage_audience=0`                                                                                                                                                                                                                                                                                                                                                                               | **Assumption** (Meta's Advantage+ material; not in the ad set reference). Same fail-safe: a rejection fails the step definitively                                                                                 |
| Ad set                 | TRAFFIC without an explicit `destination_type`                                                                                                                                                                                                                                                                                                                                                                                      | **Assumption** that the website link in the creative is the destination. A rejection fails definitively                                                                                                           |
| Creative               | `object_story_spec.page_id` + `link_data` (`link`, `message`, `name`, `image_hash`, `call_to_action`), **created with the chosen Page's access token**, read from `GET /me/accounts` (id, tasks, access_token) immediately before the write and never stored or logged; no Page token or no ADVERTISE task at that moment → the step is refused before the write                                                                    | Documented (creative guide, Click to WhatsApp "Before you start": a Page access token from a person with the ADVERTISE task). Applying that prerequisite to link creatives is the closest documented rule         |
| Ad                     | `adset_id`, `creative: {creative_id}`, `status=PAUSED`                                                                                                                                                                                                                                                                                                                                                                              | Documented                                                                                                                                                                                                        |
| Activation             | `POST /{ad_id}`, `/{adset_id}`, `/{campaign_id}` with `status=ACTIVE` (children first); `effective_status` read back — after activation Meta reviews the ad (PENDING_REVIEW) before ACTIVE                                                                                                                                                                                                                                          | Documented (click-to-WhatsApp guide: update by POST to the object id; review states). `activationStatus=ACTIVE` means Meta accepted the three status writes; the delivery status shown is Meta's own              |
| Reconciliation         | an unknown outcome is looked up by listing the parent's children — `/act_{id}/campaigns`, `/{campaign}/adsets`, `/act_{id}/adcreatives`, `/{adset}/ads` — every page, names matched in Flexibx; "absent" only after the complete list was read, otherwise the lookup fails and the executor stops (`ads_outcome_unknown`)                                                                                                           | Documented edges; no edge-level filtering is relied on. Residual risk: a just-created object not yet listed (lookups happen only on a later, re-approved resubmission)                                            |
| Permissions            | `ads_management`, `pages_show_list`, `pages_manage_ads` (requested only when `ADS_EXECUTION_ENABLED=true`; all required before any write)                                                                                                                                                                                                                                                                                           | Documented: the creative guide requires `ads_management` and `pages_manage_ads`; `pages_show_list` lists the Pages and their tasks                                                                                |
| Unknown outcomes       | network failure, timeout/abort, HTTP 5xx, unreadable answer, Meta codes 1/2 to a write → UNCERTAIN; never resent without a lookup                                                                                                                                                                                                                                                                                                   | Flexibx rule (tested)                                                                                                                                                                                             |
| Timeouts               | each request ≤ 20 s; task timeouts (launch 180 s, activation 200 s, reconcile 90 s) cover every request; on timeout the request in flight is aborted and recorded UNCERTAIN                                                                                                                                                                                                                                                         | Flexibx rule (tested)                                                                                                                                                                                             |
| Before every write     | emergency stop (re-read before each write, not only when the task was claimed), plus at task start: role (`ads.plan` + `automation.manage`), execution switch, writer, objective, currency, placements, destination, connection status and permissions, spending limits; the engine re-describes the action (identity and name, destination, media, every call, amount, plan/connection versions) — any change needs a new approval | Flexibx rule (tested)                                                                                                                                                                                             |
| Crashes                | a write in flight when a worker dies stays IN_FLIGHT; lease recovery fails the run (`outcome_unknown`); the plan can be reopened and resubmitted (new approval) and the step is looked up first. An activation whose run died can be requested again; it reads Meta before writing                                                                                                                                                  | Flexibx rule (tested)                                                                                                                                                                                             |
| Concurrency            | duplicate submissions share one run (idempotency key = plan + version); every state change is compare-and-set                                                                                                                                                                                                                                                                                                                       | Flexibx rule (tested)                                                                                                                                                                                             |

### Snapchat and TikTok write paths — blocked (what needs platform approval or verification)

- **Snapchat:** verified campaign and ad squad bodies are written down
  (`snapchatCreationBodies`); creatives need the advertiser's Public Profile id
  (`profile_properties.profile_id`) and activation needs the update semantics — neither
  verified, so the writer is not ready. Needs a Snap Marketing API app with write access
  and a sandbox/test ad account.
- **TikTok:** campaign and ad group bodies are written down (`tiktokCreationBodies`); the
  ad identity (`identity_id`/`identity_type`), `/ad/create/` creative fields and the status
  update endpoint are unverified, so the writer is not ready. Needs TikTok API for Business
  approval for campaign management and a sandbox advertiser.

Both show "blocked" in the review; submission is refused before any run.

### Optimization recommendations (`src/server/ads/optimization.ts`)

From each selected account's stored snapshot (historical results, labelled with the
window, never a forecast): campaigns with ≥ 1,000 impressions are compared by CTR and
CPC; a live campaign that spent without clicks or whose CTR is under half the account's
median gets "consider pausing" and "try a new creative"; part (20 %) of its daily budget
may be suggested for moving to the best performer — the total never grows and the
receiving campaign stays within the workspace's daily cap. No expected-performance
numbers are invented, and nothing is applied automatically.

## Meta (Facebook and Instagram ads)

Official flow (Graph / Marketing API, version from `META_GRAPH_VERSION`, default v26.0 —
released 2026-07-29):

1. Login dialog `https://www.facebook.com/{version}/dialog/oauth` with `client_id`,
   `redirect_uri`, `state`, `response_type=code`, and either:
   - Business apps (Facebook Login for Business, `META_CONFIG_ID` set): `config_id` and
     `override_default_response_type=true`, no `scope` — Documented: "config_id has
     replaced scope (which should not be used)"; the configuration (User access token)
     lists the permissions;
   - classic Facebook Login apps: `scope=ads_read` (plus the write permissions when
     `ADS_EXECUTION_ENABLED=true`).
2. Server-to-server code exchange `GET https://graph.facebook.com/{version}/oauth/access_token`
   (`client_id`, `client_secret`, `redirect_uri`, `code`), then a long-lived token
   (`grant_type=fb_exchange_token`, ~60 days).
3. `GET /me`, `GET /me/permissions` (the connection is refused when `ads_read` is not
   granted), `GET /me/adaccounts`.
4. Reads: `/act_{id}/campaigns`, `/adsets`, `/ads`, `/insights?level=campaign&date_preset=last_30d`,
   cursor pagination (3 pages × 100 per list; truncation is shown).

Every token call carries `appsecret_proof` (HMAC-SHA256 of the token with the app
secret). Graph error codes map to: 190/102/463/467 → token expired; 3, 10, 200–299 →
permission missing; 4/17/32/613/80000–80014 → rate limited; 100 → invalid request.

**Prerequisites (operator):** a Meta app with the Marketing API product and Facebook
Login; `{APP_URL}/api/integrations/meta/callback` registered as a valid OAuth redirect
URI; `META_APP_ID`, `META_APP_SECRET`, `ENCRYPTION_KEY` set. In development access the app
can read only ad accounts of people with a role on the app. Reading other businesses'
accounts needs Advanced (now "Full") access for `ads_read` through App Review and
Business Verification.

**Creation and activation:** see "Execution" above. Not yet done: a run against a real
Meta test ad account (the only way to confirm the assumptions), Instagram-only identities,
objectives needing a pixel, lead form, app or WhatsApp destination.

Not done here (documented gaps): revoking the app on Meta's side when disconnecting (the
person removes Flexibx in their Facebook settings; Flexibx deletes its stored token);
token refresh before expiry (reconnect when it expires); webhooks.

## Snapchat Ads (read-only)

Implemented in `src/server/ads/adapters/snapchat.ts`, callback
`/api/integrations/snapchat/callback`. Enabled only when `SNAPCHAT_CLIENT_ID`,
`SNAPCHAT_CLIENT_SECRET` and `ENCRYPTION_KEY` are set; otherwise shown as "not
configured".

### Verified against Snap's official documentation (developers.snap.com, 2026-10-10)

Direct page fetches from this environment were blocked by its network policy; facts below
were confirmed from developers.snap.com pages through search results restricted to that
domain (Authentication, Quick Start, User, Ad Accounts, Organizations, Campaigns, Ad
Squads, Measurement, API Patterns, Rate Limits).

- OAuth 2.0 authorization code: authorize at
  `https://accounts.snapchat.com/login/oauth2/authorize` with `response_type=code`,
  `client_id`, `redirect_uri`, `scope=snapchat-marketing-api`.
- Token endpoint `https://accounts.snapchat.com/login/oauth2/access_token` (POST):
  `grant_type=authorization_code` with `client_id`, `client_secret`, `code`,
  `redirect_uri` (must match the authorize call); `grant_type=refresh_token` with
  `refresh_token`, `client_id`, `client_secret`.
- Access tokens expire after `expires_in` (currently 3600 s); refresh tokens do not
  expire but stop working when the person's access is removed. A 401 means refresh and
  retry.
- API base `https://adsapi.snapchat.com/v1`, `Authorization: Bearer <access_token>`.
- `GET /v1/me` (the authenticated user: `id`, `display_name`, `email`, …);
  `GET /v1/me/organizations?with_ad_accounts=true` (organizations with their ad accounts:
  `id`, `name`, `currency`, `timezone`, `status`).
- Ad account campaigns / ad squads / ads lists; responses carry `request_status` and items
  wrapped with `sub_request_status`; paging via `paging.next_link`.
- Money in micro-currency (`daily_budget_micro`, `lifetime_spend_cap_micro`, stats
  `spend`): 1 unit = 1,000,000 micro.
- Stats: `GET /v1/adaccounts/{id}/stats?granularity=TOTAL&breakdown=campaign
&fields=impressions,swipes,spend&start_time&end_time`, results in
  `total_stats[].total_stat.breakdown_stats.campaign[]`; the stats page limit is 200.
- Ad squad targeting: `geos[].country_code` (lowercase), `demographics[].min_age/max_age`.
- Rate limits: about 20 requests/s per app, 10 requests/s per access token; 429 on excess.

### Assumptions (not verified; fail closed where they matter)

- `state` is echoed on the redirect (standard OAuth 2.0). If it were not, every callback
  would fail as "expired or invalid link" — nothing would be stored.
- The token response includes `scope`; when absent, the single requested scope is taken
  as granted (Snap's consent screen grants it or nothing).
- A rotated `refresh_token` may come back on refresh; it is stored when it differs.
- Status values beyond `ACTIVE`/`PAUSED` (e.g. `DISABLED`, `PENDING_REVIEW`) and the
  legacy objective names in the mapping; unknown values become "Other" / no objective.
- Stats `start_time`/`end_time` at midnight in the account's time zone with an explicit
  offset (the examples use offsets; DST is computed per date). Reach is not requested
  (`reach` is null); swipe-ups are shown as clicks.
- Error bodies: only HTTP status (and OAuth `error=invalid_grant`) is used; 401 → token
  expired, 403 → permission missing, 429 → rate limited, 400/404/422 → invalid request,
  other → provider error. A 200 whose `request_status` is not `SUCCESS` is an error.
- `describeLaunch` field names (`objective_v2_properties`, `placement_v2`,
  `lifetime_budget_micro`, `top_snap_media`, …) are for review only and have not been
  validated against the write API.

### Security

- Only the refresh token is stored (encrypted, bound to workspace + `SNAPCHAT`); access
  tokens live in memory for one operation. The client secret travels only in the POST
  body to the token endpoint, never in a URL; API calls use the Bearer header.
- `paging.next_link` is followed only when it points to `https://adsapi.snapchat.com/v1/`
  (a link elsewhere would carry the Bearer token); at most 3 pages × 200 per list.
- The person's email from `/v1/me` is never kept — only the id and display name.

### Prerequisites (operator) — still required before any real use

1. A Snap Marketing API OAuth app (Snapchat Ads Manager → Business Details → OAuth
   Apps; needs an Organization Admin), with `{APP_URL}/api/integrations/snapchat/callback`
   as its redirect URI.
2. `SNAPCHAT_CLIENT_ID`, `SNAPCHAT_CLIENT_SECRET`, `ENCRYPTION_KEY` set on the server.
3. The connecting person needs a role on the ad accounts to be read.
4. A first real connection and sync against a real (or Snap-provided test) ad account to
   confirm the assumptions above. **This has not been done.**

**Not implemented — needed for launching:** a write path (campaign, ad squad, media
upload, creative, ad) tested against Snap, Snap's creative constraints (e.g. headline
length), and placement choices beyond automatic.

## TikTok Ads (read-only)

Implemented in `src/server/ads/adapters/tiktok.ts`, callback
`/api/integrations/tiktok/callback`. Enabled only when `TIKTOK_APP_ID`,
`TIKTOK_APP_SECRET` and `ENCRYPTION_KEY` are set; otherwise shown as "not configured".

### Verified against TikTok's official documentation (business-api.tiktok.com, 2026-10-10)

Direct page fetches were blocked by this environment's network policy; the facts below
were confirmed from business-api.tiktok.com pages through search results restricted to
TikTok's domains ("Obtain a long-term access token", "Get authorized ad accounts", "Get
ad account details", "Rate limits", "Basic reports", "Get ads", "Get Started").

- Advertiser authorization: the developer copies the app's **Advertiser authorization
  URL** (My Apps → Basic Information); after consent the advertiser is sent to the
  registered redirect URL with the code as `auth_code` (the docs' sample also shows
  `code`; Flexibx reads `auth_code`, falling back to `code`). The code is valid 1 hour,
  single use.
- Token: `POST https://business-api.tiktok.com/open_api/v1.3/oauth2/access_token/`, JSON
  body `app_id`, `secret`, `auth_code`; response `access_token`, `advertiser_ids`,
  `scope`. The long-term token **does not expire**; it stops working when the advertiser
  cancels the authorization (`/oauth2/revoke_token/` also revokes it). v1.3 ids are strings.
- Calls send the token in the `Access-Token` header. Responses are
  `{ code, message, request_id, data }`; `code: 0` is success; failures may also come with
  4xx/5xx. `code: 40100` = throttled (QPS / QPM / QPD limits; tiers 10/20/30/50 QPS).
- `GET /oauth2/advertiser/get/` (`app_id`, `secret`, Access-Token) lists authorized
  advertisers; `GET /advertiser/info/` (`advertiser_ids` string list) returns `name`,
  `currency` (ISO 4217), `timezone` (offset or TZ name), `display_timezone` (TZ name),
  `status` (e.g. `STATUS_ENABLE`).
- `report/integrated/get/`: synchronous basic report; `data_level=AUCTION_CAMPAIGN`
  requires `campaign_id` as a dimension; without `stat_time_day` up to 365 days; dates are
  in the ad account's time zone; deleted campaigns excluded by default; list arrays are
  JSON-encoded in the query string.
- `ad/get/`: `page` (default 1) and `page_size` (1–1,000).

### Assumptions (not verified; fail closed where they matter)

- The default authorization URL `https://business-api.tiktok.com/portal/auth?app_id&state
&redirect_uri` (seen only in third-party guides). Operators should set
  `TIKTOK_AUTHORIZE_URL` to the URL shown in their app; Flexibx sets `app_id`, `state` and
  `redirect_uri` on it. If TikTok did not echo `state`, every callback fails as "expired
  or invalid link" — nothing is stored.
- `campaign/get/` and `adgroup/get/` use the same `page`/`page_size`/`page_info.total_page`
  paging as `ad/get/` (at most 3 pages × 1,000 per list; truncation is shown); the report
  pages the same way.
- Field names `campaign_name`, `objective_type`, `operation_status`, `secondary_status`,
  `budget`, `budget_mode`, `age_groups`, `optimization_goal`; report rows
  `{ dimensions: { campaign_id }, metrics: { spend, impressions, clicks, reach } }`; money in
  major units. Unknown values become "Other" / no objective.
- Return codes other than 0 and 40100: 40001/40003 → permission missing,
  40102/40104/40105 → token expired, 40002/40006 → invalid request (HTTP 401/403/429 are
  also mapped). A missing permission still fails safe (the read fails; nothing stored).
- `scope` is a list of permission ids, shown as-is; no scope is required at connection —
  the reads themselves reveal missing permissions.
- The token response names no person, so the connection is identified by
  `authorization-<sha256 prefix of the authorized advertiser ids>`; "connected as" shows —.
- Ad group targeting uses TikTok location ids, which are not mapped to countries.
- `describeLaunch` field names (`campaign/create/`, `adgroup/create/`, `ad/create/`, all
  `operation_status: DISABLE`) are for review only and have not been validated.

### Security

- Only the long-term token is stored (encrypted, bound to workspace + `TIKTOK`). It is
  sent only in the `Access-Token` header to `business-api.tiktok.com`, never in a URL.
- The app secret goes in the JSON body of the token exchange and, as TikTok's
  `/oauth2/advertiser/get/` requires, as a query parameter of that one HTTPS GET to
  TikTok. Outbound URLs are never logged by Flexibx.
- `TIKTOK_AUTHORIZE_URL` must be https on `business-api.tiktok.com` or `ads.tiktok.com`.
- Disconnect deletes the stored token; revoking on TikTok's side is not called yet.

### Prerequisites (operator) — still required before any real use

1. A TikTok API for Business developer account and app (My Apps) approved for the Ad
   Account Management and Reporting permissions, with
   `{APP_URL}/api/integrations/tiktok/callback` as its redirect URL (https).
2. `TIKTOK_APP_ID`, `TIKTOK_APP_SECRET`, `ENCRYPTION_KEY` (and ideally
   `TIKTOK_AUTHORIZE_URL`) set on the server.
3. A first real authorization and sync (TikTok's sandbox first) to confirm the
   assumptions above. **This has not been done.**

**Not implemented — needed for launching:** a write path (campaign, ad group, media
upload, ad) tested in TikTok's sandbox, location id lookup for targeting, identity
(TikTok account) selection for ads, and placements beyond automatic.

## WhatsApp Business

Implemented in `src/server/ads/adapters/whatsapp.ts` (connection, account discovery,
reads), `src/server/whatsapp/` (sync, webhook) and the Integrations page. Uses the SAME
Meta app as Meta Ads (`META_APP_ID`, `META_APP_SECRET`) plus `WHATSAPP_CONFIG_ID` (the
Embedded Signup configuration) and `ENCRYPTION_KEY`; otherwise "not configured".
Callback `/api/integrations/whatsapp/callback`; webhook `/api/integrations/whatsapp/webhook`.

Three different things, kept apart:

1. **Ads that click to WhatsApp** are Meta ads (Marketing API): an ad set with
   `destination_type: WHATSAPP`, `billing_event: IMPRESSIONS`, a `promoted_object.page_id`
   (Facebook Page, required) and optionally the WhatsApp number. Flexibx plans them on a
   **Meta** ad account with objective `MESSAGES` (the planner is told when WhatsApp is
   connected); the review shows the WhatsApp destination. Launching stays unavailable like
   every Meta launch.
2. **WhatsApp messaging** (Cloud API): see "Sending messages" below — one approved message
   to one opted-in contact; off unless `WHATSAPP_SENDING_ENABLED=true`.
3. **WhatsApp account management** (Business Management API): WABAs, phone numbers,
   templates. **Read-only** here.

### Verified against Meta's official documentation (developers.facebook.com, 2026-10-10)

Direct fetches were blocked by this environment's network policy; facts were confirmed
from developers.facebook.com pages through search results restricted to that domain
(Embedded Signup overview and implementation, Access Tokens, Business phone numbers,
Register a business phone number, WhatsApp webhooks, Throughput, Messaging Limits,
Pricing, Solution Partner guides, Click to WhatsApp, Facebook Login for Business, Manually
Build a Login Flow).

- Embedded Signup is launched with Facebook Login for Business: `config_id`,
  `response_type=code`, `override_default_response_type=true` (Client OAuth login on). It
  returns `waba_id`, `phone_number_id` and an exchangeable code (TTL 30 seconds) that must
  be exchanged server-to-server for a business token.
- `debug_token` returns `granular_scopes`; the `whatsapp_business_management` entry's
  `target_ids` are the shared WABAs (most recent first).
- `whatsapp_business_management` is needed for WABA settings and templates; Solution
  Partners need App Review and **Advanced access** (without it, calls on WABAs the business
  does not own fail with error 200). `whatsapp_business_messaging` (sending) also requires
  App Review.
- `GET /{WABA_ID}/phone_numbers` and `GET /{WABA_ID}` with `fields` (message templates
  with name, language, status, category). Phone number fields include `verified_name`,
  `code_verification_status`, `display_phone_number`, `quality_rating` (GREEN / YELLOW /
  RED, sometimes NA/UNKNOWN), `platform_type`, `throughput`.
- After onboarding: `POST /{WABA_ID}/subscribed_apps` (webhooks) and
  `POST /{PHONE_NUMBER_ID}/register` within 14 days — **writes Flexibx does not perform**.
- Webhooks: GET verification with `hub.mode=subscribe`, `hub.verify_token`,
  `hub.challenge`; POST payloads signed with HMAC-SHA256 of the raw body using the app
  secret in `X-Hub-Signature-256: sha256=…`; payloads up to 3 MB; failed deliveries are
  retried for up to 7 days and retries can arrive as duplicates; status webhooks can
  conflict (delivered and failed) and arrive out of order; the `messages` field carries
  inbound messages and outgoing message statuses.
- Limits: 80 messages/second per number by default (up to 1,000 automatically when
  eligible); messaging limits per business portfolio for users outside the 24-hour
  customer service window (250 → 2,000 → 10,000 → 100,000 → unlimited); about 1 message
  every 6 seconds to the same user (error 131056); Graph management calls 200/hour per
  app per WABA by default (5,000 with a registered number). Outside the 24-hour customer
  service window only approved templates may be sent; Meta bills messages.
- Click to WhatsApp (Marketing API) parameters as listed above.

### Assumptions (not verified; fail closed where they matter)

- The **manual** (redirect) form of the Facebook Login for Business dialog with
  `config_id`, `response_type=code`, `override_default_response_type=true`, `state` and
  `redirect_uri` — Meta documents those parameters for the JavaScript SDK and documents
  the manual flow separately, but no page shows the combination. If the redirect flow does
  not carry the state or code, connecting fails closed ("expired or invalid link").
- The business token's `expires_at` of 0 meaning "never expires".
- WABA fields `name`, `currency`, `account_review_status` (APPROVED/PENDING/REJECTED);
  WABAs carry no ad currency, stored as `XXX` (ISO 4217 "no currency").
- Webhook status values beyond sent/delivered/read/failed are stored as `other`; the
  first `errors[].code` of a failed status is kept.

### Security and privacy

- One Meta app (Flexibx's) for all customers; each workspace's business token is stored
  encrypted and bound to that workspace and `WHATSAPP`, with `appsecret_proof` on calls.
- Business numbers are stored masked (last 4 digits). Customer numbers, message ids and
  message contents are never stored or logged; a message id only feeds a one-way hash used
  to deduplicate events.
- Webhooks: nothing is parsed before the signature is verified (constant-time); bodies
  over 3 MB are refused; events older than 7 days or more than 5 minutes in the future are
  ignored (replays); each event is recorded at most once per workspace
  (`unique(workspace_id, event_hash)`, append-only table); only workspaces that selected
  the WABA with an active connection receive events; webhook URLs are kept out of the dev
  request log; bodies are never logged.
- The verify token is compared in constant time; only a plain challenge is echoed.

### Prerequisites (operator) — still required before any real use

1. Meta app with the WhatsApp product, onboarded as a **Tech Provider / Solution
   Partner**, Business Verification, App Review with **Advanced access** to
   `whatsapp_business_management` (and `business_management`).
2. A Facebook Login for Business **Embedded Signup configuration** → `WHATSAPP_CONFIG_ID`;
   `{APP_URL}/api/integrations/whatsapp/callback` as a valid OAuth redirect URI (and the
   domain in Allowed domains).
3. Webhook: callback URL `{APP_URL}/api/integrations/whatsapp/webhook`, Verify Token =
   `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, subscribed to the `messages` field; each customer WABA
   subscribed with `POST /{WABA_ID}/subscribed_apps` (not done by Flexibx yet).
4. A first real Embedded Signup and read to confirm the assumptions. **Not done.**

### Sending messages

`src/server/whatsapp/{contacts,consent,sending,messaging}.ts`, workflow
`orchestration/workflows/whatsapp-send.ts` (validate → send EXTERNAL → report), UI on the
Integrations page.

- **Consent.** A contact is added only with a recorded opt-in (source + explicit
  confirmation by the member). Numbers are normalized to E.164, stored AES-256-GCM
  encrypted (binding `WHATSAPP_CONTACT` + workspace), with a keyed HMAC per
  workspace+account and a masked form for display. Every opt-in, opt-out, marketing
  opt-out and marketing resume is appended to `whatsapp_consent_events` (database trigger:
  no update; application client: no update or delete), with source, time and the member
  who recorded it, and audited. Opt-out: by staff, by the customer writing exactly
  STOP / UNSUBSCRIBE / إيقاف / إلغاء. Only the customer can opt in again (START / اشتراك,
  newer than the opt-out); staff cannot re-add an opted-out number.
- **Marketing opt-out (separate from consent).** Meta's `user_preferences` webhook (field
  `user_preferences`, entries with `wa_id`, `category: "marketing_messages"`, `value`,
  `timestamp`) and error 131050 on a send or status report record that the customer
  stopped marketing messages. Then MARKETING templates (and any template whose category is
  unknown) are refused; UTILITY/AUTHENTICATION templates and service replies in the
  window are still allowed. Only an explicit `value: "resume"` clears it; **any other
  value counts as "stop"** (the exact value strings are not in the documentation found —
  third-party sources say stop/resume). Entries without a `wa_id` (username-only
  customers) cannot be matched and are skipped. Every change applies only if newer than
  the last one, so retries and reordering cannot undo a newer choice; the stored event
  hash is keyed, never the number.
- **Immediate suppression.** An opt-out cancels the contact's messages waiting for approval
  (all of them; a marketing opt-out cancels marketing templates), audited
  (`whatsapp.send_cancelled`). An already approved message is re-checked when sending, so
  it cannot go out either.
- **One message, one contact, one approval.** No lists, no bulk sends. Requesting needs
  `ads.plan` + `automation.manage`; an owner or admin approves the exact message (number,
  masked recipient, consent source and time, template + language + parameters or the
  text, the request body with the recipient masked). Re-described before sending (a change
  → new approval) and re-checked: `WHATSAPP_SENDING_ENABLED`, account selected, connection
  ACTIVE with `whatsapp_business_messaging`, the business number belongs to the account,
  consent, marketing opt-out, an **APPROVED** template in that exact language, or for free
  text the **24-hour window**, numbers and templates synced within 24 hours, daily caps
  (50 per workspace, 2 per contact), and the emergency stop immediately before sending.
- **Exactly once.** A request key per rendered form makes double submits harmless; the
  message moves `PENDING → SENDING` (compare-and-set) before the call; anything but
  PENDING is never sent and nothing is retried automatically. Network failure, 5xx or no
  message id → `UNCERTAIN`. A send interrupted by a worker crash (SENDING with an ended
  run) becomes `UNCERTAIN` at the next request. An UNCERTAIN message blocks further sends
  to that contact until an owner or admin records that they checked it
  (`resolveUncertainMessage`, audited) — it is never resent. Refusals keep Meta's code
  (131047 → window closed; 130429/131048/131056 → rate limited; 131050 → marketing
  opt-out). A rejected or cancelled request becomes `CANCELLED`.
- **Statuses.** The wamid is stored; signed webhook reports move a message forward only
  (`ACCEPTED → SENT → DELIVERED → READ`; `FAILED` only before delivery); duplicates and
  out-of-order reports are harmless; a report that arrives before the API's answer is
  applied afterwards. "Accepted" (the API answer) is shown separately from "delivered".

Documented (developers.facebook.com, 2026-10-10/11): `POST /{phone-number-id}/messages`
with `messaging_product`, `to`, `type` (`template`: `name`, `language.code`,
`components`; `text`: `body`); templates must be APPROVED; `messages[0].id` is the wamid;
131047, 130429, 131049, 131056, 131050 (do not retry), 131026; error handling on `code`;
the `user_preferences` webhook field (needs `whatsapp_business_management`, enabled in the
App Dashboard). Assumptions: Bearer token in `Authorization` with `appsecret_proof`;
recipient digits without "+"; body parameters only (header/button parameters not
supported); the `user_preferences` value strings (fail-safe above).

**Still required (operator):** `whatsapp_business_messaging` (Advanced access via App
Review) included in the Embedded Signup configuration; a registered, verified business
number; approved templates; the WABA subscribed to webhooks with the `messages` and
`user_preferences` fields; a payment method on the WABA. **Never tested against the real
Cloud API.** Not implemented: number registration, template creation, media messages,
header/button template parameters.

## Multi-tenant integration model

Flexibx owns **one developer app per platform** (server-side configuration only:
`META_*`, `SNAPCHAT_*`, `TIKTOK_*`, `WHATSAPP_CONFIG_ID`); customers never create or enter
developer credentials. Each **workspace** connects its own accounts through the platform's
official consent screen, and everything that follows is bound to that workspace:

| Bound to the workspace                         | How                                                                                                 |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| OAuth state                                    | hashed, single use, 10 min, bound to person + workspace + platform; role re-checked at the callback |
| Connection + token                             | one row per (workspace, platform); token AES-256-GCM with AAD = workspace + platform                |
| Accounts                                       | rows per workspace (the same external account connected by two workspaces is two rows)              |
| Sync snapshots, WhatsApp reads, webhook events | workspace-scoped tables, tenant guard, same-workspace triggers                                      |
| Plans, runs, approvals, audit                  | workspace-scoped; launching needs an approved run                                                   |

Lifecycle: **connect** (owners/admins, `ads.manage`) → accounts discovered, none selected
→ **select** accounts (owners/admins; only accounts the live connection still grants) →
**sync/plan** (`ads.plan`) → **reconnect** (re-consent; accounts no longer granted are
deselected and marked `access_lost`, and become usable again if granted back) →
**disconnect** (token deleted at once, accounts deselected, this workspace only).
Connecting never selects accounts, creates plans or runs, or authorizes spending,
publishing or messaging. The **Integrations** page (`/w/{slug}/integrations`) shows every
platform, whether Flexibx is configured for it, this workspace's status, who connected
it, granted permissions, expiry, errors, account counts (selected / no longer shared), and
what each platform still needs from Flexibx (developer approvals).

| Platform          | What Flexibx (the operator) must obtain                                                                                               | Customer action                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Meta Ads          | Meta app, Marketing API, App Review Advanced access `ads_read`, Business Verification (creation: `ads_management`, `pages_show_list`) | Log in, grant `ads_read` (and write permissions when enabled) |
| Snapchat Ads      | Snap Marketing API OAuth app                                                                                                          | Log in, approve                                               |
| TikTok Ads        | TikTok API for Business app approved for ad account management + reporting                                                            | Authorize advertisers                                         |
| WhatsApp Business | Same Meta app, Tech Provider, Advanced access `whatsapp_business_management`, Embedded Signup configuration, webhook                  | Complete Embedded Signup                                      |

## Testing

- Unit: `tests/unit/ads-core.test.ts` (vault, money, estimates, env),
  `tests/unit/ads-meta-adapter.test.ts` (OAuth URLs and exchange, appsecret_proof,
  read-only GETs, normalization, error mapping, launch description, no launch),
  `tests/unit/ads-snapchat-adapter.test.ts` (authorize URL, form-POST exchange with the
  secret in the body only, refresh and rotation, Bearer reads, paging bounded to Snap's
  host, micro-currency, time-zone windows, mapping, errors, launch description, env),
  `tests/unit/ads-tiktok-adapter.test.ts` (authorization URL, JSON exchange with the
  secret in the body, Access-Token header, `{code}` envelope, page-numbered paging and
  truncation, mapping, error codes, report window, launch description, env).
- Integration: `tests/integration/ads.test.ts` (state validation and replay, foreign
  sessions, role re-check, permission missing, token encryption and isolation, read-only
  sync, expired tokens, rate limits, disconnect, planner, review, launch gated by
  approvals with a test adapter, stale approvals, emergency stop, rejection, views);
  `tests/integration/ads-snapchat.test.ts` (refresh token stored encrypted, no access
  token or email stored, state bound to the platform, role re-check, per-use refresh,
  rotation, revocation → expired, permission/rate-limit errors, workspace isolation,
  shared planner with automatic placement, launch refused, callback route, views ar/en);
  `tests/integration/ads-tiktok.test.ts` (token encrypted and bound, expired / replayed /
  foreign-session / other-platform states refused before any exchange, role re-check,
  cancelled consent, `auth_code` read by the route, paginated read-only sync, token
  rejected → expired, permission / throttling / server errors, workspace isolation,
  disconnect, shared planner, launch refused before any run or approval, views ar/en).
- WhatsApp and multi-tenancy: `tests/unit/whatsapp.test.ts` (signature, verification,
  parsing without personal data, Embedded Signup adapter, no send path, click-to-WhatsApp
  description, env, log redaction), `tests/integration/integrations.test.ts` (independent
  connections, non-transferable tokens, disconnect isolation, narrowed re-authorization,
  selection rules, roles, overview without secrets, WhatsApp connect/sync/permission
  failure/isolation, webhook verification, refusal, deduplication, replay window,
  unselected and disconnected workspaces, views ar/en).
- Execution: `tests/unit/ads-execution.test.ts` (tags, budget units and currencies, PAUSED
  bodies, uncertain-write classification, blocked writers, Meta scopes, phone numbers,
  keywords, window, status ordering, Cloud API body and error classes, recommendations),
  `tests/integration/ads-execution.test.ts` (paused creation then separate activation,
  approvals and roles, identity/destination fingerprint, emergency stop, execution off,
  lowered limit, lost permission, expired and revoked tokens, partial failure and resume
  without duplicates, unknown outcomes reconciled or stopped, activation reconciliation,
  workspace isolation, no tokens stored), `tests/integration/whatsapp-sending.test.ts`
  (consent, number validation, encryption and masking, STOP/START ordering, opt-out
  before send, roles and approval, idempotent requests, exactly-once sending, templates
  and language, number ownership, permission, 24-hour window re-check, fingerprint,
  emergency stop, unknown outcomes, refusals, caps, rejection, out-of-order and early
  reports, isolation, views ar/en).
- Hardening (2026-10-11), in the same files: Page listing and choice (several Pages, a
  Page withdrawn on Meta), placement and currency refusals, parent-edge reconciliation
  with proof of absence, emergency stop between writes, a worker dying mid-write, an
  activation whose worker died, simultaneous duplicate submissions, the `user_preferences`
  webhook (stop/resume, ordering, retries, unknown values, missing `wa_id`), marketing
  suppression and cancellation of waiting messages, 131050 as a marketing opt-out, the
  append-only consent history, a send interrupted by a crash and its release by an owner
  or admin, and the emergency stop right before a WhatsApp send.
- No test calls a real platform; nothing is published, sent or paid. **Passing tests do
  not mean a platform accepts these requests**: every write path above still needs a run
  against the platform's own test account.

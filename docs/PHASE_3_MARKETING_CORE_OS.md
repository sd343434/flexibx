# Phase 3 — Marketing Core OS

Status: **COMPLETED** (human approved). Implementation commit
`b661a2689fef437cf8cb093fd4a45d56b934b661`, status commit
`c386b8041a905db97c8079cd7be2ad58208680ff`; CI run 37834859497 passed. Baseline:
`2734c962a094b7f49722c0f6db0cea84ee5593a2` (Phase 2 completed).

Phase 3 turns the authenticated workspace into a marketing operating system. A team can
describe its brand, define its audiences, goals and content pillars, plan campaigns,
write content and move it through an approval workflow, see it on a calendar, keep a
media library, and watch it all from a dashboard. Everything is tenant-isolated,
permission-checked on the server, audited, and available in Arabic (RTL) and English (LTR).

No AI, no social networks and no external publishing are part of this phase (§11).

## 1. Architecture

Phase 3 follows the Phase 1/2 rules without exception:

```
page (server component) ─┐
form → server action ────┴→ requireWorkspaceAccess(slug[, action])   session → membership → role
                              → strict Zod input (z.strictObject)      unknown keys rejected
                              → service: assertCan(ctx, action)        permission matrix
                                         scoped where (workspaceId)    tenant guard enforces it
                                         db.$transaction + recordAudit
                              → database: FKs, CHECKs, same-workspace and immutability triggers
```

| Layer                               | Files                                                                                                                              |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Input schemas (pure)                | `src/server/marketing/inputs.ts`                                                                                                   |
| Workflow rules (pure)               | `src/server/marketing/workflow.ts`                                                                                                 |
| Time zones, calendar periods (pure) | `src/server/marketing/time.ts`                                                                                                     |
| Image sniffing, file names (pure)   | `src/server/marketing/image.ts`                                                                                                    |
| Services                            | `brand-`, `audience-`, `goal-`, `pillar-`, `campaign-`, `content-`, `media-`, `overview-service.ts`, shared helpers in `common.ts` |
| Server actions (`withAction`)       | `src/server/marketing/marketing-actions.ts`                                                                                        |
| Page queries                        | `src/server/marketing/marketing-queries.ts`                                                                                        |
| Form entry points (`"use server"`)  | `src/app/[locale]/w/[workspaceSlug]/marketing-actions.ts`                                                                          |
| Media route                         | `src/app/api/w/[workspaceSlug]/media/[assetId]/route.ts`                                                                           |
| Pages                               | `src/app/[locale]/w/[workspaceSlug]/{page,brand,campaigns,content,calendar,media,activity}`                                        |
| UI kit                              | `src/components/marketing/{entity-form,page-parts}.tsx`                                                                            |

Decisions:

- **No new roles or permission actions.** Phase 3 maps onto the existing matrix (§5).
- **The client never sends a status for content.** It sends a transition name
  (`submit`, `approve`, …); the server decides the resulting status (§4).
- **Related ids are lookup keys only.** Every audience/goal/pillar/campaign/asset id is
  resolved inside the current workspace in the same transaction; another workspace's id
  is indistinguishable from an unknown id. Database triggers enforce the same rule again.
- **Archive instead of delete** for goals, pillars and campaigns (history stays intact);
  audiences, content items and media can be deleted.
- **Media is served only through an access-checked route.** No public URLs, no
  presigned links in pages, no SVG.
- **Pages are server-rendered.** Forms are generic, config-driven client components
  (`EntityForm`, `ActionButton`) that only collect input and show the server's answer.

## 2. Domain model

All tables are workspace-owned (`workspace_id NOT NULL`, ON DELETE CASCADE from the
workspace, every index leads with `workspace_id`) and registered in the tenant guard.

| Model (table)                       | Purpose                       | Notes                                                                                                                                                                                                          |
| ----------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Brand` (`brands`)                  | One profile per workspace     | `workspace_id` unique; name, description, website, industry, market, language (AR/EN/BILINGUAL), mission, positioning, value proposition, tone of voice, personality, keywords[], forbidden words[], CTA style |
| `Audience` (`audiences`)            | Target groups / personas      | attributes (JSON `[{label, value}]`, ≤ 20), pain points[], needs[], interests[], objections[], preferred channels[], buying intent, notes                                                                      |
| `MarketingGoal` (`marketing_goals`) | What marketing should achieve | type, title, KPI, target `numeric(14,2)`, start/end `date`, status ACTIVE/PAUSED/ACHIEVED/ARCHIVED                                                                                                             |
| `ContentPillar` (`content_pillars`) | Recurring themes              | optional audience, objective, status ACTIVE/ARCHIVED, `position` (dense order)                                                                                                                                 |
| `Campaign` (`campaigns`)            | Time-boxed pushes             | dates, status (§4), optional audience, planning budget in minor units + ISO currency                                                                                                                           |
| `CampaignGoal`, `CampaignPillar`    | Campaign links                | composite primary keys, carry `workspace_id`                                                                                                                                                                   |
| `ContentItem` (`content_items`)     | Posts, reels, articles…       | title, body (≤ 10 000), type, status (§4), optional campaign/pillar/audience/goal, `scheduled_at`, `published_at`, notes, metadata (hashtags, CTA, link), creator                                              |
| `MediaAsset` (`media_assets`)       | Media library (images)        | display file name, sniffed content type, size, dimensions, alt text, server-built storage key, uploader                                                                                                        |
| `ContentItemAsset`                  | Images attached to content    | ordered, cascade with either side                                                                                                                                                                              |

Relations to optional records use ON DELETE SET NULL (deleting an audience unlinks it
everywhere). Creator/uploader references to users use SET NULL.

## 3. Database and migration

Migration `prisma/migrations/20261008150345_marketing_core` (Prisma-generated DDL plus
appended SQL). Beyond tables, enums, FKs and indexes it adds:

- **Same-workspace triggers** on every cross-table reference: pillar → audience,
  campaign → audience, campaign goals/pillars, content → campaign/pillar/audience/goal,
  content assets → content/asset. A reference to another workspace's row raises
  `foreign_key_violation`, even from the unguarded client.
- **Workspace-immutable triggers** on brands, audiences, goals, pillars, campaigns,
  content and media: `workspace_id` can never change.
- **CHECK constraints:** goal/campaign end ≥ start; budget amount ≥ 0 with a 3-letter
  uppercase currency, or both null; goal target ≥ 0; positions ≥ 0; `SCHEDULED` content
  has `scheduled_at`; `published_at` is set exactly when the status is `PUBLISHED`; media
  size and dimensions > 0, content type in PNG/JPEG/WebP, and the storage key must be
  `workspaces/<own workspace id>/content-media/<uuid>.<png|jpg|webp>`.

`prisma migrate status` reports no drift; the migration applies on an empty database
(integration global setup).

## 4. Workflows

### Content

```
DRAFT ──submit──▶ IN_REVIEW ──approve──▶ APPROVED ──schedule──▶ SCHEDULED ──publish──▶ PUBLISHED
  ▲                 │   │                   │  │                    │
  └──withdraw───────┘   │                   │  └──────publish───────┼──────────────────▶
  └──request_changes────┘                   │                       │
  └──reopen─────────────────────────────────┘    APPROVED ◀─unschedule┘
```

| Transition        | From                | To        | Permission                                 |
| ----------------- | ------------------- | --------- | ------------------------------------------ |
| `submit`          | DRAFT               | IN_REVIEW | `content.edit`                             |
| `withdraw`        | IN_REVIEW           | DRAFT     | `content.edit`                             |
| `approve`         | IN_REVIEW           | APPROVED  | `content.approve`                          |
| `request_changes` | IN_REVIEW           | DRAFT     | `content.approve`                          |
| `reopen`          | APPROVED            | DRAFT     | `content.edit`                             |
| `schedule`        | APPROVED            | SCHEDULED | `content.publish` (future time required)   |
| `unschedule`      | SCHEDULED           | APPROVED  | `content.publish`                          |
| `publish`         | APPROVED, SCHEDULED | PUBLISHED | `content.publish` (records `published_at`) |

- `PUBLISHED` is final. "Mark as published" records that the team published the content
  itself; Flexibx does not post anywhere yet.
- Only drafts can be edited (`content_locked` otherwise).
- Every status change is an `updateMany` conditional on the status that was read: of two
  concurrent changes exactly one applies, the other gets `CONFLICT`/`stale_status`.
- Invalid transitions are rejected without any write (`CONFLICT`/`invalid_transition`).
- Deleting a draft needs `content.edit`; deleting anything further along needs
  `content.publish`.
- Moving content on the calendar: a `SCHEDULED` item needs `content.publish` and a future
  time; other unpublished items need `content.edit` (their planned time may be cleared);
  published items cannot be moved.

### Campaigns

DRAFT → PLANNED / ACTIVE / ARCHIVED; PLANNED → DRAFT / ACTIVE / ARCHIVED; ACTIVE → PAUSED /
COMPLETED / ARCHIVED; PAUSED → ACTIVE / COMPLETED / ARCHIVED; COMPLETED → ARCHIVED;
ARCHIVED is final and read-only. Archived campaigns, goals and pillars stay linked where
they already are but cannot be newly linked (`reference_archived`).

## 5. Permissions

No new roles or actions; Phase 3 uses the existing matrix
(`src/server/tenancy/permissions.ts`).

| Capability                                                  | Action                               | OWNER | ADMIN | MANAGER | EDITOR | VIEWER | CLIENT |
| ----------------------------------------------------------- | ------------------------------------ | :---: | :---: | :-----: | :----: | :----: | :----: |
| Dashboard                                                   | `workspace.view` (sections filtered) |   ✓   |   ✓   |    ✓    |   ✓    |   ✓    |   ✓    |
| View brand, audiences, pillars                              | `brand.view`                         |   ✓   |   ✓   |    ✓    |   ✓    |   ✓    |   ✓    |
| Edit brand, audiences, pillars                              | `brand.edit`                         |   ✓   |   ✓   |    ✓    |   ✓    |   –    |   –    |
| View goals, campaigns                                       | `campaign.view`                      |   ✓   |   ✓   |    ✓    |   ✓    |   ✓    |   ✓    |
| Manage goals, campaigns                                     | `campaign.manage`                    |   ✓   |   ✓   |    ✓    |   –    |   –    |   –    |
| View content, calendar, media                               | `content.view`                       |   ✓   |   ✓   |    ✓    |   ✓    |   ✓    |   ✓    |
| Create content, upload media                                | `content.create`                     |   ✓   |   ✓   |    ✓    |   ✓    |   –    |   –    |
| Edit drafts, submit/withdraw/reopen, alt text, delete media | `content.edit`                       |   ✓   |   ✓   |    ✓    |   ✓    |   –    |   –    |
| Approve / request changes                                   | `content.approve`                    |   ✓   |   ✓   |    ✓    |   –    |   –    |   ✓    |
| Schedule, unschedule, mark published                        | `content.publish`                    |   ✓   |   ✓   |    ✓    |   –    |   –    |   –    |
| Activity history                                            | `audit.view`                         |   ✓   |   ✓   |    –    |   –    |   –    |   –    |

Permissions are checked by `requireWorkspaceAccess(slug, action)` in the action and again
by `assertCan` in the service. Navigation entries and buttons are only UI hints. A role
without a section's permission gets the "not available for your role" state; a record id
from another workspace is a 404.

## 6. Tenant isolation

- `TenantContext` comes only from `requireWorkspaceAccess` (session → membership by slug).
- All ten new models are in `TENANT_MODELS`: every read/update/delete needs
  `where.workspaceId`, every create `data.workspaceId`, and `workspaceId` cannot be
  changed. The workspace's new relations are in `TENANT_ROOT_RELATIONS` (no nested
  writes through `Workspace`), and the user back-relations (`contentCreated`,
  `mediaUploaded`) cannot be included from `User` queries.
- Every service query is scoped; foreign ids are NOT_FOUND for get/update/delete/
  transition/reschedule/media read, and `reference_not_found` when linked.
- The database rejects cross-workspace links and workspace moves (§3) independently of
  the application.
- Storage keys are built by the server under the workspace prefix; the key is
  re-checked against the workspace before an object is read or deleted; the display
  file name never reaches the key.

## 7. Media

- Images only: PNG, JPEG, WebP, ≤ 10 MiB (`content-media` storage category). The size is
  checked before the bytes are read; the type and dimensions are read from the file's
  own header (`sniffImage`), never from the browser's declared type or the file name.
  SVG and anything unrecognized are rejected (`image_invalid`); dimensions over 20 000 px
  are treated as invalid.
- Upload goes through a server action (`experimental.serverActions.bodySizeLimit` is
  `11mb`; the service enforces the exact limit). The object is written first and removed
  if the database insert fails; deleting an asset removes the row and links in one
  transaction, then the object (a failure there is logged, never a dangling row).
- Served by `GET /api/w/{slug}/media/{assetId}` for members with `content.view`:
  stored (sniffed) content type, `X-Content-Type-Options: nosniff`,
  `Content-Security-Policy: default-src 'none'; sandbox`, inline disposition with an
  encoded file name, `Cache-Control: private, no-store`. Anonymous → 401, malformed id →
  400, foreign or unknown asset → 404.
- `STORAGE_DRIVER=test-memory` keeps objects in the server process for the end-to-end
  suite (like `MAIL_TRANSPORT=test-outbox`); the default is S3.

## 8. Calendar, dashboard and activity

- Times are stored in UTC and entered/shown in the **workspace time zone**
  (`workspaces.timezone`, default `Asia/Riyadh`; an unknown zone falls back to it).
  Conversion handles daylight saving time (a time skipped by a DST jump resolves after
  the jump). Calendar weeks start on Sunday. Week and day views, previous/next/today, and
  rescheduling in place (§4). Unpublished items are placed by `scheduled_at`, published
  ones by `published_at`; at most 300 items per period (a notice says when more exist).
- Dashboard: setup checklist (shown only for steps the role can do, hidden when done),
  content counts per status, scheduled in the next 14 days, recently updated content,
  active/planned campaigns and active goals, recent activity (`audit.view` only).
- Activity: the workspace audit trail as sentences (actor, action, status change,
  link to the record), newest first, cursor pagination; raw audit metadata is never shown.

## 9. Audit

Every mutation writes an audit row in the same transaction: `brand.created/updated`,
`audience.created/updated/deleted`, `goal.created/updated`, `pillar.created/updated`,
`campaign.created/updated/archived`, `content.created/updated/status_changed/deleted`,
`asset.created/updated/deleted`. Metadata holds changed **field names**, status
`from`/`to` and the transition — never brand text, content bodies or file contents.
Saves that change nothing write nothing.

## 10. i18n, RTL and UX

- New `marketing` namespace (plus `shell.nav.*` and validation codes) in `messages/ar.json`
  (source of truth) and `messages/en.json`, with Arabic plural forms; the key-parity and
  ICU-format tests cover them.
- Logical CSS only; directional icons mirror in RTL; URLs, file inputs and date/time
  fields are `dir="ltr"`; free text uses `dir="auto"`.
- Every page has empty, loading (`loading.tsx`), error (existing boundary), forbidden and
  not-found states. Layouts are responsive (single column on phones).
- Because workspace pages stream (loading state), a missing record renders Next's
  not-found page with HTTP 200 (soft 404) unless the workspace itself is foreign, which
  still returns 404 from the layout. No record data is rendered either way.

## 11. Deferred (not implemented)

| Item                                                                                                   | Why / where                                                          |
| ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| AI generation, AI Brand Brain, OpenAI reviewer                                                         | Phases 5–6 (explicitly out of scope)                                 |
| Social OAuth, social APIs, external/automatic publishing                                               | Phase 8+; "mark as published" is manual                              |
| Scheduled publishing jobs (Redis/BullMQ)                                                               | Phase 9; `SCHEDULED` is a planning state only                        |
| Analytics ingestion, competitors, Marketing Agent                                                      | Phases 10–13                                                         |
| Video and large file upload (direct-to-storage presigned uploads, processing)                          | Needs the media pipeline; images only now                            |
| Image processing (thumbnails, EXIF stripping, re-encoding)                                             | Media pipeline; images are served as uploaded under a sandboxing CSP |
| Brand logo upload                                                                                      | Can reuse the media library later                                    |
| Content comments/threads, versions, per-item approval history UI                                       | Later; the audit trail records every transition                      |
| Separation of duties (author ≠ approver)                                                               | Not required by the matrix; a MANAGER may approve own content        |
| Workspace time-zone setting UI                                                                         | Uses `workspaces.timezone` (default Asia/Riyadh)                     |
| Month calendar view, drag and drop                                                                     | Week/day views with in-place rescheduling                            |
| Stripe/billing, 2FA, session UI, account deletion, email change, ownership transfer, RLS, CSP redesign | Out of scope (later phases)                                          |

## 12. Accepted and deferred review findings

Recorded at the Phase 3 final review. None of them blocks completing Marketing Core OS,
and none changed the implementation.

| Severity | Finding                                                                                                                                                                    | Status                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Medium   | Media uploads have no per-user rate limit.                                                                                                                                 | **Deferred / accepted for Phase 3.** A workspace quota exists: at most 500 images per workspace, each at most 10 MiB (`MAX_MEDIA_ASSETS`, `content-media` category), checked on every upload together with `content.create`. Per-user upload throttling does not exist yet. It will be evaluated with abuse protection and production hardening in the Production/Growth phase. Not a blocker for Marketing Core OS. |
| Low      | Deleting an asset removes the row first and the stored object after the commit; if the storage call fails, the object is orphaned.                                         | **Accepted.** The failure is logged and the object is unreachable (no row points at it). A cleanup/purge job belongs with the production-hardening work.                                                                                                                                                                                                                                                             |
| Low      | A missing or foreign-id record inside a workspace the user belongs to renders the not-found page with HTTP 200 (soft 404), because workspace pages stream a loading state. | **Accepted.** No record data is rendered; a workspace the user is not a member of still returns HTTP 404 from the layout.                                                                                                                                                                                                                                                                                            |
| Low      | `SCHEDULED` is a planning state only; nothing is published automatically.                                                                                                  | **Deferred by design.** Automatic publishing needs the job runner (Redis/BullMQ) and social integrations, both out of Phase 3 scope (§11).                                                                                                                                                                                                                                                                           |

## 13. Tests

- Unit (`tests/unit/marketing-core.test.ts`): strict schemas, list parsing (Arabic comma),
  URL/date/budget rules, workflow tables, time zones and DST, calendar periods, image
  sniffing (PNG/JPEG/WebP variants, SVG/HTML/truncated/oversized), file-name sanitizing,
  minor units, storage driver.
- Integration (`tests/integration/marketing-services.test.ts`,
  `marketing-flow.test.ts`): CRUD and audit, cross-tenant IDOR for every id-taking
  operation, cross-tenant linking (service and database), tenant guard, full role matrix,
  per-transition permissions, concurrency, DB invariants, calendar/time zones, dashboard,
  activity pagination, media (sniffing, limits, cleanup), server actions with real
  sessions, injected keys, media route headers and access.
- E2E (`e2e/marketing.spec.ts`): the full English flow (brand → audience → pillar → goal →
  campaign → media → content → submit/approve/schedule → calendar → reschedule → publish →
  filters → dashboard → activity), the Arabic RTL flow, and cross-workspace access to
  records and media.
- Mutation testing of the security-sensitive logic: see the Phase 3 report.

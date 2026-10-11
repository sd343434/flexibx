# Flexibx — AI Marketing Employee: Revised Roadmap for Big Phases 4–6

**Status: PROPOSED — DESIGN ONLY — awaiting human approval.** No application code,
tests, schema, migrations, dependencies or runtime configuration were changed for this
document. Nothing here is implemented until a human approves it.

Prepared: 2026-10-09. Branch: `claude/amazing-sagan-pvouqy`.

**Revision 2026-10-09 (design correction, still PROPOSED):** generative AI video is a
**required Phase 4 capability**. The earlier recommendation to ship "assembled" video
(images + voice-over + FFmpeg) in Phase 4 and defer generative video to Phase 6 is
withdrawn everywhere in this document set. Social publishing stays in Phase 5 and
analytics/optimization in Phase 6. Paid-advertising automation remains an **open
phase-placement decision** (D12).

This is the entry point of the Phase 4–6 design set:

| Document                                                                       | Contents                                                                                                                                                       |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **This file**                                                                  | Product definition, phase scopes, dependencies, acceptance criteria, completion gates, risks, open decisions                                                   |
| [AI_MARKETING_EMPLOYEE_ARCHITECTURE.md](AI_MARKETING_EMPLOYEE_ARCHITECTURE.md) | Architecture, orchestration, media pipeline, publishing engine, data model, workflows                                                                          |
| [AUTOMATION_SAFETY_POLICY_MODEL.md](AUTOMATION_SAFETY_POLICY_MODEL.md)         | Execution categories A–D, permission and policy model, budget enforcement, kill switch, ambiguous publish outcomes                                             |
| [PROVIDER_INTEGRATION_COMPARISON.md](PROVIDER_INTEGRATION_COMPARISON.md)       | Provider and social-platform matrices with evidence labels and sources                                                                                         |
| [BUDGET_UNIT_ECONOMICS.md](BUDGET_UNIT_ECONOMICS.md)                           | Cost model, Starter/Growth/Heavy scenarios, unit economics, pricing implications, cost controls                                                                |
| [PHASES_4_6_PRODUCT_DESIGN.md](PHASES_4_6_PRODUCT_DESIGN.md)                   | Earlier proposal (competitive intelligence, paid advertising). Superseded at the product-vision level by this set; its CI and paid-ads analysis is reused here |

Evidence labels used in every document: **[Confirmed]** = read in the provider's own
official documentation or pricing page on the access date; **[Reported]** = third-party
sources, or an official page we could not open directly; **[Assumption]** = our planning
estimate, to be verified; **[Decision]** = needs human approval.

---

## 1. Repository baseline (inspected 2026-10-09)

| Item                        | Expected                                 | Actual                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Branch                      | `claude/amazing-sagan-pvouqy`            | same                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Published baseline (origin) | `117e266`                                | `117e266` — origin unchanged                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Local HEAD                  | `117e266`                                | **`7fb2d49`** — "feat: redesign workspace dashboard with flexibx brand identity". A local commit, made with explicit human approval on 2026-10-09 and **not pushed**. The dashboard/brand redesign therefore exists as a local commit, not as uncommitted work.                                                                                                                                                                                                        |
| Phases 1–3                  | Completed                                | Completed (`.phase-status.json` history and docs)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `.phase-status.json`        | Phase 4 IN_PROGRESS, implementation null | Same (uncommitted). Validates.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Phase 4 implementation      | Not assumed                              | **Partially implemented and uncommitted**, under the earlier approved Phase 4 design: `src/server/ai/*` (provider boundary, `disabled` and `fake` adapters, context builder, prompts, output schemas, service), the `ai_generations` table and migration `20261009064716_ai_engine`, AI Studio UI, the draft assist panel, a usage page, rate-limit buckets, and unit/integration/E2E tests. The quality gates were not completed; it was paused on human instruction. |
| Other uncommitted docs      | —                                        | `docs/PHASES_4_6_PRODUCT_DESIGN.md` (earlier design proposal)                                                                                                                                                                                                                                                                                                                                                                                                          |

**Preservation:** nothing was discarded, reset, staged or committed for this task. The
partial Phase 4 code is kept as-is. §5.4 proposes how it maps onto the revised Phase 4
and needs a human decision (D1).

## 2. Revised product definition

**Flexibx is an Arabic-first marketing operating system with an AI Marketing Employee**
that plans, creates, produces, publishes, monitors and optimizes a business's marketing
**within policies set by the workspace owner**.

The employee:

1. Understands the business, brand, audiences, offers, goals and constraints (Phase 3
   domain plus new Offer/Claim entities).
2. Proposes a strategy and campaign plan.
3. Builds a content calendar.
4. Writes captions, hooks, CTAs, scripts and briefs, in Arabic first and English too.
5. Produces images and **generative AI videos** through configured providers within
   budget.
6. Adapts assets per network and format.
7. Validates against brand rules, approved/forbidden claims, workspace policy and
   platform constraints.
8. Schedules and publishes through authorized integrations.
9. Monitors publishing and handles failures safely.
10. Retrieves performance data.
11. Compares results with goals.
12. Recommends — or, where a policy allows, executes — bounded optimizations.
13. Explains every action and reports to the owner.

**What it is not:** an unrestricted autonomous agent. It is a **deterministic workflow
engine** whose steps may call an AI model for generation and classification. Every
consequential step is a typed service call that passes authorization, policy, budget
and audit. The model is never the security layer.

### Execution categories (detailed in the safety model)

| Category               | Meaning                                                        | Examples                                                                                                                                                                                                                   |
| ---------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Automatic**      | Always allowed (within budget)                                 | ideas, drafts, calendars, brand/policy checks, reports, safe retries of transient failures, collecting authorized metrics, generating asset candidates within limits                                                       |
| **B — Policy-gated**   | Automatic **only** after the owner enables the specific policy | publishing approved content, generating assets under a budget, moving post times within windows, adjusting content mix, auto-pause on thresholds                                                                           |
| **C — Human approval** | Always needs an ApprovalRequest                                | spending above limits, budget increases, brand positioning changes, sensitive/regulated/legal/financial claims, high-risk complaints, any paid advertising unless a separate explicit paid policy exists                   |
| **D — Never**          | Impossible by construction                                     | bypassing auth, cross-workspace access, exposing secrets or private data, arbitrary code or shell, unauthorized purchases, disabling its own limits, raising its own permissions, publishing through unauthorized accounts |

## 3. Roadmap overview

```
Phase 4 — AI Marketing Employee Core
   gateway + orchestrator + marketing intelligence + text + images
   + GENERATIVE VIDEO (required, real provider, async jobs)
   + policy/budget foundations + generation history + approval inbox
        │ (job queue, assets, ledger, approvals are prerequisites)
Phase 5 — Social Publishing and Automation
   official integrations + encrypted connections + publishing engine + automation
   policies + kill switch in production + cross-platform workflows
        │ (published posts and connections are prerequisites)
Phase 6 — Intelligence, Optimization and Launch
   analytics ingestion + KPI tracking + controlled optimization + billing/plans
   + production readiness + launch; gated track: competitive benchmarking

Paid advertising automation: phase placement OPEN (D12) — Phase 6 track or Phase 7
```

Roadmap items brought forward from the Phase 1 plan: the background worker/queue
(planned for Phase 9) moves to **Phase 4**, token encryption with `ENCRYPTION_KEY`
(Phase 8) to **Phase 5**, and billing/plan limits (Phase 15) to **Phase 6**. The
ARCHITECTURE deferred table is updated only after approval.

---

## 4. Platform access track (starts at approval, no code)

App reviews are on the critical path and take weeks. They can be refused without a
detailed reason [Reported]. Start immediately after this design is approved:

- **Meta:** App Review for Pages publishing and Instagram content publishing, plus
  Business Verification.
- **TikTok:** Content Posting API audit. Until it passes, every post is forced to
  private (SELF_ONLY), with at most 5 posting users per 24 h [Confirmed].
- **LinkedIn:** Community Management API — Development tier, then Standard tier.
  Requires a verified organization, a verified Page, and a separate app [Confirmed for
  review steps].
- **Google:** YouTube Data API quota; app verification for the OAuth consent screen
  [Assumption].

Owner: a human (business entity, legal name, privacy policy, demo recordings). These
items are tracked as **[Decision] D8**.

---

## 5. Phase 4 — AI Marketing Employee Core

### 5.1 Scope

1. **Model gateway** (extends the implemented provider boundary). Provider-neutral
   interface; routing by task class (creative vs utility); structured outputs validated
   by schemas; normalized failures; timeouts, cancellation, at most one retry; usage
   capture; per-call cost estimate and budget reservation; one real text provider
   ([Decision] D2) plus the deterministic fake for tests.
2. **Workflow engine and orchestrator.** Versioned workflow definitions made of typed
   steps; a tool registry with typed inputs and outputs, a permission, a risk class, a
   cost estimator and idempotency; bounded execution (maximum steps, cost, duration and
   retries). No free-form agent loop: the only "planning" step returns a plan from a
   **closed set of task types**, validated by schema.
3. **Job queue + worker** (needed now, because media generation and rendering take
   minutes): recommended **pg-boss on the existing Postgres**, with transactional
   enqueue (outbox semantics) and a documented migration path to BullMQ/Redis
   ([Decision] D4).
4. **Marketing intelligence.** Reuses Phase 3 (Brand, Audience, MarketingGoal,
   ContentPillar, Campaign, ContentItem, MediaAsset) as the source of truth. New:
   **Offer** (products/services, price text, availability), **ClaimRule**
   (approved/forbidden claims and regulated categories), **BrandVisualGuide** (colors,
   fonts, logo asset, composition rules, prohibited imagery). The context contract is
   extended accordingly.
5. **Text generation.** Ideas, briefs, content calendar (a typed plan of dated
   ContentItem drafts), captions/hooks/CTAs, short-form video scripts, variations,
   platform adaptations (per-network length and hashtag rules), localization/translation
   ar↔en, brand and claim checks (rule-based plus AI classification, labelled).
6. **Image generation.** One image provider ([Decision] D3) behind a media gateway.
   Candidate sets (N per request, capped). Brand guide applied through prompt
   construction plus reference images where the provider supports editing/reference.
   Output validation (dimensions, aspect ratio, file type, size, safety flags where the
   provider returns them). Assets persisted through the existing StorageService and
   linked as MediaAsset with provenance (provider, model, generation id, cost,
   AI-generated flag).
7. **Generative AI video — required in Phase 4.** A real text-to-video and
   image-to-video provider ([Decision] D9; recommendation in
   PROVIDER_INTEGRATION_COMPARISON.md §3) behind a provider-neutral video gateway:
   - script/brief → shot prompts → **generated clips** (4–8 s each), with optional brand
     reference images (product photo, logo, style frame) for image-to-video;
   - **asynchronous jobs**: submit → poll → download → validate → post-process, with
     job/attempt state machines, bounded retries, unknown-outcome reconciliation, crash
     recovery and a fake provider for CI (architecture §4.2);
   - **quality tiers** DRAFT / STANDARD / PREMIUM mapped to provider models, each with
     a versioned rate card and a preflight cost estimate;
   - **technical post-processing only** (transcode, crop/pad to 9:16 · 1:1 · 4:5 ·
     16:9, loudness normalization, concatenation of generated clips, caption/logo/CTA
     overlay, thumbnails). Assembling videos from still images and voice-over is **not**
     an acceptable substitute or initial strategy and is not built;
   - the 7-day retention notice (`BeforeGenerationNotice`, ar/en, with the deletion date a
     video generated now would get) shown on the generation form before submission;
     files are deleted 168 h after generation (docs/AI_VIDEO_RETENTION_POLICY.md);
   - human acceptance in the review gallery before any clip can be attached to content;
     provenance (provider, model, job id, cost, AI-generated flag, provider watermark
     note) on every asset.
8. **Policy and budget foundations.** BudgetPolicy (per-generation caps, daily/monthly
   AI budget, image and generative-video sublimits per tier, video approval threshold,
   hard caps), UsageLedger with reservation → reconciliation,
   the policy evaluator (A/B/C/D), AutomationPolicy storage (used for real in Phase 5),
   and the workspace automation state (kill switch) enforced on every step.
9. **Generation history and usage.** AgentRun / WorkflowExecution / StepExecution,
   GenerationRequest, GeneratedAsset, UsageLedger entries, ApprovalRequest, and
   PolicyDecision records (data model in the architecture doc). Regeneration links
   to its parent request.
10. **Human interfaces.** Approval inbox (approve/reject with reason), run history with
    explanations, usage and budget page, kill switch control, asset review gallery
    (accept/reject candidates).

### 5.2 Out of scope (Phase 4)

Social publishing and OAuth connections (Phase 5); analytics ingestion and
optimization (Phase 6); competitive-intelligence collection; paid advertising (D12);
billing; **assembled image/voice-over video as a substitute for generative video**;
TTS voice-over (optional later, D5); voice cloning or likeness of real people; music
generation; videos longer than 60 s per request [Assumption]; more than one video
provider adapter in production (a second adapter is optional, D9).

### 5.3 Dependencies

Phase 3 domain (done); StorageService (done); a text provider account ([Decision] D2);
an image provider account (D3); **a generative-video provider account (D9) with
our own hard cap for the smoke test — **US$2.00 total**, all providers and runs combined (D16)**;
FFmpeg/ffprobe in the worker image for technical post-processing (Docker change,
approved during implementation); queue choice (D4).

### 5.4 Relationship to the partial implementation already in the tree

| Implemented (uncommitted)                                                                   | Revised Phase 4                                                                                                                                                                              |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider interface, `disabled`/`fake` adapters, timeout + single retry, error normalization | Kept as the model gateway core; adds routing, cost estimation, a real provider                                                                                                               |
| Context builder with handles, fenced untrusted data                                         | Kept; extended with Offer, ClaimRule, BrandVisualGuide                                                                                                                                       |
| `ai_generations` table (one row per generation, validated output, use-once)                 | Evolves into GenerationRequest + UsageLedger (+ StepExecution). Because nothing is committed, it can be reshaped before the first commit; the migration would be regenerated ([Decision] D1) |
| Ideas/brief/copy/assist operations, apply-to-draft                                          | Kept as Phase 4 text tools in the tool registry                                                                                                                                              |
| Rate limits 20/user/10 min, 100/workspace/h, daily cap 300                                  | Kept; daily cap generalized into BudgetPolicy                                                                                                                                                |
| AI Studio, assist panel, usage page                                                         | Kept; joined by approval inbox, run history, asset gallery                                                                                                                                   |
| (none — no video code exists in the partial implementation)                                 | Generative video gateway, fake video provider, job/attempt tables, queues and review gallery are **new Phase 4 work**; the existing provider boundary and budget lock pattern are reused     |

### 5.5 Acceptance criteria (Phase 4)

- **P4-AC1** Every AI call goes through the gateway. A static test proves no vendor SDK
  import exists outside `src/server/ai/providers/*`.
- **P4-AC2** Every model output is validated by its schema before storage; malformed,
  empty, oversized, unknown-field and bad-enum outputs are rejected (unit matrix covers
  all task types).
- **P4-AC3** Workflow runs are bounded: a run exceeding max steps, max cost or max
  duration stops with status `LIMIT_REACHED` (tests per bound).
- **P4-AC4** Tool registry: a step can only call registered tools; an unknown tool name
  in a plan is rejected before execution (test).
- **P4-AC5** Budget: no generation starts without a successful reservation. Concurrent
  requests never exceed the daily or monthly budget (DB concurrency test with ≥8
  parallel requests). The ledger reconciles reserved vs actual within one run.
- **P4-AC6** Image generation produces N candidates (N ≤ cap); each persisted asset
  records provider, model, cost, request id, workspace and the AI-generated flag; cross-
  workspace reads return 404 (test).
- **P4-AC7 — Real generative provider produces a video (within US$2.00).** Allowed
  only after the owner approves D9 and the D16 plan, and after preconditions S1–S8 in
  PROVIDER_INTEGRATION_COMPARISON.md §3.5.1 are met. In one protected run against the
  real provider, with the fake provider **disabled**:
  1. **one text-to-video request** (proposed: Veo 3.1 Lite, 4 s, 720p, audio off, one
     output) produces a clip **generated by the provider's model**, in at most 3
     attempts;
  2. every attempt reserved its worst case (duration × verified rate × 1 output ×
     tax margin) in the US$2.00 smoke ledger **before** submission, and no submission
     happened when the remainder could not cover the next attempt;
  3. the clip is downloaded before its provider URL expires, stored through
     StorageService under the workspace prefix, and its SHA-256 recorded;
  4. the clip passes ffprobe validation: MP4, H.264/H.265, duration within ±0.5 s,
     requested resolution/aspect ratio, no audio stream;
  5. the GeneratedAsset records provider, model id, provider operation id, tier,
     seconds, resolution, audio flag, attempt number, rate-card version (with the
     official source URL), captured cost and the AI-generated flag;
  6. 9:16 and 1:1 versions are produced by technical post-processing only;
  7. the provider's billed amount is reconciled with the ledger once billing data is
     available. **Total billed ≤ US$2.00**, and any billed amount above the
     reservation stops further paid tests.

  Image-to-video is proven with the fake provider and a payload dry run. A paid
  image-to-video run is **not** part of P4-AC7 unless separately approved and fully
  covered by the remaining budget. A run using the fake provider or an image/voice-over
  assembly does **not** satisfy P4-AC7.

- **P4-AC8** Category C actions create an ApprovalRequest and never execute without an
  approval; category D actions do not exist in the tool registry (schema test).
- **P4-AC9** Kill switch: when the workspace automation state is STOPPED, no new step
  starts (checked at enqueue, dequeue and before each tool call); in-flight history is
  preserved (integration test).
- **P4-AC10** Arabic-first: every new screen has ar/en messages with key parity; RTL/LTR
  E2E checks for the approval inbox, run history and asset gallery.
- **P4-AC11** Generation history shows, per run, the steps, tools, costs, policy
  decisions and approvals — without prompts or secrets in audit metadata (test).
- **P4-AC12 — Async job lifecycle.** VideoGenerationJob and VideoGenerationAttempt
  follow the state machines in architecture §4.2.2: every legal transition is covered
  by a unit test, every illegal transition is rejected (unit + mutation tests), and an
  attempt row exists in `INTENDED` before any provider call (integration test with a
  spy adapter).
- **P4-AC13 — Failure handling** (fake provider, one integration test per row of
  architecture §4.2.4):
  - a provider-queued/throttled state consumes no attempt;
  - a submit timeout leads to OUTCOME_UNKNOWN and reconciliation, with **zero** blind
    resubmissions, and the reservation stays held;
  - a provider failure is retried at most `maxAttempts − 1` times;
  - a safety refusal is never retried automatically and shows a reason;
  - exceeding `maxWallTime` ends in TIMED_OUT, and a late result is still recorded;
  - a download failure retries the download only, with zero new submissions;
  - an output failing validation is retried within `maxAttempts`, then FAILED;
  - a worker killed mid-poll resumes the same provider job id with no new submission.
- **P4-AC14 — Budget and hard caps.**
  - No submission happens without a reservation of `seconds × tierRate × maxAttempts`.
  - 8+ concurrent video requests never exceed the per-request, daily or monthly video
    cap; refused requests show the cap reached.
  - Failed attempts are captured as charged unless the provider reports otherwise.
  - Releases happen only for terminal, known outcomes.
  - The operator per-provider daily ceiling pauses the route for all workspaces (DB
    concurrency + unit tests).
- **P4-AC15 — Policy and approval.**
  - `video.generate` is DENIED when the policy is disabled.
  - It requires an ApprovalRequest above the per-request threshold, for the PREMIUM
    tier, or when the risk classifier flags a real person, minor, third-party brand or
    regulated claim.
  - Approval re-checks the budget at execution.
  - A clip cannot be attached to a ContentItem until a human accepts it (tests).
- **P4-AC16 — Kill switch for video.** With the workspace STOPPED or the platform flag
  "disable video generation" on:
  - no submission occurs;
  - queued jobs become CANCELLED;
  - already-submitted attempts are polled read-only, so cost and output are still
    recorded (integration test).
- **P4-AC17 — Audit.** `video.requested`, `video.approved`/`video.rejected`,
  `video.submitted`, `video.succeeded`, `video.failed`, `video.accepted` and
  `video.cancelled` are audited with ids, tier, seconds, cost and policy version — and
  without prompts, provider URLs or secrets (test).

### 5.6 Security criteria (Phase 4)

Tenant guard registration for every new model; same-workspace triggers on every
cross-entity FK; provider keys only in server env and never logged (redaction tests);
prompt-injection fencing for all workspace text; output IDs never trusted (handle
mapping); asset URLs only via the access-checked media route; the worker uses the same
guarded client and TenantContext (no system client in tool code).

### 5.7 Test requirements

Unit (gateway, schemas, policy evaluator, cost estimator, workflow bounds, tool
registry); integration (runs end to end with fake providers, concurrency of budgets,
approvals, kill switch, isolation, worker crash/resume); E2E (generate → review assets →
approve → draft, ar/en; request video → review clip → accept, with the fake provider);
mutation testing on the policy evaluator, budget reservation, tool-registry
authorization and the video state machines (existing methodology); a fake video
provider with scripted scenarios for every failure in architecture §4.2.4; the
real-provider smoke suites for text, image and **video (P4-AC7)** run manually or in a
protected CI job with spend limits ([Decision] D10, D16). Paid video smoke tests are
off by default and capped at US$2.00 in total. Before any paid run, the no-spend
validation plan (provider doc §3.5.6) must pass.

### 5.8 Cost implications

Variable: text, image and **generative video** per workspace. Generative video is the
largest and least certain line. See BUDGET_UNIT_ECONOMICS.md:

- expected cost ≈ US$0.60 (DRAFT), US$1.44 (STANDARD) or US$4.80 (PREMIUM) per
  delivered 8 s clip [Reported prices × Assumption of 1.5 attempts];
- proposed included monthly video caps US$5 / US$20 / US$80 per plan.

Fixed: worker capacity for polling and post-processing (CPU). Phase 4 verification
spend: **hard cap US$2.00 in total** for all paid video smoke tests (D16). The planned
spend is ≈ US$0.20–0.23 (one 4 s Lite clip), with a worst case of US$0.69 (3 attempts
incl. tax margin).

### 5.9 Risks

- **Provider Arabic quality.** Mitigation: an evaluation set and human rating before
  selection.
- **Image and video brand consistency.** Mitigation: reference images, image-to-video,
  overlays rendered by us, the review gallery.
- **Generative video cost variance.** Prices are reported, not confirmed; attempts per
  accepted clip are unknown. Mitigation: worst-case reservation, tier caps, hard
  monthly caps, the operator ceiling and the US$2.00 smoke cap (D16).
- **Video latency** (minutes per clip). Mitigation: async jobs, progress UI,
  per-provider concurrency.
- **Provider safety refusals and regional limits** (e.g. reported MENA/EU limits on
  person generation). Mitigation: prompt pre-checks, explicit refusal reasons, no auto
  retry.
- **Native generated speech in Arabic is unverified.** Mitigation: an evaluation clip
  set; captions rendered by us; silent output with captions as a supported option.
- **Provider lock-in or price change.** Mitigation: the provider-neutral gateway and a
  versioned rate card; an optional second adapter (D9).
- **Scope.** Mitigation: ship in the order gateway/budget → text → images → video jobs
  (fake) → real video provider. All of them are inside Phase 4.

### 5.10 Completion gate (Phase 4)

All P4-AC criteria pass; the full quality gates pass (phase validation, typecheck, lint,
format, unit, integration, build, E2E, DB validation, migrations, Docker, gitleaks,
mutation); the security review has no open High/Critical findings; real-provider smoke
tests are run with recorded cost, **including the P4-AC7 generative video evidence**;
total paid video verification spend ≤ US$2.00 (D16), reconciled against the provider bill; Phase 4 doc + ARCHITECTURE updated;
human approval. Phase 4 cannot be completed without a real generative-video run (unless
the owner changes this gate, D18).

---

## 6. Phase 5 — Social Publishing and Automation

### 6.1 Scope

1. **Integrations, by verified access and value** ([Decision] D6):
   (1) Meta — Facebook Pages + Instagram professional accounts; (2) TikTok — Content
   Posting API (public posting only after the audit; inbox upload before it);
   (3) YouTube — Shorts via `videos.insert`; (4) LinkedIn — organization pages via the
   Community Management API, after approval; X is optional (paid per post [Reported]).
   Snapchat has no organic publishing API [Reported], so it is excluded.
2. **SocialConnection** per workspace and account. OAuth; tokens encrypted at rest
   (AES-256-GCM with `ENCRYPTION_KEY`, envelope encryption with a KMS as [Decision] D7);
   scopes recorded; refresh before expiry; revocation and deauthorization webhooks;
   health status. Organic and advertising connections are separate types.
3. **Publishing engine.** PublishingJob state machine; idempotency keys; per-platform
   adapters (media upload, container/processing polling, publish); scheduling in the
   workspace time zone; retries with backoff; a dead-letter queue; duplicate-publish
   prevention; partial-failure recovery for multi-network releases; status reconciliation
   for uncertain outcomes; per-platform audit history.
4. **Automation policies** (owner-configured, versioned): allowed accounts, content
   types, posting windows, daily/weekly limits, AI and media budgets, approval
   requirements, forbidden topics and claims, emergency stop conditions, maximum retries
   and failure thresholds.
5. **Workflows** (typed definitions): new campaign → strategy → calendar → copy/assets →
   validation → schedule → publish; product launch; failed post → classify → safe retry
   or escalation; monthly report → next month's plan (report v1).
6. **Observability for publishing:** queue depth, job age, failure rate per platform,
   token health, reconciliation backlog, alerts.
7. Phase 3 `SCHEDULED` becomes a real, executed schedule (it is planning-only today).

### 6.2 Out of scope (Phase 5)

Paid advertising (D12); new media-generation capabilities (video generation is
already in Phase 4; Phase 5 publishes accepted clips); cross-platform analytics
dashboards (only publish status and basic per-post metrics); comment/DM automation (responses are category C and
deferred); competitor collection beyond what Phase 6 defines.

### 6.3 Dependencies

Phase 4 queue/worker, assets, budget ledger, approvals, kill switch; platform approvals
(§4); `ENCRYPTION_KEY` management (D7); a public HTTPS callback domain for OAuth and
webhooks.

### 6.4 Acceptance criteria (Phase 5)

- **P5-AC1** OAuth connect/disconnect per platform; tokens encrypted at rest. A DB
  inspection test shows no plaintext token; tokens never appear in logs, audit or
  prompts (redaction tests).
- **P5-AC2** Token refresh happens before expiry; a revoked or expired token marks the
  connection `NEEDS_REAUTH` and blocks its jobs (test with a fake platform).
- **P5-AC3** Exactly-once publishing semantics: a job retried after a timeout **never
  double-posts** in the fake-platform test that "succeeds, then times out". The job
  enters `NEEDS_RECONCILIATION` and resolves by reading platform state.
- **P5-AC4** Policies are enforced. No publish outside the windows, beyond the
  daily/weekly limits, to an unallowed account, or of a disallowed content type —
  including under N concurrent scheduled jobs.
- **P5-AC5** Platform caps are respected (e.g. Instagram's per-account 24 h publishing
  limit, read from `content_publishing_limit` [Confirmed endpoint]); the engine defers
  rather than fails.
- **P5-AC6** The kill switch cancels queued jobs within 60 s and blocks new ones; jobs
  already submitted are reconciled, not abandoned; history is intact (integration test).
- **P5-AC7** Dead-letter jobs are visible in the UI with a classified reason and
  "retry"/"discard" actions (approval-gated for category C).
- **P5-AC8** Multi-network release with one failure publishes the others and reports a
  partial result; no automatic retry of the succeeded ones (test).
- **P5-AC9** Every publish attempt is audited: actor (person or employee under policy
  version), connection, platform, external id, outcome.

### 6.5 Security criteria (Phase 5)

Encrypted credential storage with key rotation documented; least-privilege scopes;
OAuth state and PKCE where supported; webhook signature verification; per-workspace
connection isolation (tenant guard + same-workspace triggers); outbound host allow-list
for adapters; no browser automation.

### 6.6 Test requirements

Contract tests per platform adapter against recorded fixtures; fake-platform simulation
for timeouts, 429s, partial success and revoked tokens; concurrency tests for limits;
E2E connect (sandbox/test accounts where the platform provides them) → schedule →
publish (fake in CI; real in a manual release checklist).

### 6.7 Cost implications

Publishing APIs for Meta, TikTok, YouTube and LinkedIn have no listed per-call fee
[Reported]; X charges per post [Reported]. Video upload egress and storage grow with
volume. YouTube upload quota (~1,600 units per upload of a default 10,000/day [Reported])
caps uploads per project per day until a quota extension is granted.

### 6.8 Risks

Review refusal or delay; TikTok private-only until the audit; API changes (Instagram
metrics already changed in 2025 [Confirmed]); token expiry storms; duplicate posts from
ambiguous timeouts (mitigated by reconciliation).

### 6.9 Completion gate (Phase 5)

All P5-AC criteria pass; at least one platform passes its production app review and
publishes publicly in a pilot workspace; reconciliation chaos tests pass; the full
quality gates pass; human approval.

---

## 7. Phase 6 — Intelligence, Optimization and Launch

### 7.1 Scope

1. **Analytics ingestion:** per-platform metric snapshots (append-only, freshness
   tracked), campaign-level and cross-platform summaries, KPI tracking against
   MarketingGoal, historical and format comparisons, explicit data-quality states
   (missing, stale, estimated), attribution limitations stated in the UI. No revenue
   attribution without commerce/website/conversion integrations.
2. **Controlled optimization loop:** collect → analyze → propose → policy check →
   execute if authorized → measure. Allowed autonomous levers (category B): timing within
   windows, content mix within campaign goals, choice among approved creative variants.
   Never autonomous: spend increases, brand changes (category C).
3. **Video performance optimization** (generation itself is in Phase 4): compare
   video vs image performance and tier vs outcome from collected metrics; recommend
   tier/format mixes. Any change that increases video spend is category C.
4. **Competitive intelligence benchmarking** (from the earlier proposal): registry,
   lawful sources only (YouTube Data API, Instagram Business Discovery after review,
   user-supplied data), evidence-labelled insights.
5. **Billing and plans:** subscription tiers with allowances, overages, hard limits and
   usage visibility (Stripe or a regional processor, [Decision] D11).
6. **Production readiness:** observability (errors, traces, metrics, logs), usage and
   cost accounting dashboards, abuse protection, rate limiting at the API edge, data
   retention and deletion, backup and restore drills, provider outage handling, queue
   monitoring, incident response runbooks, workspace isolation review (incl. Postgres
   RLS evaluation), privacy and compliance review (Saudi PDPL; GDPR where applicable),
   onboarding, support tooling, launch checklist.
7. **Paid advertising automation — phase placement OPEN ([Decision] D12).** If it is
   placed in Phase 6, it is a separately gated track (Meta → Snapchat → Google Ads →
   TikTok) under its own spend policy (AUTOMATION_SAFETY_POLICY_MODEL.md §6.1). If it
   is placed in Phase 7, Phase 6 keeps only the policy hooks. No option is assumed
   until a human decides.

### 7.2 Out of scope (Phase 6, unless D12 places paid advertising here)

Autonomous ad spending; revenue attribution without integrations; voice cloning of
real people; marketplace of third-party templates.

### 7.3 Dependencies

Phases 4–5; platform analytics permissions (e.g. Instagram insights permission, YouTube
Analytics API) [Assumption — verify per platform]; billing processor; legal review.

### 7.4 Acceptance criteria (Phase 6)

- **P6-AC1** Metric snapshots record platform, metric name, value, observed_at, window
  and source version; a missing metric shows "not available" rather than zero (UI test).
- **P6-AC2** KPI progress per goal is computed only from available metrics, and the data
  basis is shown (test with partial data).
- **P6-AC3** Optimization actions run only when the policy enables them; each records
  the hypothesis, the action, the policy decision and the measured outcome after the
  evaluation window (integration test with a fake clock).
- **P6-AC4** No optimization changes spend or brand fields (policy evaluator mutation
  tests).
- **P6-AC5** Plans: allowances are enforced at reservation time; overage requires
  opt-in; hard limits stop paid generation with a clear message (tests).
- **P6-AC6** Backup restore drill completed and documented; RPO/RTO targets met
  ([Decision] D13).
- **P6-AC7** Incident runbooks exist for provider outage, platform API outage, queue
  backlog, token compromise and cost spike; one game-day exercise is recorded.
- **P6-AC8** Data deletion: deleting a workspace removes content, assets, tokens and
  metrics within the documented window; audit records are kept per retention policy
  (test + runbook).
- **P6-AC9** Video performance: video metrics (views, watch time where the platform
  provides them) are tracked per tier and format with data-quality states; tier/format
  recommendations never raise video spend without an approved category C request
  (tests).

### 7.5 Security criteria (Phase 6)

Penetration test or structured security review before launch; RLS decision implemented
or explicitly deferred with reasons; secrets rotation runbook; abuse detection (bursts,
repeated policy denials, unusual cost); DPA/sub-processor list published.

### 7.6 Completion gate (Phase 6)

All P6-AC criteria pass; launch checklist signed off; pilot customers run ≥30 days with
no Critical incident and cost per workspace within the model's band; human approval.

---

## 8. Cross-phase risks (highest first)

| #   | Risk                                            | Type        | Mitigation                                                                        |
| --- | ----------------------------------------------- | ----------- | --------------------------------------------------------------------------------- |
| R1  | Social API approvals delayed or refused         | Platform    | Start reviews now; L1 fallbacks (drafts, inbox upload); multiple platforms        |
| R2  | Duplicate or lost publishes on timeouts         | Reliability | Reconciliation state, idempotency keys, never retry blind                         |
| R3  | Media cost variance (generative video)          | Economics   | Worst-case reservation, tier caps, hard monthly caps, operator ceiling, rate card |
| R4  | Arabic quality (text and speech, dialects)      | Product     | Evaluation sets, native-speaker review, provider choice per task                  |
| R5  | Autonomous action causing brand harm            | Safety      | Category A–D model, approvals, claim rules, kill switch                           |
| R6  | Workspace isolation regressions in workers      | Security    | Same guarded client in workers; isolation tests per new model; RLS evaluation     |
| R7  | Provider commercial terms and regions for media | Legal       | Terms review per provider before selection (D3, D9); no paid use before review    |
| R8  | Analytics metric changes and gaps               | Data        | Versioned metric mapping; data-quality states                                     |
| R9  | Regulatory (claims, disclosures, PDPL)          | Legal       | Legal review gates; ClaimRule enforcement                                         |

## 9. Open decisions requiring human approval

| ID  | Decision                                                                                                                                   | Recommendation                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| D1  | Reuse and reshape the uncommitted partial Phase 4 code as the core of the revised Phase 4 (regenerating its migration), or discard it      | Reuse and reshape before the first commit                                                           |
| D2  | Text model provider(s) for Arabic-first generation                                                                                         | Shortlist 2, run an Arabic evaluation set; choose by quality, cost, data terms                      |
| D3  | Image provider for Phase 4                                                                                                                 | Shortlist 2–3; decide after a brand-consistency and commercial-terms review                         |
| D4  | Queue: pg-boss (Postgres) vs BullMQ (Redis) vs managed SQS                                                                                 | pg-boss for Phases 4–5; revisit at sustained >~1,000 jobs/s [Reported rule of thumb]                |
| D5  | TTS provider (optional, **not** on the Phase 4 critical path)                                                                              | Defer; revisit if native generated audio is not good enough in Arabic                               |
| D6  | Platform order for Phase 5                                                                                                                 | Meta → TikTok → YouTube → LinkedIn; X optional; Snapchat excluded (no organic API)                  |
| D7  | Key management: env key only vs KMS envelope encryption                                                                                    | KMS envelope encryption before production                                                           |
| D8  | Who owns platform app reviews (legal entity, policies, demo videos)                                                                        | Start immediately after approval                                                                    |
| D9  | **Generative video provider for Phase 4 (required)**                                                                                       | Google Veo 3.1 (Vertex AI) primary, Runway API as alternative — see provider doc §3.4               |
| D10 | Real-provider test policy in CI (spend-capped protected job)                                                                               | Manual or protected job with a hard spend cap                                                       |
| D11 | Billing processor and currency (USD/SAR), tax handling                                                                                     | Decide before Phase 6 starts                                                                        |
| D12 | Paid-advertising automation: Phase 6 track or Phase 7                                                                                      | **Open** — no recommendation adopted; human decides                                                 |
| D13 | RPO/RTO targets and hosting region (data residency)                                                                                        | Decide before Phase 6                                                                               |
| D14 | Subscription tiers, allowances and prices (see the budget doc)                                                                             | Validate with pilot customers                                                                       |
| D15 | New permission actions (e.g. `automation.manage`, `publishing.approve`, `connections.manage`, `budget.manage`, `automation.stop`)          | Approve the list in the safety model §3                                                             |
| D16 | Paid video smoke test (owner-set hard cap **US$2.00 total**, all providers and runs) — approve provider and test plan                      | Veo 3.1 Lite, one 4 s 720p silent text-to-video clip, ≤ 3 attempts, after S1–S8; off until approved |
| D17 | Video tiers, rate card and included monthly video caps per plan (budget doc §1.2, §3)                                                      | Approve as provisional; re-baseline after the P4-AC7 run with real billed cost                      |
| D18 | If the US$2.00 cap cannot be shown enforceable (S1–S8 unmet): keep P4-AC7 as a Phase 4 completion requirement and wait, or change the gate | Keep the gate; run the no-spend plan now; decide after verification                                 |

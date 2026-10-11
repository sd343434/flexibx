# Flexibx — AI Marketing Employee Architecture (Proposed)

**Status: PROPOSED — DESIGN ONLY.** No code, schema or migration exists for anything in
this document beyond the partial Phase 4 work described in the roadmap (§1, §5.4).
Prepared 2026-10-09. Evidence labels as in [the roadmap](AI_MARKETING_EMPLOYEE_ROADMAP_4_6.md).

## 1. Design principles

1. **Deterministic workflows, bounded AI steps.** A workflow is a versioned definition of
   typed steps. AI models generate or classify _inside_ a step; they never choose
   arbitrary tools, URLs or code.
2. **Typed tools are the only way to act.** Every consequential operation is a
   registered tool with a schema-validated input and output, a required permission, a
   risk class (A/B/C/D), a cost estimator and an idempotency rule. Tools call the
   existing services (Phase 3 content services, StorageService, …); they never write to
   the database directly or call un-registered external hosts.
3. **Policy before execution.** Each tool invocation passes authorization → policy
   evaluation → budget reservation → execution → audit.
4. **Everything is recorded.** Runs, steps, decisions, approvals, costs and external
   outcomes have durable records; prompts and secrets are not in the audit log.
5. **Reuse the Phase 1–3 foundations:** tenant guard, permission matrix, AppError
   codes, audit log, StorageService, workspace time zone, ar/en messages, and the Phase 4
   provider boundary.

## 2. Component view

```
                ┌──────────────────────── Web app (Next.js) ───────────────────────┐
 Owner/Team ──▶ │ AI Studio · Calendar · Approvals inbox · Runs · Assets ·          │
                │ Connections · Policies · Usage/Budget · Reports · Kill switch     │
                └───────────────┬─────────────────────────────────────────────────┘
                                │ server actions (withAction + requireWorkspaceAccess)
                ┌───────────────▼─────────────────────────────────────────────────┐
                │ Application services (trusted)                                   │
                │  Orchestrator ─▶ Workflow engine ─▶ Tool registry ─▶ Tools       │
                │        │                │                │                       │
                │        │         Policy evaluator   Budget service (ledger)       │
                │        │                │                │                       │
                │  Marketing context   Approval service   Audit / execution history │
                └───┬───────────┬──────────────┬──────────────┬──────────────────┘
                    │           │              │              │
          ┌─────────▼──┐ ┌──────▼──────┐ ┌─────▼───────┐ ┌────▼────────────┐
          │ Model      │ │ Media       │ │ Publishing  │ │ Analytics        │
          │ gateway    │ │ gateway +   │ │ engine +    │ │ ingestion        │
          │ (text)     │ │ video gw +  │ │ platform    │ │ (snapshots)      │
          └─────┬──────┘ │ post-proc.  │ │ adapters    │ └────┬────────────┘
                │        └──────┬──────┘ └─────┬───────┘      │
         AI providers  Image/video providers Social APIs   Social analytics APIs
                │               │              │              │
                └───── Job queue + workers (pg-boss proposed) ─┘
                           │
                    PostgreSQL (tenant-guarded) · Object storage (S3/R2)
```

Workers run the same code as the web app (a second entrypoint, `src/worker/`, reserved
in Phase 1), use the same guarded Prisma client, and always act under a reconstructed
`TenantContext` with an actor = the person who started the run, or the employee acting
under a named policy version.

## 3. AI orchestration

### 3.1 Model gateway (text)

- Interface (exists, extended): `generate({ taskClass, operation, language, system, user,
schema, maxOutputTokens, signal })` → `{ text, provider, model, usage }`.
- **Routing table** (configuration, not code paths): `taskClass` → provider/model
  (e.g. `creative` → higher-quality model; `utility` → cheaper model for classification,
  adaptation and validation). Routing is versioned; each GenerationRequest stores the
  route version used.
- **Structured outputs:** a JSON schema is sent where the provider supports it; the
  server always re-validates with Zod (the provider's own validation is never trusted).
- **Failures:** normalized to `timeout | unavailable | rate_limited | refused |
invalid_output` (implemented). At most one retry, only for timeout/unavailable
  (implemented). An optional fallback route to a second provider is a configuration
  decision ([Decision] D2).
- **Budget hook:** before the call, `estimateCost(route, inputTokens, maxOutputTokens)`
  reserves the worst case in the UsageLedger; after the call, actual usage reconciles it.
- **Cancellation:** AbortSignal per call; a run cancel or the kill switch aborts in-flight
  calls where the provider SDK supports it, and always discards late results.

### 3.2 Workflow engine

- `WorkflowDefinition` (code, versioned): ordered or DAG steps, each step =
  `{ id, tool, inputMapping, retryPolicy, timeout, requiresApproval?, onFailure }`.
- `WorkflowExecution` (DB): state `QUEUED → RUNNING → WAITING_APPROVAL → RUNNING →
SUCCEEDED | FAILED | CANCELLED | LIMIT_REACHED | STOPPED`.
- `StepExecution` (DB): state `PENDING → RESERVED → RUNNING → SUCCEEDED | FAILED |
SKIPPED | NEEDS_RECONCILIATION`; idempotency key =
  `hash(executionId, stepId, attempt-independent input)`.
- **Bounds per execution:** max steps (e.g. 50), max total cost (reserved from the
  budget at start, topped up only within policy), max wall time, max retries per step
  (1 for transient), max fan-out (e.g. 10 parallel children). Exceeding any bound →
  `LIMIT_REACHED`.
- **Resumability:** each step's output is persisted; a worker crash resumes from the
  last completed step; steps with external side effects use reconciliation instead of
  re-execution (§6.5).

### 3.3 Orchestrator and planning

The orchestrator turns an owner's objective (free text, ar/en) into a typed
`MarketingPlan`. Free text is **never executed**:

1. `IntakeStep` (AI, utility): free text → `ObjectiveIntake` schema (goal type,
   offer(s), audiences, period, channels, constraints, budget envelope). Missing fields
   are asked back to the human.
2. `PlanStep` (AI, creative): intake + context → `MarketingPlan` = list of
   `PlannedTask` from a **closed enum** (`CreateCalendar`, `DraftContent`,
   `GenerateImages`, `GenerateVideo`, `AdaptForPlatform`, `ValidateContent`,
   `SchedulePost`, `Report`, …), each with parameters validated by its own schema and
   linked to existing records by **handles** that map server-side to ids.
3. `ReviewStep` (human, category C by default for the first plan of a campaign):
   approve all / edit / reject.
4. `ExecuteStep`: each PlannedTask becomes child WorkflowExecutions through the tool
   registry and policies.

### 3.4 Tool registry (examples)

| Tool                                                                                                                | Category                                       | Permission                    | Notes                                        |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------- | -------------------------------------------- |
| `text.generateIdeas` / `text.generateBrief` / `text.generateCopy` / `text.adapt` / `text.translate` / `text.script` | A                                              | content.create                | Exists in part (Phase 4 partial)             |
| `content.createDraft` / `content.applySuggestion`                                                                   | A                                              | content.create / content.edit | Through Phase 3 services, DRAFT only         |
| `calendar.proposeSchedule`                                                                                          | A                                              | content.create                | Creates DRAFTs with planned times            |
| `check.brandAndClaims`                                                                                              | A                                              | content.view                  | Rules + AI classification, labelled          |
| `image.generateCandidates`                                                                                          | A within budget, B above the default allowance | content.create                | Budget reservation                           |
| `video.generate`                                                                                                    | B (policy); C above thresholds (§4.2.9)        | content.create                | Phase 4, required; async job, preflight      |
| `video.postprocess`                                                                                                 | A (no provider cost)                           | content.create                | FFmpeg on generated clips only (§4.2.7)      |
| `publish.schedule` / `publish.now`                                                                                  | B (policy) or C                                | publishing.approve (new)      | Phase 5                                      |
| `metrics.collect`                                                                                                   | A                                              | analytics.view                | Phase 6                                      |
| `optimize.retime` / `optimize.mix`                                                                                  | B                                              | publishing.approve            | Phase 6                                      |
| `budget.increase` / `policy.change` / `connection.add`                                                              | **not tools**                                  | owner UI only                 | Category C/D: never callable from a workflow |

### 3.5 Marketing context assembly

Extends the implemented contract (deterministic, bounded, fenced as untrusted data,
handles instead of ids). Sources: Brand, BrandVisualGuide (new), Audience, Offer (new),
ClaimRule (new), MarketingGoal + KPI, ContentPillar, Campaign (+ budget metadata),
ContentItem history (titles/types/dates, the last N bodies for style), approved
examples. Each context block records its source table and freshness. Sensitive fields
(people's emails, tokens, costs) are never included.

## 4. Media production

### 4.1 Image pipeline

`image.generateCandidates(request)`:

1. Build the prompt from the brief + BrandVisualGuide (colors, composition, prohibited
   imagery); attach reference images (logo/product photos from the media library) only
   if the provider supports references [verify per provider].
2. Reserve the budget (N × unit price for the requested size/quality).
3. Call the media gateway (provider-neutral; per-provider adapter).
4. Validate each output: MIME sniffing (existing `sniffImage`), dimensions vs the target
   format, file size, provider safety flags, optional OCR check that no unintended text
   appears [Assumption — evaluate].
5. Persist via StorageService under `workspaces/{id}/generated/{uuid}.{ext}`; create a
   `GeneratedAsset` (provenance, cost, status CANDIDATE) and, when accepted, a Phase 3
   `MediaAsset` linked to it.
6. Reconcile the actual cost.

Formats (initial): 1080×1080 (1:1), 1080×1350 (4:5), 1080×1920 (9:16), 1920×1080 (16:9).
Platform-specific crops/resizes are deterministic image operations (no AI cost).

### 4.2 Generative video pipeline (Phase 4 — required)

Generative video is a **required Phase 4 capability**. The video frames are rendered
by a real text-to-video / image-to-video model behind a provider-neutral **video
gateway**. Assembling slideshows from images plus voice-over is **not** an acceptable
substitute or starting strategy, and it is not built in Phase 4. FFmpeg is used only
for **technical post-processing** of generated clips (§4.2.7).

#### 4.2.0 Implementation status (fake provider core)

Implemented with the deterministic **fake provider only** (`VIDEO_PROVIDER=fake`;
refused in production; default `disabled`). No real provider, network call or spend
exists. Code: `src/server/ai/providers/video/` (gateway, fake),
`src/server/videos/generation/` (MP4 validation, state machine, budget, service,
runtime); migration `20261010110000_video_generation_core`.

- **Implemented:** request validation; reservation of the worst case
  (`seconds × tier rate × maxAttempts`) under the workspace row lock against a per-UTC-day
  workspace budget and a per-request ceiling; `VideoGenerationJob` /
  `VideoGenerationAttempt` with transitions enforced in code and by database triggers;
  INTENDED written before submit; reconciliation of unknown submit outcomes through
  `findByClientRef` (never a blind resubmission; held reservation and
  `NEEDS_RECONCILIATION` when the provider cannot answer); retry rules of §4.2.4;
  wall-time bound; download-only retries; structural MP4 validation (§4.2.6, without
  ffprobe); storage through the write target with `confirm(tx)` and
  `recordGeneratedVideo` in one transaction (168 h retention applies); append-only usage
  ledger (RESERVE/CAPTURE/RELEASE); run lease and crash recovery
  (`recoverVideoJobs`); accept/reject review.
- **Simplified or not built yet:** states REQUESTED, POLICY_CHECKED, WAITING_APPROVAL,
  POST_PROCESSING, SUBMITTING, RUNNING and DOWNLOADED are not stored (request, policy and
  reservation are one transaction; download and validation happen in one step);
  approvals (requests above the per-request ceiling or PREMIUM are refused instead); a
  "not accepted" submit consumes an attempt instead of retrying the same attempt; failed
  clips are not kept for diagnosis; no queue/worker (in-process bounded runner; recovery
  must be called by a scheduler that does not exist yet); no video rate-limit bucket; no
  FFmpeg post-processing or thumbnails; no daily provider reconciliation; job/ledger
  retention period undecided. Rate card and budget values are placeholders (§4.2.8).

- **UI (minimal):** `/{locale}/w/{slug}/ai/videos/generate` (content.create) — request
  form, recent requests, status, failure reason, accept/reject, download while retained.
  Server actions in `src/server/videos/generation/video-generation-actions.ts`: strict
  input (no workspace, budget, limit or provider accepted from the client), membership
  check, provider check, then the service; the first run starts after the response
  (`after()`), "Check status" runs it again. No money is shown: the budget policy is
  undecided and the page says so.

#### 4.2.1 Video gateway interface

```
submit({ mode: TEXT_TO_VIDEO | IMAGE_TO_VIDEO, prompt, negativePrompt?,
         referenceImages?: StorageKey[], durationSeconds, aspectRatio: 16:9 | 9:16,
         resolution: 720p | 1080p, audio: boolean, tier: DRAFT | STANDARD | PREMIUM,
         idempotencyKey }) → { providerJobId, acceptedAt }
status(providerJobId)   → { state: QUEUED | RUNNING | SUCCEEDED | FAILED | CANCELLED,
                            outputs?: TemporaryUrl[], failure?: NormalizedFailure,
                            billedUnits? }
cancel(providerJobId)   → best effort
findByClientRef(ref)    → providerJobId? (only where the provider supports it)
```

- One adapter per provider under `src/server/ai/providers/video/*`; vendor SDK imports
  stay inside that folder (static test, as P4-AC1).
- `tier` maps to a provider model in the **routing table** (configuration). With the
  recommended provider ([Decision] D9; see PROVIDER_INTEGRATION_COMPARISON.md §3), the
  proposed mapping is: DRAFT → Veo 3.1 Lite 720p; STANDARD → Veo 3.1 Fast 1080p;
  PREMIUM → Veo 3.1 1080p [Reported model names and tiers; verify before
  implementation].
- Durations, resolutions and aspect ratios a model does not support are rejected by
  the adapter **before** submission (no paid call).
- A deterministic **fake video provider** (tests and CI) reproduces every state and
  failure in §4.2.4 and returns a small real MP4 fixture, so the post-processing path is
  exercised without cost.

#### 4.2.2 Job model and state machine

`VideoGenerationJob` (one requested clip) owns one or more `VideoGenerationAttempt`s
(one paid provider submission each).

```
Job:  REQUESTED → POLICY_CHECKED → [WAITING_APPROVAL] → RESERVED → IN_PROGRESS
        → POST_PROCESSING → READY_FOR_REVIEW → ACCEPTED | REJECTED
        ↘ FAILED | CANCELLED | LIMIT_REACHED | NEEDS_RECONCILIATION

Attempt: INTENDED → SUBMITTING → SUBMITTED → RUNNING → OUTPUT_READY → DOWNLOADED
           → VALIDATED
         ↘ FAILED_RETRYABLE | FAILED_PERMANENT | REFUSED_BY_PROVIDER | TIMED_OUT
           | OUTCOME_UNKNOWN | CANCELLED
```

- An attempt row is written in `INTENDED` **before** the external call (the
  PublishAttempt pattern). The provider job id is stored as soon as `submit` returns.
- Transitions are enforced by a pure transition function plus a DB CHECK on the state
  column. Illegal transitions throw (unit and mutation tests).
- Bounds per job: `maxAttempts` (default 2: the first attempt plus one automatic retry),
  `maxWallTime` (default 20 min [Assumption]), and `maxReservedCost` from the
  BudgetPolicy. Exceeding any bound → `LIMIT_REACHED`.
- A user "regenerate" creates a **new job** linked to its parent (own reservation, own
  policy check). It never reuses the old reservation.

#### 4.2.3 Submission, polling and worker crashes

- Queues (pg-boss, [Decision] D4): `video.submit`, `video.poll` and
  `video.postprocess`, each with its own worker pool and concurrency limits per
  workspace and per provider.
- **Submit:** the idempotency key is `hash(jobId, attemptNo)`. When the provider
  accepts a client reference, the key is sent with the request.
- **Poll:** the worker polls `status` with exponential backoff and jitter (e.g. 10 s →
  60 s cap [Assumption]). Provider webhooks may replace polling later, after signature
  verification; they are not required in Phase 4. A provider-side `THROTTLED`/queued
  state is **not** a failure and consumes no attempt [Reported for Runway's task API].
- **Crash recovery:** the poll job is keyed by the attempt. A restarted worker resumes
  polling the stored provider job id. It **never** submits again because the worker
  restarted.

#### 4.2.4 Failure taxonomy and handling

| Failure                                                            | Attempt state                   | Automatic action                                                                                           | Budget                                                                 |
| ------------------------------------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Validation of our request fails (unsupported duration/ratio/model) | — (no attempt)                  | Rejected before submission                                                                                 | Nothing reserved or released                                           |
| Submit rejected with 4xx before acceptance (bad request, quota)    | FAILED_PERMANENT                | None; job FAILED with reason                                                                               | Reservation released                                                   |
| Submit 429 / 5xx with a clear "not accepted" response              | FAILED_RETRYABLE                | Retry the submit with backoff (the same attempt, no new billing)                                           | Kept until resolved                                                    |
| **Timeout or connection loss during submit**                       | OUTCOME_UNKNOWN                 | **No blind resubmission.** Reconcile via `findByClientRef` / recent-jobs listing where supported           | Reservation **held** until reconciled; never released blindly          |
| Provider job FAILED (internal error)                               | FAILED_RETRYABLE                | One automatic retry (new attempt) if `maxAttempts` allows                                                  | Captured as charged unless the provider reports no charge [Assumption] |
| Provider safety/content refusal                                    | REFUSED_BY_PROVIDER             | **No automatic retry** (same prompt would be refused again); the reason is shown; the human edits          | Captured as charged unless the provider reports no charge [Assumption] |
| Poll exceeds `maxWallTime`                                         | TIMED_OUT                       | Best-effort `cancel`; a late result is still downloaded and recorded if it arrives                         | Held for the late window, then captured at the estimate                |
| Output URL download fails                                          | stays OUTPUT_READY              | Retry the **download** only (bounded); never regenerate because a download failed                          | Unchanged                                                              |
| Output fails technical validation (§4.2.6)                         | FAILED_RETRYABLE                | One automatic retry if `maxAttempts` allows; the failed file is kept 7 days for diagnosis                  | Charged                                                                |
| Kill switch / cancel before submit                                 | CANCELLED                       | Nothing sent                                                                                               | Released                                                               |
| Kill switch / cancel after submit                                  | CANCELLED (job), attempt polled | Best-effort `cancel`; polling continues **read-only** so cost and output are recorded (history stays true) | Captured as reported                                                   |

All failures are normalized to the gateway codes (`timeout | unavailable |
rate_limited | refused | invalid_output`) plus `outcome_unknown`. Every failure is
audited and visible in run history.

#### 4.2.5 Asset storage

- Provider output URLs are temporary [Reported for Runway; Assumption for others]. The
  output is downloaded **immediately** on `OUTPUT_READY` by the worker, streamed to
  StorageService under `workspaces/{id}/generated-videos/{uuid}.mp4` and hashed
  (SHA-256).
- Download hosts are allow-listed per provider (no SSRF). Size cap per clip (e.g.
  200 MB [Assumption]). Content-type is sniffed, not trusted.
- **Retention (implemented, see AI_VIDEO_RETENTION_POLICY.md):** every successfully
  generated video is recorded with `recordGeneratedVideo` (`generated_videos` +
  `generated_video_files`). Its files (video, thumbnail, derivatives, temporary files)
  expire exactly 168 hours after the database-side success timestamp and are deleted
  by the next run of the scheduled retention job. Downloads stop at that instant. The
  job is triggered through `POST /api/internal/video-retention` (bearer secret; 12
  allowed requests per chain of calls less than 10 minutes apart, shared with the GET
  monitoring probe — see the policy §4). The 15-minute schedule is a conservative
  margin, not a measured requirement; scheduler, platform, storage/backup checks and
  alerting remain open prerequisites (policy §8). Job, cost and audit
  metadata are kept for 30 days after file deletion (AI_VIDEO_RETENTION_POLICY.md). Failed or rejected attempts are not kept
  beyond the same limit. Accepted clips are **not** copied into a permanent MediaAsset:
  customers download them, and Phase 5 must publish within the 7 days.

#### 4.2.6 Technical validation

`ffprobe` checks on every downloaded file:

- container MP4;
- video codec H.264 or H.265;
- duration within ±0.5 s of the request;
- resolution and aspect ratio as requested;
- an audio stream present if and only if audio was requested;
- no zero-length or corrupt streams.

The provider's safety flags are recorded. Provider watermark/provenance markers (e.g.
SynthID on Veo output [Reported]) are recorded as metadata and **never stripped**.

#### 4.2.7 Technical post-processing (allowed; not a substitute)

Deterministic FFmpeg operations on generated clips only:

- transcode to platform specs (H.264/AAC, bitrate caps);
- crop or pad to 9:16, 1:1, 4:5 or 16:9;
- loudness normalization;
- concatenate **generated** clips into a longer cut (e.g. 4 × 8 s);
- overlay of Arabic/English captions, logo and CTA rendered by us (generated frames
  render text unreliably [Assumption]; Arabic shaping via libass/HarfBuzz — verify in
  the worker image);
- poster frame / thumbnail extraction.

Not allowed in Phase 4: building a video from still images, Ken Burns motion, TTS-only
narration over stills, or any path that produces a video without a generative model.

#### 4.2.8 Cost accounting

- **Preflight estimate:** `seconds × tierRate × maxAttempts`, shown before submission.
  The worst case is reserved in the UsageLedger under the workspace lock (category
  `VIDEO_GENERATIVE`).
- **Capture per attempt:** the provider-reported billed units (credits, seconds) when
  available, otherwise the estimate flagged `ESTIMATED`.
- **Release** the remainder when the job ends, except while an attempt is
  OUTCOME_UNKNOWN.
- **Daily reconciliation** against provider usage/billing data where an API exists
  [verify per provider]. Differences above a threshold raise an alert.
- The rate card (tier → price per second, audio/no-audio, resolution) is versioned
  configuration with an effective date. Each attempt stores the rate-card version used.

#### 4.2.9 Approval policy for video

- `video.generate` is **category B**. It runs automatically only when the owner's
  policy enables it, within the per-request, daily and monthly video limits.
- **Category C** (ApprovalRequest) when any of these holds:
  - the reserved worst case exceeds the per-request approval threshold (default
    US$5 [Assumption]);
  - the PREMIUM tier is requested;
  - the prompt or reference images name or depict a real, identifiable person, a
    third-party brand or logo, a minor, or a regulated claim (content risk classifier);
  - the daily or monthly video budget would cross an alert level.
- Approval re-runs policy and budget at execution time.
- Generated output is never attached to a ContentItem or published until a human
  **accepts** it in the review gallery (READY_FOR_REVIEW → ACCEPTED). The
  AI-generated flag is set on the asset and carried into Phase 5 publishing
  disclosures.

#### 4.2.10 Rights and safety

- Prompt pre-checks run before any paid call:
  - ClaimRule;
  - forbidden imagery from the BrandVisualGuide;
  - real-person and minor detection;
  - third-party trademarks.
- Region-specific provider limits are respected by configuration. For example, Veo
  person generation in MENA/EU locations is reported as limited to `allow_adult`
  [Reported, unverified]. The adapter sends only allowed values.
- No voice cloning or likeness of real people without documented consent (category D
  without a consent record).
- Native generated audio is used as returned. TTS and licensed music are **not** part
  of Phase 4 (TTS is an optional later enhancement, [Decision] D5).

## 5. Proposed data model

Reused Phase 3 entities: Brand, Audience, MarketingGoal, ContentPillar, Campaign,
CampaignGoal/CampaignPillar, ContentItem, MediaAsset, ContentItemAsset, AuditLog,
WorkspaceMember. All new entities are **workspace-owned** (NOT NULL `workspace_id`, FK
ON DELETE CASCADE unless stated, registered in the tenant guard, indexes leading with
`workspace_id`, same-workspace triggers on cross-entity FKs, workspace immutability
trigger).

| Entity                                 | Purpose                                                                                                                                                             | Key relationships                                                           | Retention                                                              | Sensitive fields                         | Constraints / indexes                                                                                       | Phase                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| **Offer**                              | Products/services/offers the employee may promote                                                                                                                   | Campaign (m:n), ContentItem (optional)                                      | Life of workspace                                                      | none                                     | `(workspace_id, status)`; name unique per workspace                                                         | 4                                        |
| **ClaimRule**                          | Approved and forbidden claims; regulated categories; required disclaimers                                                                                           | Brand, Offer (optional)                                                     | Life of workspace; versioned                                           | none                                     | kind ∈ {APPROVED, FORBIDDEN, REQUIRES_APPROVAL, DISCLAIMER}                                                 | 4                                        |
| **BrandVisualGuide**                   | Colors, fonts, logo asset, composition rules, prohibited imagery                                                                                                    | Brand (1:1), MediaAsset (logo, references)                                  | Versioned                                                              | none                                     | one active version per workspace                                                                            | 4                                        |
| **AgentRun / WorkflowExecution**       | One execution of a workflow (objective → plan → tasks, or a single tool run)                                                                                        | parent run (self FK), actor user, policy version, Campaign (optional)       | 24 months then summarized [Assumption]                                 | none (no prompts)                        | state machine CHECK; `(workspace_id, created_at desc)`, `(workspace_id, state)`                             | 4                                        |
| **StepExecution**                      | One step attempt with input/output references                                                                                                                       | WorkflowExecution                                                           | Same as run                                                            | output references only                   | idempotency key UNIQUE `(workspace_id, idempotency_key)`                                                    | 4                                        |
| **GenerationRequest**                  | One model/media call: task class, route, provider, model, language, status, tokens/units, estimated & actual cost, latency, error code, validated output (for text) | StepExecution, parent request (regeneration), ContentItem target            | 12–24 months; outputs may be pruned after use [Decision]               | validated output text (business content) | CHECKs as in the current `ai_generations` (output iff succeeded, error iff failed, metrics ≥ 0)             | 4 (evolves `ai_generations`)             |
| **GeneratedAsset**                     | An image/audio/video candidate or render with provenance                                                                                                            | GenerationRequest(s), MediaAsset (when accepted), ContentItem (optional)    | Candidates not accepted: 30 days [Assumption]; accepted: as MediaAsset | storage key (server-only)                | status CANDIDATE/ACCEPTED/REJECTED/EXPIRED; `(workspace_id, status, created_at)`                            | 4                                        |
| **VideoGenerationJob**                 | One requested generative clip: mode, tier, duration, ratio, resolution, audio flag, state, max attempts, reserved/actual cost, rate-card version                    | StepExecution, GenerationRequest, parent job (regeneration), GeneratedAsset | Same as runs                                                           | prompt (business content, not audited)   | state machine CHECK (§4.2.2); `(workspace_id, state, created_at)`; attempts ≤ max_attempts                  | 4                                        |
| **VideoGenerationAttempt**             | One paid provider submission: provider, model, provider job id, state, billed units, cost, failure code, timings, output hash                                       | VideoGenerationJob                                                          | Same as job                                                            | provider job id                          | written INTENDED before the call; UNIQUE `(workspace_id, idempotency_key)`; `(provider, provider_job_id)`   | 4                                        |
| **UsageLedger**                        | Append-only money/credit movements: RESERVE, CAPTURE, RELEASE, ADJUST                                                                                               | GenerationRequest / PublishingJob / BudgetPolicy period                     | ≥ 7 years if used for billing [Decision with finance]                  | amounts                                  | append-only (tenant guard appendOnly); `(workspace_id, period, category)`                                   | 4                                        |
| **BudgetPolicy**                       | Per-generation caps; daily/monthly AI budget; image and generative-video sublimits (per tier); video approval threshold; hard-stop thresholds; alert levels         | Workspace (1 active version), approver user                                 | Versioned forever (audit)                                              | none                                     | one ACTIVE per workspace; amounts ≥ 0                                                                       | 4                                        |
| **ApprovalRequest**                    | A category C decision awaiting a human: what, why, cost, risk, expiry                                                                                               | StepExecution / PublishingJob, requester, decider                           | Same as runs                                                           | none                                     | status PENDING/APPROVED/REJECTED/EXPIRED; decided_by required when decided                                  | 4                                        |
| **PolicyDecision**                     | Result of evaluating one action: ALLOW / REQUIRE_APPROVAL / DENY + reasons + policy version                                                                         | StepExecution / PublishingJob                                               | Same as runs                                                           | none                                     | append-only                                                                                                 | 4                                        |
| **AutomationPolicy**                   | Owner-configured automation rules (accounts, content types, windows, limits, approvals, forbidden topics, stop conditions, retry thresholds)                        | SocialConnection (allowed list), approver user                              | Versioned forever                                                      | none                                     | one ACTIVE version per workspace; signed by OWNER                                                           | 4 (storage), 5 (enforced for publishing) |
| **WorkspaceAutomationState**           | Kill switch: ACTIVE / PAUSED / STOPPED + reason + actor                                                                                                             | Workspace (1:1)                                                             | Current + history in AuditLog                                          | none                                     | single row per workspace                                                                                    | 4                                        |
| **SocialConnection**                   | An authorized account (platform, external account id, type ORGANIC/ADS, scopes, status, token expiry)                                                               | Workspace, connected-by user                                                | While connected; tokens deleted on disconnect                          | **encrypted tokens**, external ids       | UNIQUE `(workspace_id, platform, external_account_id, type)`; tokens encrypted (AES-256-GCM, key id stored) | 5                                        |
| **PublishingJob**                      | One publish of one ContentItem variant to one connection at one time                                                                                                | ContentItem, SocialConnection, GeneratedAsset/MediaAsset, WorkflowExecution | 24 months                                                              | none                                     | state machine; UNIQUE `(workspace_id, idempotency_key)`; `(state, run_at)` for the scheduler                | 5                                        |
| **PublishAttempt**                     | Each external call of a job with request id, outcome, platform error, timing                                                                                        | PublishingJob                                                               | Same as job                                                            | platform error payload (redacted)        | append-only                                                                                                 | 5                                        |
| **PublishedPost**                      | Confirmed external post (platform post id, permalink, published_at)                                                                                                 | PublishingJob (1:1), ContentItem                                            | Life of workspace                                                      | external ids                             | UNIQUE `(workspace_id, platform, external_post_id)`                                                         | 5                                        |
| **PlatformMetricSnapshot**             | Append-only metric values per post/account per window                                                                                                               | PublishedPost or SocialConnection                                           | Per platform terms [verify]; aggregates kept longer                    | none                                     | `(workspace_id, subject_id, metric, observed_at)`                                                           | 6                                        |
| **Competitor / Observation / Insight** | Competitive intelligence (earlier proposal)                                                                                                                         | —                                                                           | Per source terms                                                       | public data only                         | See PHASES_4_6_PRODUCT_DESIGN.md §4.2                                                                       | 6                                        |

The current uncommitted `ai_generations` table maps to **GenerationRequest** and is the
starting point for it ([Decision] D1).

## 6. Publishing engine (Phase 5)

### 6.1 Job lifecycle

```
DRAFT content (APPROVED in workflow) ──▶ PublishingJob SCHEDULED (run_at, idempotency key)
   → DUE → POLICY_CHECKED (PolicyDecision) → MEDIA_READY (upload/container created)
   → SUBMITTING → PUBLISHED  ──▶ PublishedPost
                  ├─ FAILED_RETRYABLE → (backoff) → SUBMITTING   [only if no side effect possible]
                  ├─ FAILED_PERMANENT → DEAD_LETTER (human)
                  └─ OUTCOME_UNKNOWN → NEEDS_RECONCILIATION → PUBLISHED | NOT_PUBLISHED → retry | ESCALATED
   (any state) → CANCELLED (kill switch, policy change, human)
```

### 6.2 Idempotency and duplicate prevention

- Idempotency key per job: `(workspace, content variant, connection, scheduled slot)`;
  creating a second job with the same key returns the first.
- A PublishAttempt row is written **before** each external call
  (INTENDED → SENT → CONFIRMED / FAILED / UNKNOWN).
- Platform-side identifiers are captured as early as possible: Instagram media container
  id; TikTok `publish_id`; YouTube upload session; Facebook post id from the response
  [Confirmed for the existence of these flows; details verified per adapter].

### 6.3 Ambiguous outcomes (timeout after submit)

A timeout or connection loss after the publish request is sent means **the post may
exist**. The engine therefore:

1. Marks the attempt UNKNOWN and the job NEEDS_RECONCILIATION — **no automatic retry**.
2. Runs platform-specific reconciliation:
   - status endpoint for the captured id (container or publish id),
   - otherwise, list recent posts on the account and match by a correlation marker
     (caption hash plus scheduled-time window; where the platform allows hidden metadata,
     a client reference) [Assumption — exact methods per platform verified during
     Phase 5].
3. Confirmed published → PublishedPost (no retry). Confirmed not published → retry
   allowed (counts against max retries). Still unknown after N checks → ESCALATED to a
   human with both options ("mark as published" / "publish again"), category C.

### 6.4 Retries and dead letters

Retry only failures classified as transient **and** without possible side effects (e.g.
media upload failed before publish, 429 with Retry-After, 5xx before the request was
accepted). Backoff with jitter; per-job max attempts from the AutomationPolicy; after
that → DEAD_LETTER with a classified reason. Token errors → connection NEEDS_REAUTH,
jobs paused, not failed.

### 6.5 Partial failures

A multi-network release is a parent execution with one job per connection. Each job
succeeds or fails independently. The parent reports PARTIAL; only failed jobs can be
retried; succeeded jobs are never re-sent.

### 6.6 Scheduling and time zones

`run_at` is stored as a UTC instant computed from the workspace time zone (Phase 3 time
utilities, DST-safe). The scheduler polls due jobs with `SKIP LOCKED`; posting windows
and limits are re-checked at execution time (policies may have changed since
scheduling).

## 7. Queue and workers

Proposed: **pg-boss** on the existing PostgreSQL for Phases 4–5.

- Transactional enqueue with the business change.
- Retries, delays and cron.
- No new infrastructure.

Alternatives are BullMQ + Redis (richer features and higher throughput, but adds Redis
operations and has persistence trade-offs) and a managed queue such as SQS (needs an
outbox). The comparison is in the provider document. All handlers must be idempotent
whichever queue is chosen.

Worker pools are separated by job type (text, image, video-submit, video-poll,
video-postprocess, publish, metrics) to isolate slow video jobs from publishing. Concurrency is limited per workspace (fairness)
and per provider (rate limits).

## 8. Analytics ingestion (Phase 6)

Scheduled collection per PublishedPost and connection, within platform rate limits;
append-only snapshots; a metric dictionary maps platform metrics to Flexibx metrics with
versioning (Instagram replaced `impressions` with `views` in 2025 [Confirmed]);
freshness and completeness states; KPI evaluation against MarketingGoal; no revenue
attribution without conversion data.

## 9. Workflows (designs, not implemented)

1. **New campaign:** objective → intake → plan (C: first-plan approval) → calendar
   (DRAFTs) → copy + assets (budgeted) → validation (brand/claims/platform) → approval
   per policy → schedule (PublishingJobs) → publish → collect metrics → report.
2. **Product launch:** Offer + launch date → launch plan (teasers, launch day, follow-ups)
   → asset set per network → validation → scheduled release with a hard start time →
   post-launch report.
3. **Failed post:** classify (transient / permanent / auth / policy / unknown) → transient:
   safe retry; auth: pause + notify reconnect; permanent: dead letter + suggested fix;
   unknown outcome: reconciliation (§6.3).
4. **Underperforming content:** metrics below the goal threshold after the evaluation
   window → analysis (labelled interpretation) → proposals → policy check → execute only
   category B levers (retime, swap variant) → measure after the window.
5. **Monthly report:** collect → summarize vs goals (data-quality notes) → propose next
   month's plan → owner approval (C) → calendar.

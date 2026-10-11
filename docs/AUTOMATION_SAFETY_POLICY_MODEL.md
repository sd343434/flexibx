# Flexibx — Automation Safety and Policy Model (Proposed)

**Status: PROPOSED — DESIGN ONLY.** Prepared 2026-10-09. Companion to
[the roadmap](AI_MARKETING_EMPLOYEE_ROADMAP_4_6.md) and
[the architecture](AI_MARKETING_EMPLOYEE_ARCHITECTURE.md).

> AI assists. Humans approve. Application authorization controls access. The model
> never controls security, never publishes on its own authority, and never becomes the
> authorization layer.

## 1. Layers of control

Every consequential action is evaluated against **six independent layers**. All must
allow it.

| Layer                       | Question                                                                                                                                  | Source of truth                                                      | Who can change it                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| 1. User permission          | May the acting person (or the person who started the run) do this kind of action?                                                         | Permission matrix (`src/server/tenancy/permissions.ts`) + membership | Workspace OWNER/ADMIN through member management (Phase 2 rules) |
| 2. Automation policy        | Has the owner enabled this action for automatic execution, with these limits?                                                             | AutomationPolicy (versioned, OWNER-signed)                           | OWNER only, re-authenticated, audited                           |
| 3. Platform permission      | Does the connected account's token have the scope, and does the platform allow the action for this app's review state?                    | SocialConnection scopes + platform review status                     | Platform OAuth consent / app review                             |
| 4. Per-action authorization | Is this specific action, on this specific record, valid now (DRAFT only, belongs to the workspace, not already published, within window)? | Tool + service checks                                                | Code                                                            |
| 5. Budget                   | Is there enough reserved budget for the worst-case cost?                                                                                  | BudgetPolicy + UsageLedger                                           | OWNER (and ADMIN if [Decision] D15 allows), re-authenticated    |
| 6. Risk class               | Is the action category A, B, C or D, and do its content risk flags escalate it?                                                           | Tool registry + risk classifier                                      | Code (classifier rules versioned)                               |

## 2. Execution categories

| Category               | Default                                                                            | Escalation triggers                                   | Examples                                                                                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A — Automatic**      | Allowed (still budget-checked and audited)                                         | Content risk flags → C                                | Ideas, drafts, calendars, brand/claim checks, reports, safe retries, metric collection, asset candidates within the default allowance                                                                                                                 |
| **B — Policy-gated**   | Denied until the owner enables the specific policy; then allowed within its limits | Outside window/limits → deny or queue; risk flags → C | Publishing approved content; generating assets above the default allowance up to the budget; retiming within windows; content-mix changes within goals; auto-pause on thresholds                                                                      |
| **C — Human approval** | Creates an ApprovalRequest; executes only after approval, re-checked at execution  | Approval expires (default 72 h [Assumption])          | Spending above limits; budget increases; brand positioning changes; sensitive/regulated/legal/financial/health claims; high-risk complaints or messages; starting or changing paid advertising (unless a separate explicit paid policy authorizes it) |
| **D — Never**          | Not representable: no tool exists, no schema field expresses it                    | —                                                     | Bypassing auth; cross-workspace access; exposing secrets or private data; arbitrary code/shell; unauthorized purchases; disabling its own limits; changing permissions; publishing through unauthorized accounts                                      |

**Content risk classifier** (rule-based first, AI-assisted second, labelled): matches
against ClaimRule (forbidden or requires-approval claims), regulated-category keywords
(health, finance, legal, real estate, alcohol/tobacco — the list needs legal review),
prices/discounts not present in an Offer, competitor names, personal data patterns, and
negative-sentiment replies. Any hit escalates the action to C.

## 3. Permissions (proposal for [Decision] D15)

Existing actions reused: `content.view/create/edit/approve/publish`,
`campaign.view/manage`, `brand.view/edit`, `analytics.view`, `audit.view`.

Proposed new actions:

| Action               | Purpose                                        | Proposed minimum role               |
| -------------------- | ---------------------------------------------- | ----------------------------------- |
| `automation.manage`  | Edit AutomationPolicy                          | OWNER                               |
| `budget.manage`      | Edit BudgetPolicy, approve budget increases    | OWNER (ADMIN optional)              |
| `connections.manage` | Connect or disconnect social accounts          | OWNER, ADMIN                        |
| `publishing.approve` | Approve category C publishing / approval inbox | MANAGER (matches `content.publish`) |
| `automation.stop`    | Kill switch                                    | OWNER, ADMIN (MANAGER optional)     |
| `automation.resume`  | Resume after a stop                            | OWNER                               |

CLIENT and VIEWER roles get no automation actions. Policy and budget changes require
recent re-authentication (fresh session within N minutes [Assumption: 10]).

## 4. The model never acts directly

- The model returns **data** (validated JSON) — never tool calls with free arguments,
  URLs to fetch, SQL, code or credentials.
- The only model-produced "actions" are `PlannedTask` entries from a closed enum, each
  validated by a schema whose fields reference workspace records by **handles** that the
  server maps to ids it already authorized. Unknown handles are dropped; ids are never
  accepted.
- Policy, budget, permission and connection objects are **not reachable** from any tool
  input schema. A test asserts that no tool schema contains fields for them.
- Prompts treat all workspace and external text as fenced, untrusted data.

## 5. Policy evaluation

`evaluate(action, context) → { decision: ALLOW | REQUIRE_APPROVAL | DENY, reasons[],
policyVersion, budgetCheck }` — a pure function with exhaustive unit and mutation tests.

Evaluation order (first failure wins):

1. Workspace automation state (STOPPED/PAUSED → DENY).
2. User permission.
3. Category D → DENY.
4. Tenant/record checks.
5. Platform permission.
6. Content risk → REQUIRE_APPROVAL.
7. Category C → REQUIRE_APPROVAL.
8. Category B with no enabled policy → DENY (with an "enable policy" hint).
9. Policy limits (windows, frequency, content types, accounts) → DENY or defer.
10. Budget reservation → DENY (with a "raise budget" request = category C).
11. ALLOW.

Every evaluation is stored as a PolicyDecision row linked to the step or job.

### 5.1 Generative video policy (Phase 4)

`video.generate` (architecture §4.2) is evaluated like any tool, with these specifics.

- **Category B by default.** It is DENIED until the owner enables video generation in
  the AutomationPolicy, with:
  - allowed tiers;
  - max clips and seconds per request;
  - daily and monthly video caps;
  - the per-request approval threshold.
- **Escalated to C** (ApprovalRequest) when any of these holds:
  - the reserved worst case is above the per-request threshold (default US$5
    [Assumption]);
  - the PREMIUM tier is requested;
  - the content risk classifier flags a real or identifiable person, a minor, a
    third-party brand/logo, or a regulated claim in the prompt or reference images;
  - the request would cross a budget alert level.
- **Never (D):** cloning a real person's voice or likeness without a recorded
  consent; removing provider provenance watermarks; submitting reference media from
  another workspace.
- **Human acceptance** is required before a generated clip can be attached to a
  ContentItem, whatever the category. The model and the automation cannot accept
  clips.
- Provider safety refusals are never retried automatically. The reason is shown to
  the human, who may edit the request; the new request is evaluated again.

## 6. Budget enforcement

### 6.1 Budget objects

BudgetPolicy (versioned) defines, per workspace:

- the per-generation maximum, per category;
- daily and monthly AI budgets;
- sublimits for image and generative video (per tier: DRAFT / STANDARD / PREMIUM) and
  data;
- the generative-video per-request approval threshold and owner-set overage ceiling
  (default $0);
- alert levels (e.g. 50%, 80%, 100%);
- the hard-stop threshold;
- the behaviour at the limit (stop / degrade to a cheaper route / ask for approval).

Paid advertising (phase placement open, [Decision] D12) uses a **separate** spend policy with
daily/weekly/monthly and per-campaign caps; it never shares the AI budget.

### 6.2 Reservation → capture → release

1. **Preflight estimate** of the worst case:
   - text: input tokens × price + `maxOutputTokens` × price;
   - image: N × unit price;
   - generative video: clips × seconds × tier rate × `maxAttempts` (from the versioned
     rate card).
2. **Reserve** inside a transaction holding the workspace row lock (the pattern
   implemented in Phase 4 for the daily cap). Reservations that would exceed any limit
   are refused, so concurrent requests cannot over-commit.
3. **Capture** the actual cost from the provider-reported usage after the call. If the
   provider does not report usage, capture the estimate and flag it as `ESTIMATED`.
   Video attempts that reached the provider (including failed and refused ones) are
   captured as charged unless the provider confirms no charge.
4. **Release** the unused remainder. Expired reservations (crashed workers) are released
   by a sweeper after a timeout — **except** reservations of video attempts in
   OUTCOME_UNKNOWN or still polling with a provider job id. Those are held until
   reconciliation, because the provider may still bill them.
5. **Reconcile** daily against the provider usage/billing APIs where available. A
   difference above a threshold raises an alert.

### 6.3 Limits, alerts and hard stop

- At alert levels: notify the owner (in-app + email).
- At the hard-stop threshold:
  - new paid generations are refused;
  - running workflows finish only steps that are already paid for;
  - category A work that costs nothing continues;
  - the owner sees why and how to raise the budget (a category C request).
- A platform-wide **provider spend guard** (operator level): a daily ceiling per provider
  across all workspaces, and provider-side spend limits/alerts configured in each
  provider console where offered [verify per provider]. Breaching it pauses that
  provider route for everyone and pages an operator.
- **Safe fallback:** at a limit, the system degrades rather than failing silently. It
  switches to a cheaper text route if the policy allows, falls back to library images
  instead of generation, and offers a lower video tier (DRAFT) only with the owner's
  opt-in. Otherwise it stops with a clear message. It never substitutes a
  non-generative (image/voice-over) video.

### 6.4 Abuse detection

Signals:

- request bursts near limits;
- repeated policy denials;
- generation without use (high rejection ratio);
- prompts flagged by providers' safety filters;
- many workspaces from one account;
- unusual cost per workspace compared with its plan.

Responses: progressive throttling, temporary automation pause, operator review. All
responses are audited.

## 7. Kill switch

- **Workspace kill switch** (`automation.stop`): sets WorkspaceAutomationState=STOPPED
  with reason and actor.
  - Effects:
    - new runs and steps are refused;
    - queued jobs are cancelled (state CANCELLED, not deleted);
    - running steps stop at the next checkpoint (before any external call);
    - in-flight external calls are not aborted mid-request, but their results are
      recorded;
    - jobs with unknown outcomes continue **read-only reconciliation** so history stays
      true.
  - Content, assets, drafts and history are untouched.
  - Resuming (`automation.resume`, OWNER, re-auth) does **not** auto-restart cancelled
    jobs; the owner re-schedules explicitly.
- **PAUSED** (automatic, from stop conditions such as a failure-rate threshold, budget
  hard stop or token revocation): same effects, auto-resume not allowed unless the policy
  says so.
- **Platform kill switch** (operator): global flag per capability and per provider
  (e.g. "disable publishing to TikTok", "disable video generation"), checked at the same
  checkpoints; for incidents and provider outages.

Checkpoints: enqueue, dequeue, before every tool call, before every external request.
Latency target: effective within 60 s.

## 8. Approval gates

An ApprovalRequest records:

- the exact action and its inputs (rendered preview);
- the cost estimate;
- the risk reasons;
- the policy version;
- the requester (person or employee run);
- an expiry.

Approving re-runs policy evaluation and budget reservation **at execution time** (state
may have changed). Rejecting records a reason that is fed back to the run. Approvals
cannot be granted by the model, by the requester's own automation, or by roles lacking
the permission. Bulk approval is allowed only for items of the same type and risk.

## 9. Idempotency and audit

- Every tool invocation with an external or paid side effect has an idempotency key; a
  duplicate invocation returns the first result.
- AuditLog entries (existing append-only table) for:
  - policy and budget changes;
  - connection changes;
  - approvals and rejections;
  - publish outcomes;
  - kill-switch changes;
  - limit breaches.
    Metadata holds ids, categories, amounts, policy versions and decisions — **never**
    prompts, generated text, tokens or personal data.
- Execution history (WorkflowExecution / StepExecution / PolicyDecision /
  GenerationRequest / PublishAttempt) gives the full "what, why, under which policy, at
  what cost" view for each action.

## 10. Failure escalation

| Situation                                                    | Automatic handling                                               | Escalation                                    |
| ------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------- |
| Transient provider/platform error before any side effect     | 1 retry with backoff (text); policy-defined retries (publishing) | After the max: FAILED + notification          |
| Video provider job failed / output invalid                   | New attempt within `maxAttempts` (default 2), budget re-checked  | FAILED + reason in run history                |
| Video safety refusal                                         | **No** automatic retry                                           | Human edits the request (re-evaluated)        |
| Video submit timeout (outcome unknown)                       | Reconcile by provider job lookup; reservation held               | Unresolved → operator review, no resubmission |
| Video poll exceeds max wall time                             | Best-effort cancel; late result still recorded                   | Owner notified                                |
| Unknown publish outcome                                      | Reconciliation (read-only)                                       | ESCALATED to a human (category C)             |
| Token expired/revoked                                        | Connection NEEDS_REAUTH; jobs paused                             | Owner notified to reconnect                   |
| Failure rate above threshold (per platform/workspace)        | Automation PAUSED                                                | Owner + operator notified                     |
| Budget hard stop                                             | Paid steps refused                                               | Owner sees the raise-budget request           |
| Content risk flagged after publishing (e.g. complaint spike) | Pause further posts of that campaign if the policy says so       | Owner notified; responses are category C      |

## 11. Ambiguous publish outcomes (summary)

A timeout during publishing **never** triggers an automatic second publish. The job
moves to NEEDS_RECONCILIATION and the platform is queried by the captured identifiers
and recent-post matching. Only a confirmed "not published" allows a retry. Unresolved
cases go to a human with both choices. Details in the architecture doc §6.3.

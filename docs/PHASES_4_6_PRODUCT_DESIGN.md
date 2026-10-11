# Flexibx — AI Marketing Employee: Revised Design for Big Phases 4–6

> **Superseded at the product-vision level (2026-10-09)** by the design set that starts at
> [AI_MARKETING_EMPLOYEE_ROADMAP_4_6.md](AI_MARKETING_EMPLOYEE_ROADMAP_4_6.md). This file
> remains the reference for the **competitive intelligence** analysis (§4) and the
> **paid advertising and spend-safety** design (§6–§7), which the new set reuses. Where
> the two disagree, the new set wins.
>
> **Video correction (2026-10-09):** the video row below ("5 (short, template/AI-assisted)
> → 6 (generative)") is **withdrawn**. Generative AI video is a required Phase 4
> capability (roadmap §5.1 item 7). The placement of paid advertising stays an open
> decision (roadmap D12).

**Status: PROPOSED — awaiting human approval. Documentation only.** This document changes
no application code, tests, migrations, dependencies or runtime configuration. Nothing in
it is implemented until a human approves it phase by phase.

Date: 2026-10-09. Applies on top of: Phase 3 (Marketing Core OS, completed) and the
approved Phase 4 AI Marketing Engine design (provider boundary, context contract, ideas /
brief / copy / draft assistance, `ai_generations`, rate limits 20/user/10 min and
100/workspace/hour, daily cap 300/workspace).

## 0. How to read this document

Every platform statement carries one of three labels:

| Label            | Meaning                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **[Confirmed]**  | Stated in the platform's own developer documentation that we located during this review. Still re-verify at integration time — platforms change terms often. |
| **[Reported]**   | From third-party developer guides or vendors; plausible but not verified against the platform's own documentation.                                           |
| **[Assumption]** | Our planning assumption, to be validated (by a spike, an application to the platform, or a legal review) before the dependent work starts.                   |

Costs are split into **platform costs** (fees platforms charge), **AI/media costs** (our
model and media providers) and **ad spend** (the customer's money, paid to the ad
platform). Numbers marked _illustrative_ are placeholders for the cost model, not quotes.

---

## 1. Product principles (non-negotiable)

1. **AI assists inside policy; trusted services act.** The model proposes typed tasks.
   Only application services execute them, after validation, authorization, policy
   evaluation and budget checks. The model never holds credentials, never calls platform
   APIs directly, and never edits permissions, policies or budgets.
2. **Autonomy is opt-in, scoped and revocable.** Every autonomous capability is off by
   default, enabled per workspace by its owner, bounded by explicit limits, and stoppable
   at any time with one emergency stop.
3. **Organic access ≠ advertising access.** Connecting a social account for publishing
   never grants advertising permissions; ad accounts are connected and authorized
   separately.
4. **Evidence over assertion.** Competitive and performance conclusions show their
   evidence, source, observation time, confidence and limitations, and label what is a
   measured fact, an estimate, or an AI interpretation.
5. **Lawful data only.** Official APIs, authorized data providers, and data the customer
   supplies. No scraping that violates platform terms, no access-control bypass, no
   assumption that private analytics exist.
6. **No promised outcomes.** No sales, ROAS, reach or revenue promises. Forecasts are
   ranges with stated assumptions, shown only where platform data supports them.
7. **Arabic-first, tenant-isolated, audited.** Everything inherits the Phase 1–3 rules:
   workspace-scoped data, permission matrix, append-only audit log, ar/en UX.

## 2. Autonomy levels (shared vocabulary)

| Level  | Name                | What the system may do                                                                                                                                                          | Human role                                                 |
| ------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| **L0** | Recommend           | Analyse and suggest. Nothing is created.                                                                                                                                        | Reads, decides.                                            |
| **L1** | Prepare             | Create drafts: content drafts, scheduled-post proposals, draft campaigns (not live on the platform, or created in PAUSED state where the API supports it).                      | Reviews and approves each item.                            |
| **L2** | Execute on approval | Publish / activate exactly what a human approved, at the approved time and budget.                                                                                              | Approves each action (or each batch).                      |
| **L3** | Bounded autonomy    | Publish organic content and optimize live campaigns **without per-item approval**, only within a signed workspace policy (categories, windows, frequency, budgets, thresholds). | Sets and signs the policy; monitors; can stop at any time. |

Defaults: organic publishing L1, paid advertising L0. L3 always needs an explicit,
owner-signed, versioned policy (§8). Raising a level is an owner-only action with
re-authentication; lowering it (or the emergency stop) is available to OWNER and ADMIN
and takes effect immediately.

## 3. Unified Marketing Employee experience (E)

One workspace experience instead of separate tools:

```
Owner's objective (ar/en, free text)
  → Objective intake (typed: goal type, product/service, geography, period, budget envelope, constraints)
  → Plan (typed): strategy, channels, content calendar, competitor insights used,
     paid component (optional), estimated costs with ranges, required approvals
  → Owner review: approve all / per activity / edit / reject
  → Execution: tasks run through policy + authorization + budget services
  → Monitoring & reports (evidence-labelled) → optimization proposals → next cycle
```

**Natural language is never executed directly.** The request is turned into a typed
`ObjectiveIntake` (validated with a strict schema), then the planner produces a typed
`MarketingPlan` made of typed `PlannedTask`s, for example `CreateContentDraft`,
`SchedulePost`, `PublishPost`, `TrackCompetitor`, `PrepareCampaign`, `ActivateCampaign`,
`AdjustBudget` and `PauseCampaign`. Each task type has its own schema, permission, policy
checks, cost estimate and idempotency key. Unknown or malformed tasks are rejected. The
model's output never contains tool calls, URLs to fetch, code, or credentials.

Supported starter objectives (ar/en templates): local awareness, new product launch,
qualified inquiries/leads, bookings, seasonal campaign. Each template maps to default
channels, KPIs and measurement prerequisites (for example "bookings" requires a
conversion event — §6.4).

The plan screen states, for each activity: what will happen, which level (L0–L3), what
it costs (AI/media estimate + ad spend if any, as ranges), what approval is needed, and
what data supports it.

---

## 4. Competitive Intelligence (A)

### 4.1 Capability map (A1–A10)

| #   | Capability                                                                              | Mechanism                                                                                                                                                                                                                                                                |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A1  | Describe business, product, market, audience                                            | Existing Phase 3 brand/audience/pillar profile + new `business_profile` fields (offerings, geography, price positioning — owner-entered).                                                                                                                                |
| A2  | Add known competitors / creators                                                        | `competitors` registry: name, type (competitor/creator/benchmark brand), website, and per-platform public handles entered by the user.                                                                                                                                   |
| A3  | Propose discovery methods                                                               | AI suggests candidate competitors **as research leads** from the owner's description plus authorized lookups (e.g. YouTube channel search, Instagram Business Discovery by exact username). Every suggestion needs human confirmation before tracking. No mass crawling. |
| A4  | Track public content over time                                                          | Scheduled snapshots via official APIs where authorized (§4.3); user-supplied observations (manual entry or CSV) where no API exists. Each snapshot is time-stamped and immutable.                                                                                        |
| A5  | Analyse topics, formats, hooks, frequency, visible engagement, themes, public campaigns | Deterministic metrics (cadence, format mix, visible engagement where the API returns it) + AI classification (topics, hooks, themes) labelled as interpretation. Public ad activity only where a lawful source exists (§4.4).                                            |
| A6  | Gaps, opportunities, audience questions, differentiation, under-served topics           | AI interpretation over the evidence set + the workspace's own pillars/content; each finding links to its evidence.                                                                                                                                                       |
| A7  | Compare with own content and performance                                                | Own content from Phase 3 + own performance from connected accounts (Phase 5+).                                                                                                                                                                                           |
| A8  | Original strategies and recommendations                                                 | Feeds the planner and AI Studio as context (Phase 4 context contract extension); output must be original (§4.6).                                                                                                                                                         |
| A9  | Evidence, source, time, confidence, limitations                                         | Every `insight` row stores evidence references, source, observation window, confidence and a limitations note; the UI shows them.                                                                                                                                        |
| A10 | Facts vs estimates vs AI interpretation                                                 | `claim_kind` = MEASURED / ESTIMATED / INTERPRETED on every metric and insight; the UI labels each.                                                                                                                                                                       |

### 4.2 Data model (proposed, workspace-owned, tenant-guarded)

- `competitors` (name, kind, website, notes, status ACTIVE/ARCHIVED).
- `competitor_profiles` (competitor, platform, handle/channel id, source = USER /
  API_LOOKUP, verification state, last successful observation).
- `observations`: immutable snapshots with source, observed_at, collection method
  (API name + version / USER_ENTRY / CSV_IMPORT), raw field set restricted to allowed
  public fields, retention deadline.
- `observed_posts`: public post metadata permitted by the source (permalink, posted_at,
  format, caption text where allowed, visible counts where returned). No media binaries
  are copied by default.
- `insights`: kind (GAP, OPPORTUNITY, QUESTION, DIFFERENTIATION, TREND, BENCHMARK),
  claim_kind, confidence (LOW/MEDIUM/HIGH with a rule-based definition), evidence ids,
  limitations, generated_by (rule / AI generation id), valid_until.

Retention: snapshots and post metadata are kept only as long as the source's terms allow
(per-source `retention_days`, enforced by a purge job). Deleting a competitor purges its
data.

### 4.3 Lawful data sources — research findings

| Source                                       | What it offers for competitor research                                                                                                                                                          | Access requirements                                                                                        | Key limits                                                                                                              | Label                                                                                                         |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **YouTube Data API v3**                      | Public channel and video metadata and public statistics (views, likes and comments when the owner exposes them); channel search.                                                                | Google Cloud project + API key (public data needs no OAuth).                                               | Default 10,000 quota units/day/project; `search.list` = 100 units; quota extensions via a Google form, not purchasable. | [Confirmed] quota default; search cost [Confirmed]; upload cost ~1,600 units [Reported, conflicting versions] |
| **Instagram Graph API — Business Discovery** | Public profile fields and recent media of other **Business/Creator** accounts by exact username (followers, media count, recent posts, visible like and comment counts). Not personal accounts. | Our Meta app + the workspace's own connected IG professional account (OAuth) + App Review for public apps. | ~200 calls/hour per user token [Reported]; no historical insights of other accounts; no follower lists.                 | Fields and limits [Reported]; requires spike                                                                  |
| **Meta Ad Library API** (`ads_archive`)      | Ads about social issues/elections/politics worldwide; **all ads delivered to the EU/UK** (commercial included) with limited fields.                                                             | Meta developer app, identity verification of the requesting person, accepted terms.                        | Commercial ads outside EU/UK are generally **not** returned — weak coverage for the Saudi/GCC market.                   | [Reported]; verify before relying on it                                                                       |
| **Meta Content Library**                     | Richer public content/ads data.                                                                                                                                                                 | Researcher pathway (academic / non-profit / credentialed journalism).                                      | **Not available to commercial products** like Flexibx.                                                                  | [Reported] — treat as unavailable                                                                             |
| **TikTok Research API**                      | Public TikTok data for research.                                                                                                                                                                | Non-profit academic / research institutions in listed regions only.                                        | **Commercial use excluded** — unavailable to Flexibx.                                                                   | [Confirmed eligibility]; commercial bar [Reported]                                                            |
| **TikTok Display / Business APIs**           | The connected account's **own** data.                                                                                                                                                           | OAuth of that account.                                                                                     | Not a competitor source.                                                                                                | [Reported]                                                                                                    |
| **X API (pay-per-use)**                      | Public posts/users by query.                                                                                                                                                                    | Developer account, prepaid credits.                                                                        | ~US$0.005 per post read, ~US$0.010 per user read; monthly read cap (2–3M reported); Enterprise for heavy use.           | [Reported] pricing — verify on docs.x.com                                                                     |
| **Snapchat**                                 | Public Profiles exist, but the Marketing API excludes organic Snap management/analytics.                                                                                                        | —                                                                                                          | No official competitor content API found.                                                                               | [Reported]                                                                                                    |
| **Licensed data providers**                  | Social listening / competitive benchmarking vendors with platform data licences.                                                                                                                | Commercial contract; vendor DPA.                                                                           | Cost per seat/volume; licence scope must permit our use and display.                                                    | [Assumption] — vendor selection is an open decision (§14)                                                     |
| **Customer-supplied data**                   | Manual observations, CSV exports, screenshots described in text.                                                                                                                                | None.                                                                                                      | Customer warrants rights; we label the source as USER.                                                                  | Always available                                                                                              |

**Conclusion.** Official APIs give strong coverage for YouTube, partial coverage for
Instagram Business/Creator accounts (after Meta App Review), weak coverage for public
commercial ads in our market, and essentially no official access to TikTok or Snapchat
competitor content for a commercial product. Flexibx should therefore launch with:
(1) the registry and user-supplied observations, (2) YouTube Data API tracking, and
(3) Instagram Business Discovery once Meta App Review passes. A licensed data provider is
the only lawful route to broad TikTok/Snapchat/commercial-ads coverage; that is a
business decision (§14).

### 4.4 What we will not do

- No scraping or automated browsing of platforms whose terms forbid it; no logged-in
  scraping with a customer's credentials; no circumvention of rate limits, logins,
  paywalls or robots directives.
- No copying of competitors' content verbatim, no use of their logos/brand assets, no
  impersonation, no content that implies affiliation.
- No invented competitor revenue, sales, ad budgets, conversion rates or audience
  demographics. If a metric is not provided by the source, the UI shows "not available
  from public sources", never a guess. Estimates (e.g. posting cadence from a partial
  sample) are labelled ESTIMATED with the sample window.

### 4.5 Analysis pipeline

1. Collect (scheduled, per source quota and terms) → immutable observations.
2. Deterministic metrics: cadence per week, format mix, time-of-day distribution, visible
   engagement medians (only where the source returns counts), growth of public follower
   counts between snapshots. All MEASURED or ESTIMATED with method notes.
3. AI classification (provider boundary from Phase 4): topics, hooks, themes, questions —
   INTERPRETED, with the generation id and confidence.
4. Insight synthesis: gaps and opportunities against the workspace's pillars, own content
   and (later) own performance. Each insight lists the evidence it rests on and its
   limitations ("based on 18 public posts from 2 of 5 competitors over 30 days").
5. Recommendations: original ideas/briefs (Phase 4 operations) with competitor context
   added to the context contract as fenced, untrusted data.

### 4.6 Originality and safety checks

- Generated recommendations are compared with the competitor captions in the evidence
  set; high textual similarity (n-gram overlap above a threshold) blocks the suggestion
  as "too close to source" and asks for regeneration.
- Brand-name and handle filter: generated public-facing copy must not name competitors
  unless the owner explicitly writes comparative content (separate legal check, §11).

---

## 5. Organic marketing automation (B)

### 5.1 Lifecycle

`business context → strategy → content plan → text/image/video production → validation →
scheduling → authorized publishing → monitoring → reporting → optimization`

| Stage                   | Phase                                            | Notes                                                                                                                                        |
| ----------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Context, strategy, plan | 4 (AI Studio) → 5 (planner)                      | Plan items become DRAFT content (existing workflow).                                                                                         |
| Text production         | 4                                                | Implemented operations (ideas, brief, copy, assist).                                                                                         |
| Image production        | 5                                                | Media provider boundary (same pattern as the AI provider): stored in the workspace's object storage, marked AI-generated, alt text required. |
| Video production        | 5 (short, template/AI-assisted) → 6 (generative) | Video generation is the largest cost driver; budget-gated (§9).                                                                              |
| Validation              | 5                                                | Brand rules, prohibited topics, forbidden words, platform specs (length, aspect ratio, duration, file size), link checks, disclosure labels. |
| Scheduling              | 5                                                | Real scheduler (worker + queue) replaces "planning-only SCHEDULED" from Phase 3.                                                             |
| Publishing              | 5                                                | Via official publishing APIs only, per connected account and policy (§5.3).                                                                  |
| Monitoring              | 5                                                | Post status, own-post insights from the platform APIs.                                                                                       |
| Reporting               | 5 → 6                                            | Evidence-labelled reports; benchmarks in 6.                                                                                                  |
| Optimization            | 6                                                | Recommendations (L0) by default; L3 adjustments of timing/format only within policy.                                                         |

### 5.2 Owner-authorized organic policy (versioned, owner-signed)

`organic_policies`: connected accounts in scope; permitted content categories; prohibited
topics; brand rules (from the brand profile); publishing windows (days/hours, workspace
time zone); frequency limits per account per day and per week; media-generation limits
(count and budget per period); automatic-publishing switch per account (L1/L2/L3);
approval requirements (e.g. "always approve video", "approve anything mentioning
prices"); emergency-stop conditions (e.g. negative-sentiment spike, platform error
streak, brand-rule violation detected after publishing); and expiry/review date.

Policy changes are owner-only, re-authenticated, audited, and create a new version. Tasks
record the policy version they ran under.

### 5.3 Platform publishing matrix (organic)

| Platform                     | Official publishing API                                            | Key requirements and limits                                                                                                                                                                                                                            | Label                                                 |
| ---------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| Instagram (Business/Creator) | Graph API content publishing (`media` container → `media_publish`) | Meta App Review for `instagram_content_publish`; per-account rolling 24 h publishing cap (Meta docs show 50 and 100 in different versions; query `content_publishing_limit` per account); the app must enforce the cap for scheduled posts.            | [Confirmed] endpoint and cap mechanism; number varies |
| Facebook Pages               | Graph API page posts                                               | Page permissions via App Review.                                                                                                                                                                                                                       | [Assumption] — spike                                  |
| TikTok                       | Content Posting API (Direct Post / Upload to inbox)                | **Unaudited clients: all posts forced private (SELF_ONLY), max 5 posting users/24 h.** Public posting requires passing TikTok's audit; per-account daily caps apply. "Upload" sends drafts to the creator's inbox for manual posting (good for L1/L2). | [Confirmed]                                           |
| YouTube                      | Data API `videos.insert`                                           | ~1,600 quota units per upload [Reported]; default 10,000 units/day; unverified apps' uploads may be restricted to private until the API project is audited [Assumption — verify].                                                                      | Mixed                                                 |
| X                            | API v2 post creation (pay-per-use)                                 | ~US$0.015 per post, ~US$0.20 per post containing a URL [Reported].                                                                                                                                                                                     | [Reported]                                            |
| Snapchat                     | —                                                                  | No organic publishing API found (Marketing API excludes organic). Manual or deferred.                                                                                                                                                                  | [Reported]                                            |
| LinkedIn                     | Community Management API                                           | Partner approval required [Assumption]. Lower priority for the GCC SMB segment.                                                                                                                                                                        | [Assumption]                                          |

**Sequencing implication:** Instagram + Facebook (Meta App Review) and TikTok (audit)
gate public autopublishing. Until each passes, the product runs that platform at L1/L2
with "upload to inbox / copy and post" flows. These reviews take weeks and can be refused
without detailed reasons [Reported], so they must start early (Phase 4 track, §12).

### 5.4 Connected accounts and secrets

- OAuth per account; tokens encrypted at rest with `ENCRYPTION_KEY` (AES-256-GCM, the
  Phase 1 reserved key); token scopes recorded; refresh handled by the worker; revocation
  supported.
- Separate connection records and scopes for **organic** and **advertising** (§6).
- Tokens never reach the browser, prompts or logs (existing redaction + new tests).

---

## 6. Paid advertising management (C)

### 6.1 Workflow (C1–C10)

| #   | Step                      | Design                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | Beginner intake           | Guided ar/en form: goal, product/service, geography, budget (total + period), destination (URL / WhatsApp / call / app), conversion objective. Validates that the objective is measurable with the current setup.                                                                                               |
| C2  | Strategy recommendation   | Channel choice, audience description, budget split, creative direction and measurement plan — L0, with reasoning and evidence.                                                                                                                                                                                  |
| C3  | Creative generation       | Copy + image/video variants through the media budget; owner approves the creative set.                                                                                                                                                                                                                          |
| C4  | Validation                | Claims checker (no unverifiable superlatives, prices must match the owner's entered offer, regulated-category detection), destination URL check (reachable, HTTPS, matches the domain the owner verified), asset specs per placement, platform policy pre-checks, special ad category detection, budget limits. |
| C5  | Campaign preparation      | Build the campaign object via official APIs, created **PAUSED** where supported (L1). Idempotent: the external request id is stored before the call.                                                                                                                                                            |
| C6  | Forecasts                 | Only platform-provided estimates (e.g. reach/delivery estimates where the API offers them) shown as ranges with the platform as source; otherwise "no reliable forecast". No ROAS or sales forecasts.                                                                                                           |
| C7  | Authorization to activate | Activation is an owner/authorized-approver action (L2) — or L3 only inside a signed paid policy with budget caps. Re-authentication for activation and for any budget increase.                                                                                                                                 |
| C8  | Performance retrieval     | Scheduled reporting pulls: spend, impressions, clicks and conversions as reported by the platform, with the attribution setting shown.                                                                                                                                                                          |
| C9  | Optimization              | L0 recommendations by default; L3 actions limited to an allow-list: pause underperforming ads, shift budget between ad sets **within** the campaign cap, rotate approved creatives. Never: raise caps, add new geographies or audiences outside the policy, or change the objective.                            |
| C10 | Pause / escalate          | Automatic pause on: spend threshold, anomaly (spend velocity, CTR/CPM outliers vs baseline), policy rejection, tracking outage (no conversion data for N hours when the objective depends on it), destination down. Escalation notification to the owner.                                                       |

### 6.2 Advertising platform matrix

| Platform                      | API & access                                                                                                                                                                                                                                                                                                                                                                     | OAuth / account                                                                     | Campaign create/edit                                       | Targeting restrictions                                                                                                                                                                                           | Creative reqs                        | Conversion tracking                                                            | Reporting/attribution limits                                                    | Review & rate limits                                               | Cost                                                               |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------ |
| **Meta (Facebook/Instagram)** | Marketing API. Since 4 May 2026 the "Marketing API Access Tier" has **Limited** (formerly Standard) and **Full** (formerly Advanced) levels; Full needs ≥500 API calls in 15 days and <15% errors over the last 500 calls [Confirmed via Meta blog]. Managing other businesses' accounts in production needs `ads_management` via App Review + Business Verification [Reported]. | Business Manager, ad account access granted to our app (system user or user token). | Full CRUD on campaigns / ad sets / ads; can create paused. | Special Ad Categories (housing, employment, financial products & services, issues/elections/politics) must be declared, and they restrict audience options [Confirmed]; Advantage+ audience defaults [Reported]. | Placement-specific specs; ad review. | Meta Pixel + Conversions API (server events) needed for conversion objectives. | Modelled/delayed conversions; attribution-window settings; iOS privacy effects. | App Review, Business Verification; tiered rate limits.             | API free; ad spend paid to Meta [Reported].                        |
| **TikTok**                    | TikTok API for Business (Marketing API v1.3) [Reported].                                                                                                                                                                                                                                                                                                                         | TikTok for Business account; app approval, multi-week, may be refused [Reported].   | Campaign / ad group / ad CRUD [Reported].                  | Platform ad policies; regional rules.                                                                                                                                                                            | Vertical video specs.                | TikTok Pixel / Events API.                                                     | Platform-reported attribution.                                                  | Per-endpoint rate limits; raising them needs a request [Reported]. | API free; ad spend [Reported].                                     |
| **Google Ads**                | Google Ads API; developer token levels Test → **Basic (15,000 operations/day)** → **Standard (unlimited for most services)**; review ~2–5 business days for Basic, ~10 for Standard [Confirmed, versions differ on days].                                                                                                                                                        | Google Ads manager account (MCC), OAuth per customer.                               | Full CRUD (Search, PMax, Display, YouTube…).               | Policy-restricted categories; personalized-ads policy.                                                                                                                                                           | Responsive assets, policy review.    | Google tag / offline conversions / enhanced conversions.                       | Data-driven attribution; conversion lag.                                        | Daily operation limits per token level.                            | API free; ad spend [Confirmed for API].                            |
| **Snapchat**                  | Marketing API (Ads API), "open to all developers"; campaign / ad squad / ad lifecycle [Confirmed via Snap docs]. Organic Snap management is excluded [Reported].                                                                                                                                                                                                                 | Snap Business account; OAuth app enabled in Business Details [Reported].            | Full ads lifecycle [Confirmed].                            | Snap ad policies.                                                                                                                                                                                                | Vertical full-screen specs.          | Snap Pixel / Conversions API.                                                  | Platform-reported.                                                              | —                                                                  | API free; ad spend. High relevance for KSA [Reported usage stats]. |
| **X**                         | Ads API (separate access application) [Assumption].                                                                                                                                                                                                                                                                                                                              | —                                                                                   | —                                                          | —                                                                                                                                                                                                                | —                                    | —                                                                              | —                                                                               | —                                                                  | Lower priority.                                                    |

**Recommended order:** Meta first (largest SMB reach, one API for FB + IG), then
Snapchat (KSA relevance, open Ads API), then Google Ads (search intent), then TikTok
(approval risk). This is a customer-value assumption to validate with pilot customers
(§14).

### 6.3 Separation from organic access

`ad_connections` are separate from `social_connections`: different OAuth scopes, a
different consent screen in the product, a separate owner authorization, and separate
audit actions. A workspace can have publishing without advertising and vice versa.

### 6.4 Measurement prerequisites

Conversion-objective campaigns (leads, bookings, purchases) cannot be activated until the
measurement plan is satisfied: pixel/server events verified (test events received), a
destination owned by the workspace, and the objective mapped to a real event. Otherwise
the planner downgrades the objective (e.g. traffic or awareness) and says why.

---

## 7. Spending and safety policy (D)

### 7.1 Policy objects (owner-signed, versioned, re-authenticated)

`spend_policies` per workspace:

- Maximum ad spend per **day / week / month** (workspace-wide, all platforms).
- **Per-campaign** lifetime and daily caps.
- **AI/media budget** per month (separate from ad spend), with per-category sublimits
  (text, image, video, competitor data).
- Autonomy level for paid (L0–L3) and the allow-listed L3 optimization actions.
- Anomaly thresholds (spend velocity, CPM/CPC spikes, CTR collapse) and the pause rule.
- Escalation contacts and quiet hours.
- Expiry / mandatory review date.

### 7.2 Hard rules

- The model **cannot** create, change, or read the secrets of policies, budgets,
  permissions or connections. Policy tables are written only by owner-initiated service
  calls; the AI task schemas have no fields that reference them.
- Budget **increases** beyond the signed policy always need a fresh owner approval
  (re-authentication); there is no "temporary" bypass.
- Every advertising action goes: typed task → validation → authorization (role) → policy
  evaluation → **budget reservation** → idempotent execution → audit → reconciliation.

### 7.3 Budget reservation, reconciliation, hard stop

**Ledger (append-only, workspace-scoped):** `budget_reservations` (amount, currency,
scope = day/week/month/campaign, task id, expires_at) and `spend_entries` (source =
PLATFORM_REPORT / AI_PROVIDER / MEDIA_PROVIDER / DATA_PROVIDER, amount, period,
external reference, reconciled_at).

1. **Before any paid action** (activate a campaign, raise a daily budget, generate a
   video), the service reserves the worst-case amount the action can commit in the
   current periods, inside one transaction holding a workspace-level lock — the same
   pattern as Phase 4's daily AI cap — so concurrent actions cannot over-commit.
2. **Worst-case accounting for platform over-delivery:** ad platforms may spend above a
   campaign's daily budget on some days and balance over the period. Google documents
   spend up to 2× the average daily budget on a given day; Meta can exceed a daily budget
   by up to ~75% on a given day [Assumption — both must be re-verified in current
   docs]. The reservation therefore uses `platform_max_daily_multiplier × daily_budget`,
   and the system prefers **lifetime budgets / campaign spending limits** set on the
   platform itself (an account- or campaign-level spend cap enforced by the platform), so
   the platform enforces the ceiling even if Flexibx is unavailable.
3. **Reconciliation** (worker, at least hourly while campaigns are live, then daily
   final): pull actual spend per campaign; write `spend_entries`; release or adjust
   reservations; recompute remaining budget.
4. **Overspend detection:** actual + reserved > cap − safety margin → stop new
   reservations; if actual ≥ cap → hard stop.
5. **Hard stop:** pause all affected campaigns via API (idempotent, retried with
   backoff), lower or remove platform budgets where pausing fails, mark the workspace
   paid-autonomy as SUSPENDED, notify the owner, and require owner action to resume.
6. **Emergency stop (owner/admin button):** immediately suspends all L2/L3 tasks
   (organic and paid), pauses live campaigns, cancels queued publishing. It is idempotent
   and audited, with a status page showing what was stopped and what failed to stop.
7. **Data-quality stop:** if reporting is stale beyond a threshold, autonomy pauses
   (spend cannot be reconciled reliably).

### 7.4 Idempotency and auditability

Every external mutation has a stored idempotency key and an "intent" row written
**before** the call (INTENDED → SENT → CONFIRMED / FAILED / UNKNOWN). UNKNOWN outcomes
are resolved by reading back the platform state before any retry. The audit log records
actor (human, or the employee acting under policy version X), task id, platform, external
object id, amounts, and the policy decision — never tokens, prompts or creative text.

### 7.5 Clear modes in the UI

Every campaign shows one of: **Recommendation only** · **Draft prepared (not live)** ·
**Live — approved by <name> on <date>** · **Live — autonomous within policy v<n>**. Every
autonomous change lists what changed, why, and the evidence.

---

## 8. Policy enforcement architecture

```
Typed task (from planner or human UI)
  └─ Schema validation (strict, per task type)
  └─ Authorization (permission matrix; ownership; tenant scope)
  └─ Policy evaluation (organic / spend policy version, autonomy level, limits, windows)
  └─ Budget reservation (if it costs money)
  └─ Execution (idempotent, worker, platform adapter)
  └─ Audit + outcome + reconciliation
```

- The policy evaluator is a pure, unit-tested module (decision + reasons). It is
  mutation-tested like the Phase 2/3 security code.
- New permission actions (proposed, need human approval): `social.connect`,
  `ads.connect`, `publishing.approve`, `ads.approve`, `policy.manage` (OWNER only),
  `autonomy.stop` (OWNER, ADMIN), `competitors.manage`, `competitors.view`.
- Platform adapters live behind a boundary like the AI provider: no vendor SDK outside
  `src/server/integrations/<platform>/`.

---

## 9. Budget models and unit economics (F5, F6)

### 9.1 Cost components

| Component        | Driver                                                                                    | Status of price                                                   |
| ---------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| AI text          | input/output tokens × provider price; retries (≤1)                                        | Provider not chosen — price unknown [Assumption]                  |
| AI image         | per image (resolution/quality tier)                                                       | Provider not chosen [Assumption]                                  |
| AI video         | per second of output (tier)                                                               | Provider not chosen; expected to dominate media cost [Assumption] |
| Competitor data  | YouTube free within quota; X ~US$0.005/post read [Reported]; licensed vendor per contract | Mixed                                                             |
| Publishing APIs  | Meta/TikTok/YouTube free [Reported]; X ~US$0.015/post, ~US$0.20 with URL [Reported]       | Mixed                                                             |
| Advertising APIs | Free; ad spend is paid by the customer directly to the platform [Reported]                | —                                                                 |
| Infrastructure   | storage, egress (video), workers, queue                                                   | Our hosting [Assumption]                                          |

### 9.2 Unit-economics formulas

- **Cost per generation (text)** = `(tokens_in × p_in + tokens_out × p_out) × (1 + retry_rate)`
- **Cost per published post** = `Σ text generations for the post` + `n_images × p_image` +
  `video_seconds × p_video_s` + `platform_post_fee` (X only) + `storage/egress` +
  `review overhead (regenerations before approval)`
- **Cost per campaign (excluding ad spend)** = `creative generation (copy + images + video variants)`
  - `validation runs` + `API operations` (free) + `monitoring & reconciliation runs` +
    `optimization analyses`
- **Gross margin per workspace** = `plan price − (Σ AI/media/data costs + infra share)`.
  Ad spend is pass-through and is never counted as revenue.

### 9.3 Illustrative scenario (placeholders — replace once providers are chosen)

_Illustrative only, not quotes:_ text generation US$0.01–0.05; image US$0.02–0.10; video
US$0.10–0.50 per output second. A post with 3 text generations and 1 image costs about
US$0.05–0.25. A 15-second AI video adds US$1.50–7.50. A campaign with 6 copy variants,
4 images and 2 × 15 s videos costs about US$3–17 in creative before ad spend. These ranges
drive the default media budgets and plan limits (§14 decision: pricing tiers and included
quotas).

### 9.4 Budget model in the product

- Workspace **AI/media budget** (monthly, money or credits) with sublimits per category;
  every generation reserves its estimated cost first (extends the Phase 4 daily cap) and
  reconciles with the provider's reported usage.
- **Ad spend budget** governed by §7, shown separately and never mixed with AI/media.
- Owner dashboard: committed (reserved) vs actual vs remaining, per category and platform.

---

## 10. Revised roadmap (Big Phases 4–6)

Dependencies drive the order. Organic publishing and competitor tracking both need
OAuth connections, encrypted tokens and a background worker. Paid ads need all of that
plus the spend ledger. This pulls items previously planned for Phases 8–9 (token
encryption, Redis/BullMQ worker) forward into Phase 5.

### Big Phase 4 — AI Marketing Engine + Competitive Intelligence foundation

Already approved and largely implemented (uncommitted, awaiting review): provider
boundary (disabled/fake), context contract, ideas/brief/copy/draft assistance, strict
output validation, `ai_generations`, rate limits and daily cap, audit, AI Studio, usage
summary.

**Proposed additions (need approval; recommended as a separate review step "4b" so the
already-implemented engine can be reviewed and committed first):**

1. Business profile extension (offerings, geography, price positioning) — A1.
2. Competitor registry + per-platform public handles — A2.
3. User-supplied observations (manual entry, CSV import) with source labels — A4 (manual).
4. YouTube Data API tracking (API key, public data, quota-aware, scheduled by a minimal
   cron route) — A4 (official, first platform). _Note:_ if a worker is not yet available,
   on-demand refresh only.
5. Deterministic metrics + AI classification with claim kinds, evidence, confidence and
   limitations — A5, A9, A10 (foundational).
6. Competitor context in the AI context contract (fenced, bounded) — A8.
7. Discovery suggestions as leads requiring confirmation — A3 (YouTube search; Instagram
   exact-username lookup deferred to Phase 5 because it needs a connected IG account).
8. **Start platform reviews now** (no code): Meta App Review + Business Verification,
   TikTok Content Posting audit, Google Ads developer token (Basic), Snap Ads API
   enablement — they are on the critical path for Phases 5–6.

### Big Phase 5 — Connected accounts, organic automation, CI in planning

1. Background worker + queue (BullMQ/Redis, brought forward from Phase 9), scheduler,
   retries, idempotency.
2. OAuth connections + encrypted token vault (`ENCRYPTION_KEY`, brought forward from
   Phase 8); separate organic and ads connection types.
3. Organic policy (§5.2), autonomy L1–L3 for publishing, emergency stop.
4. Publishing adapters: Instagram + Facebook (after Meta review), TikTok (private until
   the audit passes; inbox upload flow), YouTube; X optional.
5. Validation pipeline (brand rules, specs, links, disclosures).
6. Image generation + short video (template/AI-assisted) behind a media provider
   boundary and the AI/media budget ledger.
7. Monitoring + own-post insights; reporting v1.
8. Instagram Business Discovery competitor tracking; CI → content planning integration
   (insights feed the planner and calendar) — A6, A7 (own content), A8.
9. Objective intake + typed plans (E) for organic objectives.

### Big Phase 6 — Paid advertising, spend safety, benchmarking

1. Ad connections (separate scopes), Meta Marketing API first, then Snapchat and Google
   Ads; TikTok when approved.
2. Beginner campaign intake, strategy, creative, validation, PAUSED preparation, L2
   activation.
3. Spend policy, reservation ledger, reconciliation, overspend detection, hard stop,
   emergency stop (§7).
4. Performance retrieval, anomaly detection, L0 recommendations; L3 allow-listed
   optimizations behind a signed paid policy.
5. Generative video for ads within the media budget.
6. Historical benchmarking, trend analysis, opportunity detection, performance-informed
   recommendations (CI A6/A7 complete).
7. Unified Employee: objectives spanning organic + paid, cost explanation, reporting
   loop.

If platform approvals are late, a phase ships the affected platform at L1 (drafts /
manual posting) and keeps autonomy off; the capability is completed when access arrives.

---

## 11. Legal, privacy and policy considerations (require review)

- **Platform terms:** each integration is bound by its developer terms (data use,
  retention, display, no resale). Retention windows per source are configuration
  reviewed with each integration.
- **Personal data:** competitor accounts are businesses/creators, but posts and comments
  may contain personal data. Store only fields needed for the analysis; no commenter
  identities by default. Saudi PDPL and, where customers serve the EU/UK, GDPR/UK GDPR
  apply — **legal review required** before Phase 4b ships.
- **Advertising regulation:** claims substantiation, regulated categories (health,
  finance, real estate), influencer/advertising disclosure rules and any advertiser
  licensing requirements in KSA/GCC — **legal review required** before Phase 6. The
  product enforces what the review defines (claims checker, category gates, disclosures).
- **Comparative advertising** naming competitors — off by default; enabled only after
  legal guidance.
- **AI-generated media labelling** where platforms or regulations require it.

---

## 12. Acceptance criteria (measurable)

### Competitive Intelligence

- AC-CI-1: A user with `competitors.manage` can add, edit, archive competitors and
  handles; other roles cannot (tested per role); cross-workspace access returns 404.
- AC-CI-2: Every observation stores source, method, observed_at and retention deadline;
  a purge job deletes expired data (integration test with a fake clock).
- AC-CI-3: 100% of displayed metrics and insights carry a claim kind
  (MEASURED/ESTIMATED/INTERPRETED); a UI test asserts the label renders.
- AC-CI-4: Every insight links ≥1 evidence item and shows confidence and limitations; an
  insight without evidence cannot be stored (DB constraint + test).
- AC-CI-5: No field for revenue, sales, ad budget, conversion rate or demographics
  exists for competitors unless sourced; the generator's schema has no such fields, and a
  test proves an injected "revenue" claim is rejected.
- AC-CI-6: Generated recommendations above the similarity threshold to any evidence
  caption are blocked (unit test with a verbatim copy and a paraphrase).
- AC-CI-7: YouTube collection never exceeds the configured daily quota budget (unit test
  of the quota planner; integration test with a fake API).
- AC-CI-8: No collection path calls a non-allow-listed host (outbound allow-list test).

### Organic automation

- AC-OR-1: No post is published for a workspace whose policy has autopublishing OFF; the
  test matrix covers L1, L2 and L3 per account.
- AC-OR-2: Publishing respects windows, per-day/per-week limits and platform caps under
  concurrent scheduling (concurrency test: N parallel jobs, limit never exceeded).
- AC-OR-3: Emergency stop cancels all queued jobs within 60 s and blocks new ones until
  resumed (integration test); the action is audited.
- AC-OR-4: Validation rejects content violating forbidden words, prohibited topics,
  platform specs or broken links before scheduling.
- AC-OR-5: Tokens are encrypted at rest and never appear in logs, audit metadata or
  prompts (redaction tests + DB inspection test).
- AC-OR-6: Organic connections cannot perform advertising calls (scope separation test).
- AC-OR-7: Every external publish has an idempotency key; a retried job never double-posts
  (fake-platform test returning a timeout after success).

### Paid advertising

- AC-AD-1: A campaign cannot be activated without an authorized approval or a valid L3
  policy covering its budget; the AI task schema cannot express approval (schema test).
- AC-AD-2: Reservations prevent over-commit under concurrency: N concurrent activations
  never exceed the remaining budget (DB-level test).
- AC-AD-3: Reservation uses the platform over-delivery multiplier; platform-level spend
  caps are set when the API supports them (adapter contract test).
- AC-AD-4: Reconciliation adjusts reservations to actual spend; overspend triggers a hard
  stop that pauses all affected campaigns (fake platform; includes pause failure → budget
  lowering → escalation).
- AC-AD-5: Budget increases beyond policy require owner re-authentication (test).
- AC-AD-6: L3 optimizations are limited to the allow-list; a test proves attempts to
  raise caps, add geographies or change objectives are rejected by the policy evaluator.
- AC-AD-7: Conversion objectives cannot activate until test events are verified.
- AC-AD-8: No UI or report promises sales/ROAS; forecasts appear only with a
  platform-provided source and range (copy review + snapshot test).
- AC-AD-9: All ad mutations are audited with actor, policy version, amounts and external
  ids — without tokens or creative text (audit test).

### Unified experience and budgets

- AC-UX-1: Free-text objectives (ar/en) become a typed intake; malformed or unsupported
  objectives are rejected with an explanation; nothing executes from free text.
- AC-UX-2: Every plan activity shows level, cost range, approval need and data basis.
- AC-BU-1: AI/media budget enforced per category with reservation + reconciliation;
  concurrent generations cannot exceed it (test like Phase 4's daily cap).
- AC-BU-2: Owner dashboard shows reserved vs actual vs remaining per category and
  platform, matching the ledger exactly (integration test).

---

## 13. Risks

| Risk                                                                  | Impact                                         | Mitigation                                                                          |
| --------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------------------------------- |
| Meta App Review / Business Verification delayed or refused            | No public IG/FB autopublishing, no managed ads | Start now; L1/L2 fallbacks; complete review documentation and screencasts.          |
| TikTok audit not passed                                               | Posts stay private                             | Inbox-upload flow; set expectations in the UI.                                      |
| Weak lawful competitor data for TikTok/Snapchat/commercial ads in GCC | Incomplete CI                                  | Licensed provider decision; customer-supplied data; transparent coverage indicator. |
| Platform over-delivery vs our caps                                    | Overspend                                      | Worst-case reservation; platform-level spend caps; hard stop.                       |
| Reporting delays / modelled conversions                               | Wrong optimization                             | Data-quality stop; L0 by default; attribution shown.                                |
| Price changes (X, providers)                                          | Margin erosion                                 | Price table versioned in config; budget alerts; per-plan quotas.                    |
| Regulatory exposure (claims, disclosures, PDPL)                       | Legal risk                                     | Legal review gates before 4b and 6; claims checker.                                 |
| Scope size                                                            | Delivery risk                                  | Split 4/4b; platform-by-platform rollout; autonomy last.                            |

## 14. Unresolved human decisions

1. **Phase 4 split:** review and commit the implemented AI engine as Phase 4, and run
   Competitive Intelligence as a separately reviewed step 4b? (Recommended.)
2. **Real AI provider** (text) and **media providers** (image, video) — vendor, data
   processing terms, regions; required before any cost model is final.
3. **Licensed competitor-data provider:** yes/no, budget, vendor shortlist.
4. **Platform priority** for organic and ads (proposed: Meta → Snapchat → Google → TikTok
   for ads; Instagram/Facebook → TikTok → YouTube for organic).
5. **Permission actions** listed in §8 (new actions change the approved matrix).
6. **Default limits:** organic posts per account per day/week; default AI/media monthly
   budget per plan; anomaly thresholds; reconciliation frequency.
7. **Who may approve paid activation:** OWNER only, or OWNER + ADMIN, or a named
   approver role?
8. **Pricing model:** included AI/media credits per plan vs pass-through billing (Stripe
   is currently Phase 15 — paid media at scale may require it earlier).
9. **Legal reviews** (§11): who performs them and when.
10. **Bringing forward** the worker/queue (Phase 9 → 5) and token encryption (Phase 8 → 5).

## 15. Sources consulted (2026-10-09)

Official / platform documentation:

- Meta — Marketing API Access Tier update: https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/
- Meta — Special Ad Categories: https://developers.facebook.com/documentation/ads-commerce/marketing-api/audiences/special-ad-category
- Meta — Instagram content publishing: https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/content-publishing
- TikTok — Content Sharing Guidelines: https://developers.tiktok.com/doc/content-sharing-guidelines
- TikTok — Direct Post API reference: https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post
- TikTok — Research API: https://developers.tiktok.com/products/research-api
- Google Ads API — access levels: https://developers.google.com/google-ads/api/docs/api-policy/access-levels
- YouTube Data API — overview / quota: https://developers.google.com/youtube/v3/getting-started
- Snap — Marketing API: https://developers.snap.com/api/marketing-api

Third-party (used only for [Reported] items):

- Instagram Business Discovery limits: https://www.getphyllo.com/post/instagram-api-guide , https://www.keyapi.ai/blog/instagram-business-discovery-api
- Meta Ad Library API coverage: https://metapi.io/compare/facebook-ad-library-api , https://www.admapix.com/blog/ad-intelligence/meta-ads-library-api-developers
- TikTok Marketing API onboarding: https://unified.to/blog/how_to_get_your_tiktok_ads_api_key
- X API pay-per-use pricing: https://bundle.social/blog/x-api-pricing-2026-costs-limits , https://opentweet.io/how-to/x-api-pay-per-use-explained
- Instagram publishing caps discussion: https://bundle.social/blog/instagram-api-rate-limits
- Snapchat Ads API activation: https://rollout.com/integration-guides/snapchat-ads/api-essentials

# Flexibx — Provider and Integration Comparison (Phases 4–6)

**Status: PROPOSED — DESIGN ONLY. No vendor is selected.** Every choice below is a
[Decision] for the human. Accessed 2026-10-09 unless stated.

Labels:

- **[Confirmed]** = read on the provider's own documentation or pricing page during this
  review.
- **[Reported]** = third-party sources, or an official page we could not open (the
  network proxy blocked `ai.google.dev`, `openai.com`, `docs.dev.runwayml.com`,
  `lumalabs.ai` and `aws.amazon.com` during this review).
- **[Reported — official page via search snippet]** = text of the provider's own page
  as shown by a search engine; not read directly.
- **[Assumption]** = our estimate.

Prices change often; the cost model reads them from a versioned price table, never from
code.

Engineering complexity scale:

- **S** = days, with an adapter behind an existing boundary;
- **M** = 1–3 weeks;
- **L** = more than 3 weeks, or blocked on external review.

---

## 1. AI text / model gateway

| Criterion                           | Anthropic Claude API                                                                                                                                                                     | Google Gemini API                                                                                  | OpenAI API                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Structured generation               | JSON output via tool/schema features; server re-validates regardless [Assumption: verify current structured-output feature]                                                              | JSON schema response mode [Reported]                                                               | JSON schema structured outputs [Reported]      |
| Arabic quality                      | Not measured by us — **evaluation set required** [Assumption]                                                                                                                            | Same                                                                                               | Same                                           |
| Tool-calling reliability            | Not needed for Flexibx's design (closed task enums, server-side tools)                                                                                                                   | —                                                                                                  | —                                              |
| Usage visibility                    | Per-response token usage (`usage` fields) [Confirmed: pricing page shows usage objects]; console usage reports                                                                           | Per-response usage metadata [Reported]                                                             | Per-response usage [Reported]                  |
| Price (per 1M tokens, input/output) | Haiku 5.5: **$0.10 / $0.50** (prompts ≤100K); Sonnet 5.5: **$2 / $10**; Opus 5.5: **$4 / $20**; Batch API −50%; cache hits 0.05–0.1× input [Confirmed, platform.claude.com pricing page] | Flash-Lite ≈ $0.25 / $1.50; Flash ≈ $0.50–1.50 / $3–9; Pro ≈ $2 / $12 [Reported, sources disagree] | Not verified in this review [Reported/unknown] |
| Data residency                      | `inference_geo: "us"` at 1.1× for 4.6+ models [Confirmed]; no Gulf region stated                                                                                                         | Regions via Vertex AI [Reported]                                                                   | Not verified                                   |
| Data/privacy terms                  | Commercial API terms; check training-use and retention terms before selection [Assumption: verify]                                                                                       | Paid tier terms differ from free tier [Reported]                                                   | Not verified                                   |
| Lock-in risk                        | Low with the gateway (adapters are swappable)                                                                                                                                            | Low                                                                                                | Low                                            |
| Complexity                          | S (fits the existing provider boundary)                                                                                                                                                  | S                                                                                                  | S                                              |

**Recommendation:** shortlist two providers; run a 100-item Arabic marketing evaluation
(Gulf/MSA tone, brand voice, claim safety, JSON validity rate). Then choose by quality,
then cost, then terms ([Decision] D2). Route utility tasks to the cheapest model that
passes the bar.

## 2. Image generation

| Criterion                   | OpenAI GPT Image                                                                                                                                                                                                              | Google Gemini image models                                                                                                       | Black Forest Labs FLUX.2                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Quality / brand consistency | To be evaluated with brand references [Assumption]                                                                                                                                                                            | Same                                                                                                                             | Same                                                                                                                       |
| Editing / reference images  | Image input supported (billed as image input tokens) [Reported from the official model page]                                                                                                                                  | Supported in Gemini image models [Reported]                                                                                      | Editing with an input image priced separately (pro ≈ $0.045) [Reported]                                                    |
| Commercial terms            | Review required [Assumption]                                                                                                                                                                                                  | Review required                                                                                                                  | Review required; FLUX.2 [dev] is non-commercial — API models only [Reported]                                               |
| Cost per output             | gpt-image-1: ~$0.011 (low) / $0.042 (medium) / $0.167 (high) at 1024²; ~$0.016–0.25 for 1024×1536 [Reported, official model page snippet]; gpt-image-1 reported retiring 2026-10-23; successors priced differently [Reported] | Gemini 3.x image ≈ $0.08–0.24 per image [Reported]; **Imagen 4 API shut down Aug 2026** [Reported from Google deprecation notes] | FLUX.2 klein ≈ $0.014, pro ≈ $0.03, max ≈ $0.07 per first megapixel (+ per extra MP) [Reported, BFL page snapshot 2026-09] |
| Rate limits                 | Tiered [Assumption]                                                                                                                                                                                                           | Tiered [Assumption]                                                                                                              | Tiered [Assumption]                                                                                                        |
| Complexity                  | S–M                                                                                                                                                                                                                           | S–M                                                                                                                              | S–M                                                                                                                        |

**Planning band:** **$0.03–$0.07 per standard social image**, mid-quality [Assumption
derived from the reported prices]. Selection = [Decision] D3. It needs a blind brand
review of 50 prompts per provider and a commercial-terms check.

## 3. Generative video (Phase 4 — required)

Generative video is a required Phase 4 capability (roadmap §5.1 item 7). This section
compares providers that render video frames with a generative model. Image + voice-over
assembly is **not** a candidate.

**Evidence limits of this review (read first):**

- The network proxy **blocked** the official pricing and documentation pages of Google
  (`ai.google.dev`; the Vertex AI pricing page returned truncated content without Veo
  rows), Runway (`docs.dev.runwayml.com`), Luma (`lumalabs.ai`) and AWS
  (`aws.amazon.com`).
- **No video price below is [Confirmed].**
  - Where a search engine displayed a snippet of the provider's **own** page, the item
    is marked **[Reported — official page via search snippet]**. That is stronger than
    an aggregator, but still unverified.
  - Everything else is [Reported] from third parties, or [Assumption].
- Commercial-use terms, data-use terms and regional availability were **not** read
  from any provider's legal pages. They are open verification items (V1–V8 below)
  before any paid use.

### 3.1 Comparison

| Criterion                    | **Google Veo 3.1 (Vertex AI / Gemini API)**                                                                                                                                                                                                                   | **Runway API**                                                                                                                                                                                              | Luma (Ray2 / Ray3)                                                                                                                                      | Kling (Kuaishou)                                                                                                                      | Amazon Nova Reel (Bedrock)                                       |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Modes                        | Text→video, image→video, reference images, clip extension [Reported]                                                                                                                                                                                          | Text→video and image→video; Gen-4 Turbo is reported as image→video only [Reported]                                                                                                                          | Text/image→video [Reported]                                                                                                                             | Text/image→video [Reported]                                                                                                           | Text/image→video; multi-shot up to 2 min [Reported]              |
| Native audio                 | Yes, incl. dialogue/SFX (priced separately from silent) [Reported]                                                                                                                                                                                            | Gen-4.x: no native audio [Assumption]; Veo 3.1 via Runway with audio [Reported — official page via snippet]                                                                                                 | Not verified                                                                                                                                            | Video 3.0 with native audio [Reported]                                                                                                | No [Assumption]                                                  |
| Price per output second      | Lite ≈ $0.05 (720p) / $0.08 (1080p); Fast ≈ $0.10–0.12 (1080p), $0.30 (4K); Standard ≈ $0.40 (1080p with audio), ≈ $0.20 silent, $0.60 (4K) [Reported; aggregators agree on Standard $0.40 and Fast $0.12; some older pages say $0.75 — **conflict, see V1**] | 1 credit = $0.01; gen4_turbo 5 cr/s ($0.05); gen4.5 12 cr/s ($0.12); veo3.1 40 cr/s with audio ($0.40), 20 without ($0.20); veo3.1_fast 15 / 10 cr/s ($0.15 / $0.10) [Reported — official page via snippet] | Ray2: $0.70 per 5 s 720p, $0.85 per 5 s 1080p (≈ $0.14–0.17/s); Ray2 Flash cheaper [Reported — official page via snippet; may be outdated, Ray3 exists] | ≈ $0.28–0.56 per 5 s standard, ≈ $0.98 per 10 s pro, ≈ $1.68 per 10 s 1080p with audio [Reported, third party only; sources disagree] | ≈ $0.08/s at 720p 24 fps [Reported, third party]                 |
| Durations / resolutions      | 4/6/8 s clips; 720p, 1080p, 4K [Reported]                                                                                                                                                                                                                     | 5–10 s [Reported]; resolution per model                                                                                                                                                                     | 5–9 s; 540p–4K [Reported]                                                                                                                               | 5/10 s; 720p/1080p [Reported]                                                                                                         | 6 s shots; 720p only [Reported]                                  |
| Async API                    | Long-running operation, poll for result [Reported]                                                                                                                                                                                                            | Create task → poll `GET /v1/tasks/{id}`; states PENDING/THROTTLED/RUNNING/SUCCEEDED/FAILED/CANCELLED; THROTTLED is not an error; output URLs are **temporary** [Reported — official dev docs via snippet]   | Async generation [Assumption]                                                                                                                           | Async task [Assumption]                                                                                                               | Async invocation, output written to the customer's S3 [Reported] |
| Spending control at provider | Post-paid cloud billing. Budgets **alert**, they do not stop spend [Reported, general Google Cloud behaviour — verify]; quota limits can be lowered [Assumption]                                                                                              | **Prepaid credits** (a natural provider-side hard cap) [Reported]                                                                                                                                           | Prepaid/billing [not verified]                                                                                                                          | Prepaid resource packs, minimum purchase reported [Reported]                                                                          | AWS Budgets alert; post-paid [Assumption]                        |
| Commercial-use terms         | Not read. Secondary sources say Google claims no ownership of generated content, subject to its Prohibited Use Policy [Reported, secondhand]. **V3**                                                                                                          | Not read. **V4**                                                                                                                                                                                            | Not read                                                                                                                                                | Not read; a China-headquartered provider adds data-transfer review under Saudi PDPL [Assumption]                                      | AWS service terms; not read                                      |
| Provenance / watermark       | SynthID invisible watermark on all frames [Reported, Google DeepMind materials]                                                                                                                                                                               | Not verified                                                                                                                                                                                                | Not verified                                                                                                                                            | Not verified                                                                                                                          | Watermark reported at launch [Assumption]                        |
| Regional limits              | `personGeneration` in EU/UK/CH/**MENA** reported as `allow_adult` only for Veo 3/3.1; some projects report allow-listing friction [Reported, developer forum quoting docs]. **V5**                                                                            | Not verified. **V6**                                                                                                                                                                                        | Not verified                                                                                                                                            | Not verified                                                                                                                          | Limited Bedrock regions at launch (US) [Reported, old]           |
| API access restrictions      | Gemini API tiers and daily quotas (Tier 1 daily quota exhaustion reported) [Reported]; Vertex AI needs a GCP project with billing                                                                                                                             | Developer portal account; API credits separate from web-app plans and not transferable [Reported]                                                                                                           | API key + billing                                                                                                                                       | API resource packs separate from web subscriptions [Reported]                                                                         | AWS account + model access request [Assumption]                  |
| Model churn                  | Veo 2/3 IDs retired mid-2026 [Reported] → versioned routing required                                                                                                                                                                                          | Model list changes; a "model router" exists, billed at the routed model's rate [Reported]                                                                                                                   | Ray2 → Ray3 transition [Reported]                                                                                                                       | Frequent versions [Reported]                                                                                                          | —                                                                |
| Integration complexity       | M (async LRO, GCS/inline output, IAM)                                                                                                                                                                                                                         | M (simple REST tasks, SDK helpers)                                                                                                                                                                          | M                                                                                                                                                       | M                                                                                                                                     | M (S3 output, IAM)                                               |

Not evaluated: **OpenAI Sora** (`openai.com` was blocked, so no evidence could be
gathered) and open-weights models (they need GPU hosting, which is out of scope for
Phase 4).

### 3.2 Cost per 8 s clip (one attempt)

| Option (tier mapping)       | 720p silent                            | 1080p with audio                                        |
| --------------------------- | -------------------------------------- | ------------------------------------------------------- |
| Veo 3.1 Lite (DRAFT)        | ≈ $0.40                                | ≈ $0.64                                                 |
| Veo 3.1 Fast (STANDARD)     | ≈ $0.80                                | ≈ $0.96                                                 |
| Veo 3.1 (PREMIUM)           | —                                      | ≈ $3.20 (≈ $6.00 if the conflicting $0.75/s is current) |
| Runway gen4_turbo / gen4.5  | ≈ $0.40 / ≈ $0.96                      | no native audio                                         |
| Runway veo3.1_fast / veo3.1 | ≈ $0.80 silent                         | ≈ $1.20 / ≈ $3.20                                       |
| Luma Ray2                   | ≈ $1.13 (8 s pro-rated from 9 s price) | not verified                                            |

All figures are [Reported] × duration. The budget model uses the tier rates in
BUDGET_UNIT_ECONOMICS.md §1.2.

### 3.3 Verification items (must be closed before any paid use; no cost to close)

| ID  | Item                                                                                                                                     | How (no spend)                                                                                          |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| V1  | Official Veo 3.1 per-second prices (Lite/Fast/Standard, audio vs silent, 720p/1080p) on the Vertex AI and Gemini API pricing pages       | A human reads the pages; the rate card is filled from them                                              |
| V2  | Official Runway API credit table                                                                                                         | Read the developer portal pricing page                                                                  |
| V3  | Google generative-AI terms for Vertex AI: commercial use of outputs, indemnity, data use/retention, Prohibited Use Policy                | Legal review                                                                                            |
| V4  | Runway API terms: output rights, data use, acceptable use, moderation                                                                    | Legal review                                                                                            |
| V5  | Veo availability in the intended GCP region (data residency, [Decision] D13); `personGeneration` limits for KSA requests; any allow-list | Read the official model/region docs; ask Google sales if unclear                                        |
| V6  | Runway regional and data-processing location                                                                                             | Read docs / ask vendor                                                                                  |
| V7  | Whether failed or refused generations are billed (both providers)                                                                        | Docs + support ticket                                                                                   |
| V8  | Arabic native-speech quality of generated audio                                                                                          | **Not covered** by the US$2.00 smoke test (audio off); needs a separately approved budget or pilot data |

### 3.4 Recommendation ([Decision] D9 — not approved)

**Primary: Google Veo 3.1 on Vertex AI**, behind the provider-neutral video gateway.
Use the Gemini API only for development if Vertex onboarding is slower.

Reasons:

1. One model family covers all three quality tiers (Lite / Fast / Standard). This
   maps directly to DRAFT / STANDARD / PREMIUM with the lowest reported DRAFT price
   (≈ $0.05/s).
2. It supports text→video and image→video with reference images, so brand product
   photos can anchor the output.
3. Native audio is available, and silent output is cheaper when we overlay our own
   captions.
4. Vertex AI gives enterprise terms, IAM, regional endpoints and quota controls, which
   fit PDPL and data-residency work (D13).
5. SynthID provenance supports AI-content disclosure.

**Alternative: Runway API.**

- It uses **prepaid credits**, a provider-side hard cap that Vertex lacks.
- Its task API is simple and well documented.
- It offers both its own models and Veo 3.1 (at a slightly higher reported Fast price
  of $0.15/s vs $0.12/s).
- Choose Runway instead if V3/V5 fail (terms or region), or if the owner prefers a
  provider-side hard cap over Vertex's post-paid billing.
- Building the second adapter is optional in Phase 4.

**Trade-offs accepted with the primary:**

- Post-paid billing means **our** ledger, the operator ceiling and lowered quotas are
  the hard caps; cloud budget alerts are only alerts.
- MENA person-generation limits may restrict some creative briefs.
- Prices and model IDs change, which requires a versioned rate card and routing.

**This recommendation is provisional.** No price, term or regional fact behind it was
read on an official page in this review. If V1, V3 or V5 come back unfavourable, the
recommendation flips to Runway or is re-opened. No account is created and no paid call
is made until the owner approves D9 and the US$2.00 smoke-test plan D16 (§3.5).
Under the US$2.00 cap, **Runway is excluded** while its reported US$10 minimum purchase
stands. Veo 3.1 Lite is the only candidate that fits.

### 3.5 Phase 4 video smoke test — hard cap US$2.00 (D16)

**Owner-set limit (2026-10-09):** at most **US$2.00 in total** across all paid
generative-video smoke tests, all runs and all providers combined, including taxes and
any chargeable failed attempts. It is a hard spending cap, not a target. **Paid tests
stay disabled until the owner explicitly approves the provider and this test plan.**

#### 3.5.1 Preconditions (all must be true before the first paid request)

| ID  | Precondition                                                                                                                                                                                                            | Status today                                                                                                                                              |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1  | Per-second price of the exact model, resolution, audio setting and duration, read on the provider's **official** pricing page, with the URL and access date stored in the rate card                                     | **Not met:** official pages blocked; prices [Reported] only (V1)                                                                                          |
| S2  | Billing behaviour of failed, safety-filtered and timed-out generations is known, or assumed fully chargeable in the reservation                                                                                         | Unknown (V7). One developer-forum report says a user was charged for attempts that produced no video [Reported, unconfirmed]. **Assume chargeable.**      |
| S3  | No minimum charge, minimum prepaid purchase or subscription above the remaining cap is needed to make the call                                                                                                          | Vertex AI: none known for pay-as-you-go [Assumption]. **Runway: minimum API credit purchase reported as US$10** [Reported, third party] → exceeds the cap |
| S4  | The request can be pinned so that one call cannot bill more than the reserved amount: one output (`sampleCount`/number of videos = 1), fixed duration, fixed resolution, audio off, and no provider-side auto-extension | Parameters reported for Veo [Reported]; must be confirmed in the official API reference                                                                   |
| S5  | Client-library automatic retries are disabled. Only our ledger decides whether to resubmit                                                                                                                              | Design requirement (architecture §4.2.3)                                                                                                                  |
| S6  | Tax treatment known. If the invoice adds VAT (e.g. 15% in KSA [Assumption]), the reservation includes it                                                                                                                | Unknown → reserve with +15%                                                                                                                               |
| S7  | Actual charges can be read back (billing report or usage API) to reconcile the ledger                                                                                                                                   | Vertex AI: Cloud Billing reports, with a reporting lag of hours [Assumption]                                                                              |
| S8  | Owner approval of D9 (provider) and D16 (this plan) is recorded                                                                                                                                                         | Not given                                                                                                                                                 |

**Result today: preconditions S1, S2 (only by assumption), S3, S4, S7 and S8 are not
verified. A paid test is not allowed.** See the no-spend plan in §3.5.6.

#### 3.5.2 Which provider can enforce the cap

| Provider                         | Can the US$2.00 cap be enforced safely?                                                                                                                  | Reason                                                                                                                                                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Veo 3.1 Lite on Vertex AI | **Conditionally yes, after S1, S4 and S7 are verified.** Enforcement is entirely **ours**: Google Cloud is post-paid, and budgets only alert [Reported]. | The cheapest reported configuration fits about 8 times within US$2.00. One sequential attempt at a time keeps the worst case bounded by our reservation, provided one request cannot bill more than duration × rate × 1 sample. |
| Runway API                       | **No — excluded under this cap**                                                                                                                         | A reported US$10 minimum credit purchase exceeds US$2.00 before any test (S3). Re-evaluate only if the official portal shows a purchase ≤ US$2.00.                                                                              |
| Kling                            | **No**                                                                                                                                                   | Prepaid packs with a reported US$9.80 minimum [Reported]; prices unverified                                                                                                                                                     |
| Luma                             | **No**                                                                                                                                                   | Official pricing not readable; Ray2/Ray3 transition; minimum purchase unknown                                                                                                                                                   |
| Amazon Nova Reel                 | Not now                                                                                                                                                  | Price unverified; fixed 6 s shots at a reported US$0.08/s = US$0.48 per attempt; post-paid                                                                                                                                      |

There is **no automatic switch to another paid provider**. If the selected provider
fails, the run stops, and a new decision is needed.

#### 3.5.3 What fits in US$2.00

Per-attempt reservation:

`duration × verified rate × 1 sample × (1 + tax)`, rounded **up** to the cent, plus
any minimum charge.

Every attempt that reaches the provider is reserved as fully chargeable, including
failed, refused and timed-out attempts.

| Configuration (rates [Reported]; must be re-computed with verified rates) | Per attempt (pre-tax / +15%) | Attempts that fit in US$2.00 | Verdict                                                            |
| ------------------------------------------------------------------------- | ---------------------------- | ---------------------------- | ------------------------------------------------------------------ |
| **Veo 3.1 Lite, 720p, silent, 4 s**                                       | **$0.20 / $0.23**            | **8**                        | **Proposed**                                                       |
| Veo 3.1 Lite, 720p, silent, 8 s                                           | $0.40 / $0.46                | 4                            | Possible, less margin                                              |
| Veo 3.1 Lite, 1080p, 4 s                                                  | $0.32 / $0.37                | 5                            | Not needed for the evidence                                        |
| Veo 3.1 Fast, 1080p, audio, 4 s                                           | $0.48 / $0.56                | 3                            | Only if audio/Arabic speech (V8) must be tested; separate approval |
| Veo 3.1 Standard, 1080p, audio, 4 s                                       | $1.60 / $1.84                | 1, with no retry possible    | **Rejected**: a single failure exhausts the cap                    |
| Veo 3.1 Standard at the conflicting $0.75/s, 4 s                          | $3.00 / $3.45                | 0                            | Does not fit                                                       |

#### 3.5.4 Proposed test configuration (for approval; disabled until then)

| Setting          | Value                                                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider / model | Google Veo 3.1 **Lite** on Vertex AI (D9), only after S1–S8                                                                                                                                                                                                                                                         |
| Mode             | **Text-to-video only.** It is the single minimal test with useful evidence: a real model renders a real clip end to end through our gateway, queue, poll, download, validation, storage, ledger and audit                                                                                                           |
| Output           | 1 video (`sampleCount` = 1), **4 s, 720p, 16:9, audio off**                                                                                                                                                                                                                                                         |
| Prompt           | Fixed, brand-neutral, no people, no logos and no text in frame. This avoids safety refusals and MENA person-generation limits                                                                                                                                                                                       |
| Attempts         | **Planned: 1. Maximum: 3** (the first attempt plus 2 retries, only for a provider failure or invalid output; never after a safety refusal)                                                                                                                                                                          |
| Reservation      | $0.23 per attempt (with 15% tax margin). The worst case for the plan is **$0.69**; expected spend is **$0.20–0.23**                                                                                                                                                                                                 |
| Budget ledger    | A dedicated platform-level `SMOKE_VIDEO` budget with a lifetime total of US$2.00. Reservations are made under a row lock, so concurrent requests cannot together exceed what remains. The smoke runner uses concurrency 1 as well                                                                                   |
| Stop rule        | Before every attempt: if `remaining < next reservation` → stop and submit nothing. Also stop at the first unexplained charge, at any OUTCOME_UNKNOWN until reconciled, and at the first safety refusal                                                                                                              |
| Image-to-video   | **Not promised.** It is covered with no spend (fake provider + payload dry run). A paid image-to-video run (+$0.23 per attempt) needs **separate** approval and is allowed only if the remaining budget covers its full worst case                                                                                  |
| Post-processing  | Crop to 9:16 and 1:1, poster frame, ffprobe validation. CPU only, no provider cost                                                                                                                                                                                                                                  |
| Reconciliation   | Record the provider operation id. When billing data appears, compare the billed amount with the captured amount. Any difference above $0.01 is recorded. **If the billed amount exceeds the reservation, no further paid test runs** until a human reviews it. The run counts as complete only after reconciliation |
| Off switch       | Paid video calls are refused unless (a) the owner approval is recorded, (b) the provider credential exists only in the protected smoke environment, and (c) the smoke budget has room. Default: off                                                                                                                 |

Remaining unspent budget after the planned test: ≥ $1.31 (worst case), kept unused as
a margin against pricing error. It is not spent automatically.

#### 3.5.5 Verified vs unverified costs

| Item                                                                       | Status                                                                  |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Veo 3.1 Lite $0.05/s (720p), $0.08/s (1080p)                               | **Unverified** [Reported, aggregators]                                  |
| Veo 3.1 Fast $0.10–0.12/s; Standard $0.40/s (with audio), $0.20/s (silent) | **Unverified** [Reported]; Standard also reported at $0.75/s (conflict) |
| Runway $0.01 per credit; gen4_turbo 5 cr/s; veo3.1 40 cr/s                 | **Unverified** [Reported — official page via snippet]                   |
| Runway US$10 minimum API purchase                                          | **Unverified** [Reported, third party]                                  |
| Whether failed/refused Veo generations are billed                          | **Unknown**; one user report of charges without output [Reported]       |
| Billing is by requested output duration                                    | **Unverified** [Reported]                                               |
| `sampleCount` multiplies cost                                              | **Unverified** [Assumption: yes]                                        |
| Tax on the invoice                                                         | **Unknown** [Assumption: up to 15%]                                     |
| Anthropic text prices (not part of this test)                              | Confirmed earlier, not relevant to the cap                              |

**No cost that the US$2.00 cap depends on is verified today.** The cap therefore
**cannot be demonstrated as safely enforceable yet**.

#### 3.5.6 Recommended now: no-spend validation plan

These steps carry no provider charges, and none needs a provider account unless noted:

1. **Fake video provider matrix.** Run every scenario in architecture §4.2.4 through
   the real gateway, queues, ledger, audit and kill switch (P4-AC12–AC17).
2. **Payload dry run.** The real Veo adapter builds the exact request for the proposed
   configuration (model id, 4 s, 720p, `sampleCount` 1, audio off) and validates it
   against the official API reference, with sending disabled. A test asserts the
   computed reservation and that the adapter refuses any payload whose worst case
   exceeds the remaining smoke budget.
3. **Ledger cap tests.**
   - With a US$2.00 lifetime budget and a $0.23 reservation, 8 and 20 concurrent
     attempts never reserve more than $2.00.
   - The 9th attempt is refused.
   - An OUTCOME_UNKNOWN reservation is never released automatically.
   - No fallback provider is ever selected.
4. **Post-processing on a local fixture.** An MP4 generated locally (e.g. an FFmpeg
   test pattern) goes through download validation, ffprobe, crop and storage.
5. **Human verification of S1–S7** from official pages and documentation, plus a
   billing-support question for S2 if the documentation is silent. The rate card
   stores each source URL and access date.
6. **Optional, needs approval, no generation:** a credentials and region check with a
   zero-cost call (e.g. listing models). Whether such a call is free must itself be
   confirmed first [Assumption].

When steps 1–5 pass and S1–S8 are met, the single paid test in §3.5.4 can be proposed
for approval. Until then, P4-AC7 stays **open**, and Phase 4 cannot be completed
(roadmap §5.10). Whether to wait or to change the gate is the owner's decision (D18).

## 4. Speech and audio (optional — not on the Phase 4 critical path)

| Criterion                                                                                  | ElevenLabs                                                                                | Microsoft Azure AI Speech                                                                                                  | Google Cloud TTS/STT                             |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| TTS price                                                                                  | ≈ $0.05 (Flash/Turbo) to $0.10 (Multilingual) per 1K characters [Reported]                | Neural ≈ $15 per 1M characters (= $0.015/1K) [Reported]; China-region official page ¥95.4/1M [Confirmed for azure.cn only] | Not verified [Assumption]                        |
| Arabic dialects                                                                            | Regional Arabic accents claimed (incl. Saudi listings on third-party catalogs) [Reported] | Arabic locales including Saudi voices [Reported/Assumption: verify voice list]                                             | Arabic voices [Assumption]                       |
| Voice licensing                                                                            | Commercial use needs a paid plan; library/cloned voice terms need review [Reported]       | Standard neural voices licensed for use; custom voices need approval [Assumption]                                          | Assumption                                       |
| Transcription (only for user-uploaded videos; our own videos use script-derived subtitles) | Scribe — price not found [Reported gap]                                                   | Per-minute, price not verified                                                                                             | Chirp ≈ $0.004–0.016/min [Reported, conflicting] |
| Complexity                                                                                 | S                                                                                         | S                                                                                                                          | S                                                |

**Planning band:** **TTS $0.015–$0.10 per 1K characters**; **STT $0.003–$0.016 per
minute** [Reported ranges, e.g. AssemblyAI ≈ $0.0025/min, OpenAI mini-transcribe ≈
$0.003/min, Deepgram ≈ $0.0077/min]. TTS is **not** used to produce Phase 4 videos
(generative video provides native audio, or is silent with captions). Selection is
[Decision] D5, only if native generated speech fails the Arabic evaluation (V8).

## 5. Infrastructure

### 5.1 Job queue

| Option                             | Reliability                                                                                                         | Ops complexity                                           | Cost                                                                                                                                                                                             | Notes                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **pg-boss (PostgreSQL)**           | Uses `SKIP LOCKED`; jobs can be enqueued in the same DB transaction as the business change [Reported, package docs] | Lowest (no new system)                                   | No extra service; adds DB load                                                                                                                                                                   | Rule of thumb: fine below ~1,000 jobs/s [Reported]. Fits Flexibx volumes. **Recommended for Phases 4–5** |
| BullMQ + Redis                     | Rich features (flows, rate limits, priorities); durability depends on Redis persistence settings [Reported]         | Medium (Redis ops, persistence config)                   | Managed Redis e.g. Upstash: $0.20 per 100K commands pay-as-you-go, or fixed plans from $10/month; Upstash recommends fixed plans for polling queues like BullMQ [Confirmed, upstash.com pricing] | Natural upgrade path                                                                                     |
| Managed queue (AWS SQS or similar) | Durable, at-least-once                                                                                              | Medium (outbox pattern needed for transactional enqueue) | Per-request pricing [Assumption: low at our volumes]                                                                                                                                             | Ties the deployment to a cloud vendor                                                                    |

### 5.2 Object storage

| Option              | Price                                                                               | Notes                                                                 |
| ------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Cloudflare R2       | ≈ $0.015/GB-month, Class A ≈ $4.50/M, Class B ≈ $0.36/M, **zero egress** [Reported] | S3-compatible: the existing S3 adapter works. Good for video delivery |
| AWS S3              | Storage + egress pricing [Assumption: verify current rates]                         | Already the default driver                                            |
| MinIO (self-hosted) | Infra cost only                                                                     | Dev/test today                                                        |

### 5.3 Technical video post-processing / transcoding

| Option                           | Cost                                                                                                                                          | Notes                                                                      |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| **FFmpeg in a worker container** | CPU time only [Assumption: cents per video]                                                                                                   | Transcode/crop/concat/overlay of **generated** clips only; **recommended** |
| AWS Elemental MediaConvert       | Per output minute with resolution/codec multipliers; Basic tier launched at $0.0075/min (2018) [Confirmed historical; current rate to verify] | Encoding only; storage/CDN extra                                           |
| Mux                              | Basic on-demand encoding free; storage from $0.003 per minute-month; delivery priced separately [Reported, mux.com docs]                      | Managed video platform; more than we need for upload-to-social             |

### 5.4 Observability

| Option                                                | Cost                                        | Notes                             |
| ----------------------------------------------------- | ------------------------------------------- | --------------------------------- |
| Sentry (errors/traces)                                | Team ≈ $26/month with 50K errors [Reported] | Fast setup                        |
| OpenTelemetry + a hosted backend (e.g. Grafana Cloud) | Free tier, then usage-based [Assumption]    | Vendor-neutral                    |
| Logs: existing pino JSON → hosting log drain          | Hosting-dependent                           | Already structured with redaction |

### 5.5 Secrets and keys

| Option                                                           | Notes                                                                                                                                                                                           |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Environment variables (today)                                    | Fine for provider API keys in a managed host's secret store                                                                                                                                     |
| **KMS envelope encryption** for OAuth tokens (AWS KMS / GCP KMS) | Data keys encrypt tokens; the master key never leaves the KMS; rotation supported [Assumption on cost: about $1 per key-month plus requests]. **Recommended before production** ([Decision] D7) |
| Vault/Doppler                                                    | More ops/vendor surface; not needed initially                                                                                                                                                   |

---

## 6. Social networks (organic publishing and analytics)

| Network                                     | OAuth & account types                                                                                                                        | App review / verification                                                                                                                                                                                                                                                              | Publishing capability                                                                               | Media constraints                          | Analytics                                                                    | Limits                                                                                                                                      | Token lifecycle                                                                   | Complexity  |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | ----------- |
| **Facebook Pages** (Meta)                   | Facebook Login for Business; a Page access token per Page via `/me/accounts`; the user needs the CREATE_CONTENT task on the Page [Confirmed] | `pages_manage_posts` (+ `pages_read_engagement`, `pages_show_list`, `pages_manage_metadata`) through App Review; Business Verification commonly required [Confirmed permissions; review details Reported]                                                                              | `POST /{page_id}/feed` publishes immediately; scheduled publishing options exist [Confirmed]        | Per Graph API docs [verify per media type] | Page and post insights with permissions [Assumption: verify]                 | Graph API rate limits [verify]                                                                                                              | Long-lived Page tokens; revocation via deauthorize callbacks [Assumption: verify] | M           |
| **Instagram** (Meta, professional accounts) | Instagram professional (Business/Creator) accounts; Facebook or Instagram Login [Reported]                                                   | `instagram_content_publish` through App Review [Confirmed name; review Reported]                                                                                                                                                                                                       | Container → `media_publish` flow; carousels count as one post [Confirmed]                           | Per media type [verify]                    | Media/account insights; `impressions` replaced by `views` (2025) [Confirmed] | Per-account rolling 24 h publish cap — the docs show 50 and 100 in different sections; read `content_publishing_limit` [Confirmed endpoint] | As Meta tokens                                                                    | M           |
| **TikTok**                                  | TikTok account OAuth (Login Kit) [Reported]                                                                                                  | Content Posting API audit; **unaudited clients: SELF_ONLY visibility, ≤5 posting users/24 h, private accounts only** [Confirmed, TikTok docs updated 2026-08-04]                                                                                                                       | Direct Post, or Upload (draft to the creator's inbox) [Confirmed]                                   | Video/photo specs per docs [verify]        | Own-account data via Display API [Reported]                                  | Per-creator daily caps per the audit estimate [Confirmed concept]                                                                           | Refresh tokens [Assumption: verify expiry]                                        | M–L (audit) |
| **YouTube**                                 | Google OAuth (channel owner)                                                                                                                 | OAuth app verification for sensitive scopes [Assumption]; quota extension by form, not purchase [Reported]                                                                                                                                                                             | `videos.insert` (Shorts are vertical short videos) [Assumption: Shorts classification is automatic] | Per upload specs                           | YouTube Analytics API [Assumption]                                           | Default 10,000 units/day/project; `search.list` = 100 units; upload ≈ 1,600 units [Confirmed default quota; upload cost Reported]           | Refresh tokens; revocation [Assumption]                                           | M           |
| **LinkedIn** (organization pages)           | 3-legged OAuth; `w_organization_social`; the member needs an admin/content role on the Page [Reported]                                       | Community Management API: Development tier review (verified business email, organization, website, Page), then Standard tier with a screen recording; a rejected app cannot re-apply [Confirmed, Microsoft Learn]; Community Management must be the only product on its app [Reported] | Posts API for organizations [Reported]                                                              | Per docs [verify]                          | Organization share statistics [Assumption]                                   | [verify]                                                                                                                                    | Access tokens ≈ 60 days [Reported]                                                | L (review)  |
| X (optional)                                | OAuth 2.0                                                                                                                                    | Developer account, prepaid credits                                                                                                                                                                                                                                                     | Post creation ≈ $0.015, posts with a URL ≈ $0.20 [Reported]                                         | —                                          | Paid reads ≈ $0.005/post [Reported]                                          | Monthly read caps [Reported]                                                                                                                | —                                                                                 | S–M + cost  |
| Snapchat                                    | —                                                                                                                                            | —                                                                                                                                                                                                                                                                                      | **No organic publishing API** (Marketing API excludes organic Snaps) [Reported]                     | —                                          | —                                                                            | —                                                                                                                                           | —                                                                                 | Excluded    |

**Priority proposal** ([Decision] D6):

1. Meta (FB + IG): largest SMB reach, one review process.
2. TikTok: high value, but private-only until the audit.
3. YouTube Shorts: quota-bound, simple review.
4. LinkedIn: B2B value, long review.

X is optional (cost per post). No browser automation as a substitute for any network.

## 7. Paid advertising APIs (for the gated track, [Decision] D12)

Carried over from PHASES_4_6_PRODUCT_DESIGN.md §6.2:

- **Meta Marketing API:** access tiers renamed on 2026-05-04 to Limited/Full; Full needs
  ≥500 calls in 15 days and <15% errors [Confirmed, Meta blog].
- **Google Ads API:** Basic 15,000 operations/day; Standard unlimited [Confirmed].
- **Snapchat Ads API:** "open to all developers" [Confirmed].
- **TikTok Marketing API:** approval required, multi-week [Reported].

The API calls are free; ad spend is paid by the customer to the platform.

## 8. Sources (accessed 2026-10-09)

Official:

- Anthropic pricing — https://platform.claude.com/docs/en/about-claude/pricing
- Upstash Redis pricing — https://upstash.com/pricing/redis
- Meta Marketing API Access Tier — https://developers.meta.com/blog/updates-to-ads-management-standard-access-feature/
- Meta Pages API (manage pages / get started) — https://developers.facebook.com/docs/pages-api/manage-pages , https://developers.facebook.com/docs/pages-api/getting-started
- Instagram content publishing — https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/content-publishing
- Instagram changelog / media insights — https://developers.facebook.com/docs/instagram-platform/changelog , https://developers.facebook.com/docs/graph-api/changelog/version22.0
- TikTok content sharing guidelines / Direct Post — https://developers.tiktok.com/doc/content-sharing-guidelines , https://developers.tiktok.com/docs/en/content-posting-api-reference-direct-post
- LinkedIn Community Management app review — https://learn.microsoft.com/en-us/linkedin/marketing/community-management-app-review
- Google Ads API access levels — https://developers.google.com/google-ads/api/docs/api-policy/access-levels
- YouTube Data API overview — https://developers.google.com/youtube/v3/getting-started
- Snap Marketing API — https://developers.snap.com/api/marketing-api
- AWS MediaConvert pricing — https://aws.amazon.com/mediaconvert/pricing
- Mux pricing docs — https://www.mux.com/docs/pricing/video
- OpenAI GPT Image 1 model page (snippet; page not directly reachable) — https://developers.openai.com/api/docs/models/gpt-image-1

Official, seen only through search-engine snippets (blocked by the proxy):

- Runway API pricing — https://docs.dev.runwayml.com/guides/pricing/
- Runway task API / dev context — https://docs.dev.runwayml.com/ai-context.md
- Luma API pricing — https://lumalabs.ai/api/pricing
- Google Vertex AI generative AI pricing (fetched, Veo rows not returned) — https://cloud.google.com/vertex-ai/generative-ai/pricing
- Amazon Nova pricing — https://aws.amazon.com/nova/pricing

Third-party (used only for [Reported] items):

- Gemini pricing aggregators — https://www.morphllm.com/gemini-api-pricing , https://deploybase.ai/articles/gemini-api-pricing-2026
- Imagen 4 shutdown / Gemini image pricing — https://aicybr.com/blog/imagen-4-api-shutdown-migrate-gemini-image , https://pricepertoken.com/imagen-pricing
- FLUX pricing — https://developer.puter.com/tutorials/flux-api-pricing/ , https://pricepertoken.com/flux-pricing
- GPT Image pricing tracker — https://pricepertoken.com/gpt-image-pricing
- Veo 3.1 pricing — https://benchlm.ai/media-pricing/veo , https://openrouter.ai/google/veo-3.1 , https://www.atlascloud.ai/blog/tips/veo-3.1-api-pricing , https://framesurfer.com/blogs/veo-3-pricing
- Veo regional `personGeneration` limits (developer forum) — https://discuss.ai.google.dev/t/veo-3-1-safety-reasons-explanation/169015
- SynthID — https://deepmind.google/discover/blog/watermarking-ai-generated-text-and-video-with-synthid
- Runway API pricing — https://creatify.ai/blog/runway-pricing-(2026)-plans-credits-and-what-you-ll-actually-pay , https://apiframe.ai/guides/runway-api-guide
- Kling API pricing — https://www.atlascloud.ai/blog/tips/kling-ai-api-pricing
- Runway minimum API credit purchase — https://costbench.com/software/ai-media-apis/runway-api/
- Report of Vertex AI charges without output (forum) — https://discuss.ai.google.dev/t/charged-for-nothing-in-vertex-ai/107900
- Veo billing by requested duration / audio pricing — https://wavespeed.ai/blog/cost-and-billing/google-veo-3-pricing/ , https://akool.com/blog-posts/google-veo-3-1-cost-guide
- Amazon Nova Reel — https://www.kapwing.com/resources/amazon-nova-reel-guide-to-creating-ai-videos/
- ElevenLabs API pricing — https://developer.puter.com/tutorials/elevenlabs-api-pricing/ , https://elevenlabs.io/blog/best-arabic-text-to-speech
- Azure Speech pricing — https://azure.microsoft.com/pricing/details/cognitive-services/speech-services , https://www.azure.cn/en-us/pricing/details/cognitive-services/
- STT pricing comparison — https://convertaudiototext.com/blog/speech-to-text-api-pricing-2026 , https://assemblyai.com/blog/speech-to-text-api-pricing
- Cloudflare R2 pricing — https://flarecalc.com/calculators/r2
- pg-boss / queues — https://npmjs.com/package/pg-boss , https://www.pkgpulse.com/guides/bullmq-vs-bee-queue-vs-pg-boss-job-queues-nodejs-2026
- Sentry pricing — https://www.koji.so/blog/sentry-alternatives-2026
- LinkedIn posting permissions — https://bundle.social/blog/linkedin-api-permissions
- Facebook posting permissions — https://bundle.social/blog/facebook-api-permissions
- X API pricing — https://bundle.social/blog/x-api-pricing-2026-costs-limits
- Instagram publish limits discussion — https://bundle.social/blog/instagram-api-rate-limits

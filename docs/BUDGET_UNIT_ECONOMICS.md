# Flexibx — Budget Model and Unit Economics (Phases 4–6)

**Status: PROPOSED — DESIGN ONLY.** Prepared 2026-10-09. No provider is selected, so all
totals are **ranges** built from labelled unit prices. Only the Anthropic text prices
were read on the provider's own pricing page during this review [Confirmed]. The rest
are [Reported] (third-party or unreachable official pages) or [Assumption]. Sources:
[PROVIDER_INTEGRATION_COMPARISON.md §8](PROVIDER_INTEGRATION_COMPARISON.md).

**Revision 2026-10-09:** generative video is a required Phase 4 capability. All
"assembled video" lines, together with the TTS and render lines that existed only to
support them, are removed. **No generative-video price is [Confirmed]**: the official
pages were blocked during this review (provider doc §3). The video figures below are
provisional until verification item V1/V2 and the paid smoke test (D16, hard cap
US$2.00 total; provider doc §3.5) replace them with billed costs. A single 4 s DRAFT
clip verifies one rate only; the other tiers stay [Reported] until pilot billing.

## 1. Unit prices used

| Unit                                                           | Low         | High       | Basis                                                                                                                           |
| -------------------------------------------------------------- | ----------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Creative text call (Arabic; 4,000 input + 1,500 output tokens) | **$0.023**  | $0.023     | Sonnet 5.5 at $2 / $10 per 1M tokens [Confirmed price] × token assumption [Assumption]. A different provider changes this line. |
| Utility text call (3,000 in + 800 out)                         | **$0.0007** | $0.0007    | Haiku 5.5 at $0.10 / $0.50 per 1M [Confirmed price] × [Assumption]                                                              |
| Planning/report call (12,000 in + 3,000 out)                   | **$0.054**  | $0.054     | Sonnet 5.5 [Confirmed price] × [Assumption]                                                                                     |
| Text overhead (regenerations, retries, validation re-asks)     | +30%        | +30%       | [Assumption]                                                                                                                    |
| Image (social size, mid quality)                               | **$0.03**   | **$0.07**  | FLUX.2 pro ≈ $0.03/MP; GPT Image medium ≈ $0.042; Gemini image ≈ $0.08 [Reported] → planning band [Assumption]                  |
| Generative video (per output second)                           | **$0.05**   | **$0.40**  | By tier, see §1.2 [Reported]                                                                                                    |
| Video post-processing (FFmpeg, per clip, 3 aspect ratios)      | **$0.005**  | $0.01      | CPU seconds on a worker [Assumption]                                                                                            |
| Object storage (GB-month)                                      | **$0.015**  | **$0.023** | R2 ≈ $0.015 [Reported]; S3-class ≈ $0.023 [Assumption]                                                                          |
| Social publishing APIs (Meta, TikTok, YouTube, LinkedIn)       | $0          | $0         | No per-call fee found [Reported]; X excluded (≈ $0.015–0.20 per post [Reported])                                                |

### 1.2 Generative video model

**Tiers and rate card** (versioned configuration; Veo 3.1 mapping from the provider-doc
recommendation, [Decision] D9/D17):

| Tier     | Model (proposed) | Output       | Rate used   | Basis                                                                                 |
| -------- | ---------------- | ------------ | ----------- | ------------------------------------------------------------------------------------- |
| DRAFT    | Veo 3.1 Lite     | 720p, silent | **$0.05/s** | [Reported]                                                                            |
| STANDARD | Veo 3.1 Fast     | 1080p, audio | **$0.12/s** | [Reported]; Runway's veo3.1_fast with audio $0.15/s [Reported — official via snippet] |
| PREMIUM  | Veo 3.1          | 1080p, audio | **$0.40/s** | [Reported]; older pages say $0.75/s (conflict, V1)                                    |

**Video credits.** Allowances are expressed in credits, where **1 video credit =
$0.05 of provider cost**, which is one DRAFT second. One STANDARD second costs 2.4
credits and one PREMIUM second costs 8 credits. Credits are converted from the rate
card at reservation time; a price change updates the conversion, not the plan.

**Attempts** [Assumption, to be replaced with pilot data]:

- **Expected 1.5 attempts per accepted clip.** This covers automatic retries and
  human regenerations.
- **Per-request worst case: 2 attempts** (`maxAttempts`).
- **Per-accepted-clip worst case for sensitivity: 3 attempts.**

**Failed jobs:**

- Every attempt that reaches the provider is budgeted as **charged**, including
  provider failures, safety refusals and outputs that fail validation. The cost is
  released only if the provider confirms no charge (V7).
- Throttled or queued states, and rejections before submission, cost nothing.
- OUTCOME_UNKNOWN keeps the reservation held until reconciled.

**Cost per delivered 8 s clip:**

| Tier     | 1.0 attempt | **1.5 attempts (expected)** | 3.0 attempts (worst) |
| -------- | ----------- | --------------------------- | -------------------- |
| DRAFT    | $0.40       | **$0.60**                   | $1.20                |
| STANDARD | $0.96       | **$1.44**                   | $2.88                |
| PREMIUM  | $3.20       | **$4.80**                   | $9.60                |

A 32 s cut (4 generated clips concatenated by post-processing) costs, expected: DRAFT
$2.40, STANDARD $5.76, PREMIUM $19.20.

**Per-request worst case** (reserved before submission; maximum 4 clips × 8 s × 2
attempts): DRAFT $3.20, STANDARD $7.68, PREMIUM $25.60. Everything above the
per-request approval threshold (default $5 [Assumption]), and every PREMIUM request,
needs approval (category C).

## 2. Usage scenarios (per workspace per month)

| Quantity                                    | Starter     | Growth       | Heavy         |
| ------------------------------------------- | ----------- | ------------ | ------------- |
| Published content items                     | 20          | 60           | 200           |
| Networks per item                           | 2           | 3            | 5             |
| Creative text calls (3 per item)            | 60          | 180          | 600           |
| Utility text calls (3 per item per network) | 120         | 540          | 3,000         |
| Planning/report calls                       | 6           | 15           | 40            |
| Image candidates (per item × items)         | 3 × 20 = 60 | 4 × 60 = 240 | 4 × 200 = 800 |
| Generative clips delivered — DRAFT (8 s)    | 6           | 8            | 20            |
| Generative clips delivered — STANDARD (8 s) | 0           | 4            | 15            |
| Generative clips delivered — PREMIUM (8 s)  | 0           | 0            | 3             |
| Video credits used (expected, 1.5 attempts) | 72          | 211          | 960           |
| Storage (GB, end of month)                  | 2           | 15           | 80            |

### 2.1 Variable cost per workspace (USD / month)

| Line                                | Starter          | Growth            | Heavy              |
| ----------------------------------- | ---------------- | ----------------- | ------------------ |
| Text (incl. +30%)                   | 2.32             | 6.93              | 23.48              |
| Images                              | 1.80 – 4.20      | 7.20 – 16.80      | 24.00 – 56.00      |
| Generative video (expected)         | 3.60             | 10.56             | 48.00              |
| Storage                             | 0.03 – 0.05      | 0.23 – 0.35       | 1.20 – 1.84        |
| Social APIs                         | 0                | 0                 | 0                  |
| **Total variable (expected video)** | **≈ 7.8 – 10.2** | **≈ 24.9 – 34.6** | **≈ 96.7 – 129.3** |
| Video at worst-case attempts (×2)   | 7.20             | 21.12             | 96.00              |

Video lines: Starter 6 × $0.60; Growth 8 × $0.60 + 4 × $1.44; Heavy 20 × $0.60 + 15 ×
$1.44 + 3 × $4.80. Post-processing CPU is in the fixed worker line.

(The text calculation for Starter, as an example: (60 × 0.023 + 120 × 0.0007 + 6 × 0.054) ×
1.3 = (1.38 + 0.084 + 0.324) × 1.3 ≈ 2.32.)

### 2.2 Fixed platform costs (USD / month, all workspaces) [Assumption]

| Line                                         | Range           | Notes                                                |
| -------------------------------------------- | --------------- | ---------------------------------------------------- |
| App hosting (2 instances)                    | 40 – 150        | Region/provider decision                             |
| Workers incl. video poll/post-processing CPU | 40 – 200        | Scales with video volume (semi-variable)             |
| Managed PostgreSQL (+ backups)               | 30 – 150        |                                                      |
| Queue                                        | 0 – 10          | pg-boss: $0; Upstash fixed plan from $10 [Confirmed] |
| Observability                                | 26 – 100        | Sentry Team ≈ $26 [Reported]                         |
| Transactional email                          | 0 – 20          |                                                      |
| KMS / secrets                                | 1 – 5           | [Assumption]                                         |
| Base object storage, CDN                     | 5 – 20          |                                                      |
| **Total fixed**                              | **≈ 142 – 655** |                                                      |

Fixed share per workspace: **$1.4–6.6 at 100 workspaces**, **$0.3–1.3 at 500**.

### 2.3 Unit economics

| Metric                                                       | Starter                  | Growth       | Heavy         |
| ------------------------------------------------------------ | ------------------------ | ------------ | ------------- |
| Cost per published content item (text + images)              | $0.21 – 0.33             | $0.23 – 0.40 | $0.24 – 0.40  |
| Marginal cost of publishing the same item to another network | ≈ $0.002 (utility calls) | same         | same          |
| Cost per generative 8 s clip delivered (expected)            | $0.60 (DRAFT)            | $0.60 – 1.44 | $0.60 – 4.80  |
| Variable cost per workspace (expected video)                 | $7.8 – 10.2              | $24.9 – 34.6 | $96.7 – 129.3 |

## 3. Subscription implications ([Decision] D14 — illustrative prices)

Assumptions:

- Card processing ≈ 3% + $0.30 [Assumption].
- Fixed share at 100 workspaces.
- Prices are illustrative placeholders, to be validated with pilot customers (USD; a SAR
  equivalent is [Decision] D11).

The cost range assumes the **whole included video allowance is used** (worst case for
included usage), plus non-video variable cost, the fixed share and card fees.

| Plan (illustrative) | Price | Included allowance (proposal)                                                 | Monthly video hard cap (included) | Cost range     | Gross margin range |
| ------------------- | ----- | ----------------------------------------------------------------------------- | --------------------------------- | -------------- | ------------------ |
| Starter             | $29   | 20 items, 60 images, **100 video credits** (≈ 8 DRAFT clips at 1.5 attempts)  | $5                                | $11.7 – 19.3   | **33% – 60%**      |
| Growth              | $79   | 60 items, 240 images, **400 video credits** (≈ 13 STANDARD or 33 DRAFT clips) | $20                               | $38.4 – 53.4   | **32% – 51%**      |
| Pro (heavy)         | $249  | 200 items, 800 images, **1,600 video credits** (≈ 55 STANDARD or 16 PREMIUM)  | $80                               | $137.9 – 175.7 | **29% – 45%**      |

Example (Growth, high end): non-video $24.08 + fixed $6.60 + card $2.67 + video $20 =
$53.35 → margin 32%.

**Video makes these margins thinner than the earlier image-only model.** If the
verified prices (V1) are higher, or pilots show more than 1.5 attempts per accepted
clip, either the included credits shrink or the prices rise ([Decision] D14/D17).

### 3.1 Sensitivity to generative video

| Delivered 8 s clips / month | DRAFT expected ($0.60) | STANDARD expected ($1.44) | STANDARD worst ($2.88) | PREMIUM worst ($9.60) |
| --------------------------- | ---------------------- | ------------------------- | ---------------------- | --------------------- |
| 5                           | $3                     | $7                        | $14                    | $48                   |
| 15                          | $9                     | $22                       | $43                    | $144                  |
| 40                          | $24                    | $58                       | $115                   | $384                  |

If the conflicting PREMIUM price ($0.75/s) is current, the PREMIUM column almost
doubles. Therefore:

- **generative video is never unlimited**;
- it is sold as **credits** with hard monthly caps;
- overage is opt-in only, priced at ≥ 1.5× the worst-case unit cost [Assumption], and
  capped by an owner-set overage ceiling (default $0).

### 3.1.1 Worst-case cost exposure

| Scope                     | Bound                                                                                                                 | Mechanism                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| One request               | ≤ DRAFT $3.20 / STANDARD $7.68 / PREMIUM $25.60. PREMIUM and anything above $5 needs approval                         | Worst-case reservation before submission                 |
| One workspace per day     | Daily video cap; default 25% of the monthly cap [Assumption]                                                          | Ledger reservation under the workspace lock              |
| One workspace per month   | Included cap ($5 / $20 / $80) + owner-set overage ceiling (default $0)                                                | Hard stop at 100%                                        |
| Unknown outcomes          | At most the reserved amount per OUTCOME_UNKNOWN attempt; held, never released blindly                                 | Reconciliation                                           |
| Platform per provider     | Operator daily ceiling (e.g. $200/day at launch [Assumption]) ⇒ ≤ ≈ $6,000/month even if every cap logic failed       | Platform guard pauses the route; provider quotas lowered |
| Platform at 100 Growth WS | ≤ $2,000/month video spend with default overage $0                                                                    | Sum of hard caps                                         |
| Provider side             | Runway: prepaid credits = hard cap. Vertex AI: budgets alert only; quota limits as a coarse cap [Reported/Assumption] | Provider console configuration (operator runbook)        |

Images are the second-largest driver. At $0.07 per image, 800 images = $56. The
allowance should count candidates, not just accepted images.

### 3.2 Fixed vs variable

- **Variable:** text tokens, images, generative video (incl. failed attempts),
  storage growth, X API (if enabled), card fees.
- **Semi-variable:** video poll/post-processing workers, database size, observability
  volume.
- **Fixed:** base hosting, managed DB minimum, monitoring plan, KMS, domains, support
  tooling.

### 3.3 Covering costs while keeping margins

- Allowances sized to the scenarios, metered at reservation time.
- Overage only with owner opt-in, priced above the high-end unit cost.
- Cheaper routes for utility tasks; prompt caching for repeated brand context (cache
  reads at 0.05–0.1× input price [Confirmed for Anthropic]).
- Batch API for non-urgent work such as monthly reports (−50% [Confirmed for
  Anthropic]).
- DRAFT tier as the default for exploration, with STANDARD/PREMIUM for final clips;
  silent output plus our own captions where speech is not needed (cheaper).
- Candidate and attempt caps per request.
- Annual plans to smooth fixed costs.

## 4. Enforceable cost controls

| Control                                               | Mechanism                                                                                                                                  | Phase              |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| Per-generation caps                                   | `maxOutputTokens`, N candidates, max clips × seconds × attempts per video request; refused above the policy maximum                        | 4                  |
| Daily and monthly workspace budgets                   | BudgetPolicy + UsageLedger reservation under a workspace lock (concurrency-safe, like the implemented daily cap)                           | 4                  |
| Category sublimits (image, generative video per tier) | Separate ledger categories                                                                                                                 | 4                  |
| Preflight cost estimates                              | Shown before running image/video work; required confirmation above a threshold                                                             | 4                  |
| Provider spend alerts                                 | Operator-level daily ceilings per provider, plus provider-console limits/alerts where offered [verify per provider]                        | 4                  |
| Hard-stop thresholds                                  | Refuse new paid work at 100% (workspace) and at the operator ceiling (platform)                                                            | 4                  |
| User-facing usage visibility                          | Usage page: reserved / spent / remaining per category, per day and month; per-run cost in run history                                      | 4 (exists in part) |
| Abuse detection                                       | Bursts, rejection ratios, repeated denials, cost anomalies → throttle / pause / review                                                     | 6                  |
| Safe fallback                                         | Cheaper text route → library images → lower video tier (owner opt-in) → stop with a clear message. Never a non-generative video substitute | 4                  |
| No paid action beyond approved budget                 | Reservation is mandatory for every paid tool; there is no code path without it (test)                                                      | 4                  |

## 5. What this model does not yet know

- Real token counts for Arabic in the chosen model's tokenizer. Newer Claude models
  produce about 30% more tokens for the same text [Confirmed note on the pricing page].
- Chosen providers' actual prices, discounts and taxes.
- Real usage distributions (pilot data).
- Hosting provider/region (data residency).
- Currency, tax/VAT treatment and payment processor fees in KSA.

- Verified generative-video prices (V1/V2), whether failed generations are billed
  (V7), and real attempts per accepted clip (pilot data).

These are [Decision] items D2, D3, D9, D11, D13, D14, D16, D17 and D18. They must be resolved
before prices are published.

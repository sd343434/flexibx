# Flexibx — Generative Video: No-Spend Validation Report

**Status: evidence report. Phase 4 stays IN PROGRESS.** Run 2026-10-09 on branch
`claude/amazing-sagan-pvouqy`.

- No paid request, purchase, provider account or billing change was made.
- Paid video tests remain **disabled** and need separate, explicit approval.
- **Nothing in this report proves that real generative video works.** P4-AC7 (a real
  provider produces a video) is still open.

## 1. Baseline (recorded before any work)

| Item                 | Value                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Local HEAD           | `7fb2d49` (dashboard redesign, local, not pushed)                                                                         |
| Origin branch        | `117e266`                                                                                                                 |
| Staged files         | 0                                                                                                                         |
| Working tree         | 32 entries (19 modified tracked files = partial Phase 4 + `.phase-status.json`; 13 untracked = Phase 4 code, tests, docs) |
| `.phase-status.json` | SHA-256 `e2710c70…253744` — unchanged after the run                                                                       |
| PostgreSQL / FFmpeg  | PostgreSQL 16.15 (started locally); FFmpeg/ffprobe 6.1.1                                                                  |

## 2. What exists and what does not

The partial Phase 4 implementation contains the **text** AI engine only:

- the provider boundary;
- `disabled` and `fake` providers;
- the daily-cap lock pattern;
- the `generated-videos` storage category.

**No generative-video code exists:**

- no video gateway, Veo adapter or fake video provider;
- no VideoGenerationJob/Attempt tables;
- no queue or worker;
- no smoke-budget ledger;
- no ffprobe validation;
- no post-processing.

Building them is application work that needs your authorization. So this run uses:

1. the existing app test suites (unchanged);
2. **throwaway prototypes** kept outside the repository, in the session scratchpad
   (`novalidation/ledger.test.mjs`, `media.test.ts`, `dryrun.test.mjs`). They
   validate the _design_, not the product, and are not committed.

## 3. Results

### A. Fake-provider end-to-end tests of the video pipeline — **NOT EXECUTABLE**

There is no video pipeline to exercise. The closest existing evidence is the
**text** engine's fake-provider suites, run unchanged:

| Suite                                             | Result           | Covers (text only)                                                                                                    |
| ------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------- |
| `tests/unit/ai-engine.test.ts`                    | **35/35 passed** | output schemas, timeout race, one retry, failure normalization, refusal/invalid output                                |
| `tests/integration/ai-engine.test.ts` + `ai-flow` | **36/36 passed** | tenant isolation, provider failures, audit events, use-once apply, **daily cap under concurrent requests (row lock)** |

None of the video-specific items has been executed:

- job creation, submission, polling, completion and cancellation;
- worker crash recovery;
- unknown outcomes;
- download-only retries;
- invalid output;
- video approvals;
- video kill switch;
- video audit events.

To execute them, these components must be implemented (authorization needed):

1. video gateway interface + fake video provider with scripted scenarios
   (architecture §4.2.1);
2. VideoGenerationJob/Attempt schema + migration + tenant-guard registration, with
   state CHECKs (§4.2.2);
3. pg-boss queues `video.submit` / `video.poll` / `video.postprocess` and a worker
   entrypoint (§4.2.3, D4);
4. the failure handling of §4.2.4 and the smoke-budget ledger (§3 C below);
5. ffprobe validation and post-processing service (§3 D below);
6. policy, approval, kill-switch and audit hooks for `video.generate`;
7. the review-gallery UI.

### B. Real-provider request dry run — prototype only; no adapter in the app

Facts about the **application** (verified by reading the code):

- `AI_PROVIDER` accepts only `disabled` | `fake`, and the default is `disabled`
  (`src/server/env-schema.ts:123`).
- No HTTP client, Google or Runway SDK, or provider URL exists in `src/server/ai/`.
  No such dependency is in `package.json`.

So the app has **no code path that can send a paid video request**.

The prototype (`dryrun.test.mjs`) **passed 4/4**. The representative request it built
was:

```json
{
  "url": "https://us-central1-aiplatform.googleapis.com/v1/projects/example-project/locations/us-central1/publishers/google/models/veo-3.1-lite-generate-preview:predictLongRunning",
  "body": {
    "instances": [
      { "prompt": "A slow aerial shot over desert dunes at sunrise, no people, no text, no logos" }
    ],
    "parameters": {
      "sampleCount": 1,
      "durationSeconds": 4,
      "resolution": "720p",
      "aspectRatio": "16:9",
      "generateAudio": false,
      "personGeneration": "dont_allow"
    }
  },
  "worstCaseUSD": 0.23
}
```

The four tests checked that:

- the single output, 4 s, 720p, audio off and the $0.23 worst case are pinned;
- unsupported durations and resolutions, and models without a rate, are refused
  before sending;
- `send()` refuses by default and when any gate is missing (approval, verified
  pricing, reservation, credential), with **0 network calls** (`fetch` stubbed to fail
  and count);
- a planted fake credential never appears in the request or output.

**Parameter and model validation against documentation: not achieved.** The
official reference (`docs.cloud.google.com`) is blocked by the network proxy. What
search results show of the official pages:

- `publishers/google/models/MODEL_ID:predictLongRunning` with `instances` +
  `parameters`, returning a long-running operation;
- `sampleCount` range 1–4;
- `resolution` 720p/1080p (4k for 3.1 preview), default 720p.

The rest is unconfirmed:

- the model id `veo-3.1-lite-generate-preview` (seen only in a forum post);
- the allowed `durationSeconds` values for Lite;
- whether Lite supports `generateAudio: false`;
- `personGeneration` values for KSA requests;
- forum reports of 404 / allow-list access to Veo 3.1 models.

### C. Budget-ledger concurrency — prototype on a disposable PostgreSQL database: **11/11 passed**

The prototype uses a single budget row locked with `SELECT … FOR UPDATE` (the same
pattern as the app's daily cap) and an append-only RESERVE/RELEASE ledger in integer
micro-dollars. Each test database was created and dropped (0 left behind).

| Test                                                                                  | Actual result                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Worst case incl. 15% tax, fees, minimum charge, `sampleCount`, rounded up to the cent | $0.23 / $0.25 / $0.58 / $0.92 as expected; 8 attempts fit in $2.00                          |
| **8 concurrent reservations** at $0.23                                                | 8 accepted, 0 rejected, **$1.84 committed** ≤ $2.00                                         |
| **20 concurrent reservations** at $0.23                                               | 8 accepted, 12 rejected, **$1.84 committed** ≤ $2.00                                        |
| 20 rounds × 20 concurrent mixed-size reservations ($0.23/$0.46/$0.56)                 | never above $2.00                                                                           |
| **Negative control**: same 20 requests without the row lock                           | **$4.60 committed** — overspends, proving the test detects the bug                          |
| Request that cannot reserve its worst case                                            | rejected; fake provider received 0 extra submissions                                        |
| OUTCOME_UNKNOWN and still-polling attempts                                            | the sweeper releases only never-submitted reservations; unknown stays held until reconciled |
| Failed / refused / invalid / timed-out attempts                                       | charged in full (flagged ESTIMATED); released only on confirmed no charge                   |
| Provider bills above the reservation                                                  | overrun recorded; all further paid reservations refused                                     |
| No fallback                                                                           | after 3 failures or 1 refusal the runner stops; the second provider received **0** calls    |
| Planned run (≤ 3 attempts × $0.23)                                                    | ≤ $0.69; further attempts stop at 8 total ($1.84)                                           |

**What this proves:** the reservation-under-row-lock design keeps concurrent
reservations within US$2.00 in PostgreSQL 16. Taxes, fees, minimum charges and
multiple outputs are included in the worst case. Unknown and failed outcomes cannot
silently free budget, and the runner cannot switch providers.

**What it does not prove:**

- that the application implements this — the app has no smoke ledger yet;
- that the rates are right — they are unverified;
- that a provider cannot bill more than duration × rate × outputs;
- that the bill matches the ledger;
- that the cap holds across separate databases or environments. The cap is only as
  global as the single budget row, so production must use one row for all
  environments that hold provider credentials.

### D. Local media processing — prototype using a locally generated test pattern: **6/6 passed**

The test MP4 is FFmpeg's built-in `testsrc2` pattern (4 s, 1280×720, 24 fps, H.264,
silent), so there are no licensing questions. **It is not generative-model output.**

| Test                                   | Actual result                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Valid clip validation + SHA-256        | passed: `{"dur":4,"width":1280,"height":720,"codec":"h264","audio":false}`; checksum stable                                                                                                |
| Duration / resolution / audio presence | 8 s expected → `duration`; 1080p expected → `resolution`; audio expected on silent and vice versa → `audio_presence`                                                                       |
| Malformed / unsupported                | text file renamed `.mp4` → rejected; empty file → `size`; truncated MP4 → `decode_error` (full decode pass); VP9 WebM → rejected; MPEG-4 Part 2 → `codec`; over size cap → `size`          |
| Post-processing                        | 9:16 (720×1280) and 1:1 (720×720) crops and the 2-clip concatenation (8 s) re-validate; poster frame produced                                                                              |
| Storage round trip                     | the app's `MemoryStorageService` + `buildWorkspaceKey(…, "generated-videos", "video/mp4")`: checksum equal after read; invalid workspace id and traversal key rejected; delete → not found |
| Temporary files                        | temp directories removed (0 left behind)                                                                                                                                                   |

Not covered:

- the S3/MinIO adapter;
- loudness normalization (the test clip has no audio);
- Arabic caption overlay (libass/HarfBuzz shaping);
- provider download (temporary URLs, allow-listed hosts).

## 4. Provider verification checklist

Labels:

- **[Official]** = read on the provider's own site;
- **[Official-snippet]** = the provider's page as quoted by a search engine;
- **[Third-party]**;
- **[Assumption]**;
- **[Open]** = no answer.

In this environment the proxy blocked `docs.cloud.google.com`, `ai.google.dev`,
`docs.dev.runwayml.com`, `lumalabs.ai` and `aws.amazon.com`. **Nothing below is
[Official].**

| #   | Question                                                       | Google Veo 3.1 Lite (Vertex AI) — candidate                                                                                             | Runway API                                                    | How to close (no spend)                                                          |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | Price for the exact model/config (4 s, 720p, silent, 1 output) | $0.05/s **[Third-party]**; model id **[Third-party]** (forum)                                                                           | gen4_turbo $0.05/s (image→video) **[Official-snippet]**       | A person reads the Vertex AI pricing page; store the URL + date in the rate card |
| 2   | Billing of failed, refused, timed-out and incomplete jobs      | **[Open]**; one user report of charges without output **[Third-party]**                                                                 | **[Open]**                                                    | Docs, then a written billing-support answer                                      |
| 3   | Maximum charge per request (multiple outputs, minimums)        | `sampleCount` 1–4 **[Official-snippet]**; multiplies cost **[Assumption]**; minimum charge **[Open]**                                   | Minimum credit purchase US$10 **[Third-party]** → exceeds cap | Pricing page + API reference                                                     |
| 4   | Commercial-use rights, content restrictions                    | No ownership claimed, Prohibited Use Policy applies **[Third-party, secondhand]**; SynthID on output **[Third-party/Google blog]**      | **[Open]**                                                    | Legal review of the service terms                                                |
| 5   | API availability and regional restrictions for deployment      | MENA `personGeneration` = `allow_adult` only **[Third-party, forum]**; allow-list/404 reports **[Third-party]**; region list **[Open]** | **[Open]**                                                    | Model/region docs; a zero-cost model-list call (needs approval)                  |
| 6   | Rate limits, quotas, account requirements                      | GCP project + billing account required **[Assumption]**; quotas **[Open]**                                                              | Tiered concurrency **[Third-party]**                          | Quotas page in the console                                                       |
| 7   | Can provider-side spend limits block charges, or only alert?   | Cloud Billing budgets **alert only** **[Third-party/Assumption]**; quota caps as a coarse limit **[Assumption]**                        | Prepaid credits block **[Third-party]**, but $10 minimum      | Billing docs                                                                     |
| 8   | Can our ledger enforce US$2.00 reliably?                       | **Design: yes** (§3 C, prototype). **In practice: not yet** — depends on #1–#3 and on the app implementing the ledger                   | Excluded under the cap (#3)                                   | Close #1–#3; implement + test the ledger in the app                              |

## 5. Blockers before any real generation test

1. **Pricing not verified** (#1). No official rate for the exact configuration.
2. **Billing of failed/refused/timed-out jobs unknown** (#2). This is covered by
   assuming full charge, but it must be confirmed.
3. **Maximum charge per request unconfirmed** (#3): minimum charges, and whether one
   call can bill more than duration × rate × `sampleCount`.
4. **Model id, parameters and access for Veo 3.1 Lite unconfirmed** (§3 B), with
   reports of allow-list/404 errors.
5. **Terms and regional limits not reviewed** (#4, #5).
6. **No application implementation** of the video gateway, adapter, smoke ledger,
   validation or reconciliation (§3 A). Only prototypes exist.
7. **Provider-side caps alert only on Vertex** (#7), so the US$2.00 cap rests entirely
   on our ledger, which does not exist in the app yet.
8. **No owner approval** of D9 (provider), D16 (paid test plan) or an account holder.

**Recommendation: keep paid tests blocked.** The US$2.00 cap is enforceable **by
design** (the prototype evidence above) but **not demonstrably today**. Next steps:

- close #1–#5 from official pages or written support answers;
- with your authorization, implement components 1–6 of §3 A and the smoke ledger in
  the app, and re-run these checks as real app tests;
- only then request separate approval for the single US$0.23 Lite test.

## 6. Phase 4 gate

- `.phase-status.json` is unchanged, and Phase 4 stays IN_PROGRESS.
- P4-AC7 (real provider produces a video) is **not satisfied** and cannot be satisfied
  by the fake-provider tests, dry runs or local MP4 processing above.
- No acceptance criterion was changed.

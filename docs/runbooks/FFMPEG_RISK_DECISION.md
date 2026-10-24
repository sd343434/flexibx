# FFmpeg in the worker image — evidence and decision (Pass 40, 2026-10-24)

**Status: PARTLY MITIGATED — D implemented and tested locally (Pass 42, § 7); the CVEs
themselves remain open and A still needs an owner decision.** Nothing here is applied; no paid service was
used. Mitigations reduce exposure; they do not remove a single CVE.

## 1. What is installed (verified)

| Fact                                                                                                                                           | Evidence                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| FFmpeg `7:6.1.1-3ubuntu5`, Ubuntu noble/universe                                                                                               | Worker image `3d19ed3`; `apt-cache madison` in `ubuntu:24.04@sha256:68ee2200…` on 2026-10-24                                |
| No newer version in `noble-updates` or `noble-security`                                                                                        | Same check: the package lists of both pockets do not contain `libavcodec60`                                                 |
| Ubuntu Pro (ESM Apps) publishes `7:6.1.1-3ubuntu5+esm15`                                                                                       | `esm.ubuntu.com/apps/ubuntu/dists/noble-apps-security` index, dated 2026-10-12 (public index; packages need a subscription) |
| Trivy 0.76.0 (DB 2026-10-23): 665 OS findings in the worker, 0 fixable, **585 in the FFmpeg libraries = 65 CVEs × 9 packages**, all MEDIUM/LOW | `build-and-verify.sh` on `3d19ed3`; JSON scan                                                                               |

## 2. The 65 CVEs, by Ubuntu's own status for noble

Source: `https://ubuntu.com/security/cves/<id>.json`, queried 2026-10-24. Full table:
[`evidence/ffmpeg-cves-2026-10-24.tsv`](evidence/ffmpeg-cves-2026-10-24.tsv).

| Ubuntu status for noble                     | CVEs | Meaning                                                     |
| ------------------------------------------- | ---- | ----------------------------------------------------------- |
| Released in **esm-apps** (`+esm1`…`+esm15`) | 61   | Fixed — but only for machines attached to Ubuntu Pro        |
| **Deferred** (no fix anywhere)              | 4    | CVE-2023-6601, CVE-2023-6602, CVE-2023-6604, CVE-2025-25467 |

Ubuntu priority: 64 medium, 1 negligible. None is HIGH/CRITICAL in Trivy.

The four without a fix:

| CVE            | Component (Ubuntu's description)                         | Our exposure                                                                                   |
| -------------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| CVE-2023-6601  | HLS demuxer: bypass of extension checks via `data:` URIs | HLS is never selected: the demuxer is pinned (mov/matroska/mp3/wav) and only `file` is allowed |
| CVE-2023-6602  | TTY demuxer reached through HLS playlists                | Same: needs the HLS demuxer                                                                    |
| CVE-2023-6604  | XBIN demuxer chosen by auto-detection (CPU/storage)      | Auto-detection is off for every accepted upload                                                |
| CVE-2025-25467 | Crafted AAC file, memory handling                        | **Reachable**: AAC is a normal audio codec in MP4/M4A. Contained only by the worker caps below |

Tests: `tests/integration/media-hardening.test.ts` (Pass 39–40) proves the demuxer
selection (a playlist is followed unpinned and refused pinned, under every accepted
container). The CVEs themselves were **not reproduced**.

## 3. Controls in place (tested locally)

`-protocol_whitelist file`, demuxer pinned to the sniffed container, content sniffing and
size limits, hard timeouts with SIGKILL, worker container without capabilities,
`no-new-privileges`, default seccomp/AppArmor (asserted by
`check-compose-credentials.sh`), PID cap 256, 2 GB memory without swap, 2 CPUs, non-root.
The worker still holds database and S3 credentials: code execution in FFmpeg would reach
them. That is the residual risk.

## 4. Options

| Option                                                                                                               | Removes CVEs?                                            | Cost / effort                                                                                                     | Risk                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| **A. Ubuntu Pro in the worker build** (attach during build via a BuildKit secret, install, detach in the same layer) | **61 of 65**, as Canonical ships them                    | Subscription (price to be quoted by Canonical for the owner's use; not checked here); ~1 day build change + tests | Token handling in CI and release builds; Trivy must be re-run to confirm it reads the `+esm` versions as fixed |
| B. A maintained FFmpeg build from another source (pinned, checksummed)                                               | Depends on its release cadence                           | 2–5 days; we own updates                                                                                          | Supply-chain trust in the builder; license review (GPL/nonfree flags)                                          |
| C. Build FFmpeg ourselves with only the needed demuxers/decoders                                                     | Shrinks reachable code; CVEs stay "present" for scanners | 1–2 weeks plus maintenance                                                                                        | We own every future security fix                                                                               |
| D. Move FFmpeg into a separate container with no credentials and no network                                          | None (limits the impact)                                 | 3–7 days (job hand-off through the work volume)                                                                   | More moving parts; complements A–C                                                                             |
| E. Documented acceptance                                                                                             | None                                                     | Owner signature                                                                                                   | The 61 fixable CVEs stay open                                                                                  |

## 5. Recommendation

**A, then D.** A closes 61 of the 65 with fixes Canonical already published, with the
least engineering; D contains the remaining four (in particular CVE-2025-25467) by taking
credentials away from the process that parses customer files. Both need the owner's
approval (A is a paid subscription; D is an architecture change).

Acceptance for closing this risk: the worker image built with A shows the `+esm`
versions; a Trivy scan of that image (no exception) lists only the deferred CVEs for
FFmpeg; the media tests and the container cycle pass; the 4 deferred CVEs are either
contained by D or covered by a signed acceptance (E).

## 6. Pass 41 update (2026-10-24, later the same day)

**Re-checked:** the 65 CVEs against Canonical's API again — no status changed (61 released
in esm-apps, 4 deferred; [`evidence/ffmpeg-cves-2026-10-24-recheck.tsv`](evidence/ffmpeg-cves-2026-10-24-recheck.tsv));
the ESM Apps index is still dated 2026-10-12 (`+esm15`); the worker built in Pass 41 has the
same 65 CVEs.

**CVE-2025-25467 is in libx264, not in a demuxer.** Canonical lists it against `x264`
(and `ffmpeg`, which links it) as _deferred_ for noble; their note says the upstream fix was
proposed and closed without being merged. We use libx264 to render clips. Ubuntu Pro does
**not** fix it, demuxer pinning does **not** touch it, and nothing here reproduces it. Only
isolation limits what it can reach.

**Measured: what code running inside FFmpeg could reach.** In the worker image, under the
same caps as Compose (no capabilities, no-new-privileges, seccomp filter on, uid 1000):

| Check                                                                  | Result                                                         |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| FFmpeg's own environment (`runMediaTool` passes `PATH` only)           | No secret (0)                                                  |
| The worker's environment, read by FFmpeg from `/proc/<parent>/environ` | **Readable** (same uid) — database and S3 credentials included |
| Seccomp / no-new-privileges / capabilities in the child                | Filter on (Seccomp 2), NoNewPrivs 1, CapEff 0                  |

So an FFmpeg exploit is a credential exposure, whatever is patched — the caps cannot stop a
process from reading its own user's parent. The local cycle lists the variable **names**
readable this way (values never printed).

**Also done in Pass 41:** the job steps now refuse to run FFmpeg when the stored container has
no pinned demuxer (it used to fall back to auto-detection), with a job-level test.

### Recommendation (one, preferred): D — FFmpeg in its own container without credentials

Run every FFmpeg/ffprobe call in a separate, short-lived container (or a long-lived sidecar)
that receives only the input file and a scratch directory: no database or S3 credentials,
no network (`network_mode: none`), read-only root, the same caps and seccomp. The worker
keeps its credentials and moves files in and out of a shared work volume.

| Why D first                                                                          | Cost / risk                                                                                                    |
| ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| Contains **all 65** CVEs, including the 4 nobody fixes and the reachable libx264 one | 3–7 engineering days: a small media runner, a job hand-off through the work volume, tests, the container cycle |
| No subscription, no new supplier                                                     | One more moving part on the host; a little latency per call                                                    |
| Turns "code execution in FFmpeg" from a credential leak into a contained crash       | Must be re-validated on staging (A5)                                                                           |

**Alternatives:** A (Ubuntu Pro in the build) removes 61 of 65 but leaves the credentials
reachable by the 4 others — recommended **in addition** to D once its price is known; B (a
maintained third-party FFmpeg) changes the supplier, not the exposure; C (own minimal build)
costs the most to maintain; E (signed acceptance) leaves everything open.

Nothing here was bought or built: D is an architecture change and A is a paid service, so
both need the owner's approval.

## 7. Pass 42 update (2026-10-24, evening): D implemented, CVEs unchanged

**D is implemented** — `MEDIA_ISOLATION.md`: FFmpeg and ffprobe run only in the `media`
service (the worker image, another command) with no env file, no network, a read-only root,
its own PID namespace and only the work volume; the worker reaches it through a 0600 Unix
socket; the runner re-validates every argument; no fallback anywhere (local path refuses,
production worker refuses to start without it, no job is claimed while it is down).
Proven locally on the release images `729d8f6` (container cycle, `LAUNCH_HARDENING_PASS_42.md`
§ 4): no credential name in any environment visible inside `media`, the synthetic secret
values found nowhere it can read (control: found in the worker), only `lo`, no Docker
socket, no secret file, CapEff 0, NoNewPrivs 1, Seccomp 2. **Not yet validated on hosted
staging** (A5 + the new A14 in `LAUNCH_CLOSURE_MATRIX.md`).

**CVE status re-checked** (Canonical API, 2026-10-24 evening;
[`evidence/ffmpeg-cves-2026-10-24-pass42.tsv`](evidence/ffmpeg-cves-2026-10-24-pass42.tsv),
identical to the Pass 41 recheck): **61 released only in esm-apps** (`+esm1`…`+esm15`),
**4 deferred** with no fix anywhere (CVE-2023-6601, CVE-2023-6602, CVE-2023-6604,
CVE-2025-25467). ESM Apps index still dated 2026-10-12. The public archive (noble,
noble-updates, noble-security; indices of 2026-10-24) still has only `7:6.1.1-3ubuntu5`.
Trivy 0.76.0 on the final worker image: 665 OS findings (637 MEDIUM, 28 LOW), 585 in the
FFmpeg libraries (65 CVEs), **0 fixable**; app and ops images: 25 and 27, 0 fixable.

| Group                              | CVEs | Fixable by us now?                                    | What contains it after Pass 42                                                |
| ---------------------------------- | ---- | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| Released in esm-apps               | 61   | Only with Ubuntu Pro (A) — owner decision, not bought | Runner isolation (no credential, no network); demuxer pinning; caps; timeouts |
| Deferred, demuxer-related (3)      | 3    | No fix exists                                         | Demuxer pinned (HLS/TTY/XBIN never selected — tested); isolation              |
| Deferred, CVE-2025-25467 (libx264) | 1    | No fix exists (upstream fix not merged)               | Isolation only — reachable on every render                                    |

**Not claimed:** no CVE is "handled". None was reproduced; isolation limits the impact of
an exploit to the runner (a crash, CPU/memory up to its caps, and read/write access to
other jobs' scratch files on `/work`) — it does not prevent the exploit.

**A (Ubuntu Pro) evaluated alongside, not instead:** still the only way to install the 61
published fixes from the same supplier. It needs a subscription (price to be quoted by
Canonical for this use — not checked, nothing bought), a build change (attach with a
BuildKit secret, install `+esm`, detach in the same layer; ≈1 day), and a Trivy run to
confirm the scanner reads `+esm` versions as fixed. Recommended **in addition** to D;
the decision stays with the owner (`OWNER_DECISIONS.md`).

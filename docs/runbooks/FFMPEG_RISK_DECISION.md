# FFmpeg in the worker image — evidence and decision (Pass 40, 2026-10-24)

**Status: OPEN — needs an owner decision.** Nothing here is applied; no paid service was
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

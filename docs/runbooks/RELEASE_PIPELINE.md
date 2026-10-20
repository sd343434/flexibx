# Release pipeline: build, verify, publish one release (Passes 18–19)

How a Flexibx release becomes three images, what proves they are fit to deploy, and how
they reach the registry. The deployment itself is STAGING_CREATOR_STUDIO.md § 3 (and
`deploy/staging/aws/README.md` for AWS); restoring after an incident is SERVICE_RESTORE.md.

**Status (2026-10-20, Pass 19):** the pipeline and every check below run locally and are
wired into CI, but CI has never run them (GitHub Actions gets no runner: CI_STATUS.md, decision
R-1) and nothing has been pushed to a registry (no AWS account yet: R-2/R-3).

## 1. Inputs are pinned

| Input                      | Pinned by                                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Source                     | one commit; the build context is `git archive <commit>` (committed files only)                               |
| Node runtime               | `NODE_IMAGE` digest in the Dockerfile (`node:22.22.3-bookworm-slim@sha256:e21fc383…`)                        |
| OS base (all three images) | `JOBS_IMAGE` digest (`ubuntu:24.04@sha256:68ee2200…`)                                                        |
| Node packages              | `pnpm-lock.yaml`, installed with `--frozen-lockfile`                                                         |
| Package manager            | `packageManager: pnpm@10.34.7` (corepack fetches exactly that version)                                       |
| Terraform provider         | `deploy/staging/aws/.terraform.lock.hcl` (signature-verified checksums, § 6)                                 |
| Scanner                    | Trivy 0.76.0 by digest (`scripts/docker/scan-images.sh`)                                                     |
| **Not pinned**             | Ubuntu's security updates (`apt-get upgrade` at build) and the vulnerability database (refreshed every scan) |

Pinned inputs are **not** byte-identical outputs: two builds of one commit differ at least
in file timestamps and in any Ubuntu security update published between them. § 4 shows
what was compared.

## 2. Build and verify

```bash
# From a checkout of the release commit (uncommitted edits never reach the images):
scripts/release/build-and-verify.sh <tag>          # tag = the full commit SHA is recommended
```

It builds `flexibx/{app,worker,ops}:<tag>` from `git archive HEAD`, labels each with the
commit (`org.opencontainers.image.revision`), and runs `scripts/release/verify-images.sh`
— the same script CI's Docker job runs:

1. every image carries the expected commit label;
2. contents: non-root user; no `.env`, key, credential, Terraform state or variables, no
   `.git`, `deploy/`, `docs/`, tests or agent state; no package manager in the app image;
   `/work` (worker) and `/backups` (ops) writable by the image's user;
3. size budgets: app 500 MB, worker 1400 MB, ops 1250 MB;
4. the ops self-check (PostgreSQL 16 client, Prisma CLI offline) and the worker's media
   tools and PostgreSQL client;
5. the vulnerability scan: fails on any HIGH/CRITICAL finding with a fix available, on a
   malformed or too-long exception (`.trivyignore.yaml`, ≤ 30 days), on a stale image
   (commit label), when the database cannot be downloaded, and when the OS is not
   detected.

`migrate` is the ops image with `prisma migrate deploy` (Compose service `migrate`).

## 3. Publish

```bash
FLEXIBX_REGISTRY=<account>.dkr.ecr.<region>.amazonaws.com/flexibx-staging \
  scripts/release/build-and-verify.sh <commit-sha> --push
```

Pushes only after every check passed, refuses `latest`, a tag that is a commit SHA other
than HEAD, a dirty working tree (uncommitted or untracked files: a release is published
from a clean checkout of its commit) and a tag that already exists in the registry (ECR's
repositories are immutable too), and prints the pushed digests.

`scripts/release/test-release-guards.sh` (CI quality job, no Docker needed) proves these
guards with a stub `docker` in a throwaway repository: refused tags and options build
nothing; every image gets `GIT_SHA` = HEAD and is built from an archive of the commit; a
failing check — a stub verifier, or the real `verify-images.sh` on a wrong commit label —
and an existing tag push nothing; pushes come only after verification. Eight mutants of
`build-and-verify.sh` (each guard removed, verification made non-fatal, push moved before
verification, wrong `GIT_SHA`, build from the checkout) are all caught (Pass 19).
Deploy by that tag (`FLEXIBX_TAG=<commit-sha>`); Compose refuses to run without one.
ECR scans again on push (`scan_on_push`).

## 4. Measured (2026-10-20, local)

The Pass 18 commit `9333ffa` was built twice with `build-and-verify.sh` (the second time
after clearing the build cache), with this environment's local options (proxy CA, base
images through mirror.gcr.io at the same digests). Both runs passed every check.

| Image  | Image ID | Files compared (`/app`, `node`) | Differing files                                                             | OS packages (name + version) |
| ------ | -------- | ------------------------------- | --------------------------------------------------------------------------- | ---------------------------- |
| app    | differs  | 2 602                           | 212, all Next.js build output (`.next/`)                                    | 92, identical                |
| worker | differs  | 5 685                           | 2: pnpm's `.modules.yaml` (install timestamp) and one generated `.bin` shim | 306, identical               |
| ops    | differs  | 18 287                          | 4: `.modules.yaml` and three generated `.bin` shims                         | 113, identical               |

So the builds are **not byte-reproducible**, and the image IDs differ. Every source file,
dependency, the Node binary and every OS package were identical. The app's differences
come from Next.js: a random `BUILD_ID` per build (which every chunk manifest references),
per-build preview-mode keys (secrets, rightly different), and file lists in traced
dependency manifests written in a different order (same 445 files in the sample checked).
Identical OS packages here only mean no Ubuntu update landed between the two builds; a
later rebuild may differ by design (security updates at build).

### Pass 19: the commit as the build ID

`next.config.ts` sets `generateBuildId` from `GIT_SHA` (passed to the Dockerfile's build
stage; `src/server/build-id.ts`, unit-tested). The SHA's letters a–f are written g–l, so
the ID never contains "ad" (Next.js avoids such IDs because ad blockers block their
asset URLs); anything but a full SHA keeps Next.js's random ID. The release image of
`3e41054` has `BUILD_ID` `3k41054037371kj0l80g921lk21ii6477kk48i1k`.

Measured again on `3e41054` (second build with `--no-cache`, same local options):

| Image  | Image ID | Files compared | Differing files                                                               | OS packages    |
| ------ | -------- | -------------- | ----------------------------------------------------------------------------- | -------------- |
| app    | differs  | 2 601          | 194 (Pass 18: 212), all `.next/`                                              | 92, identical  |
| worker | differs  | 5 687          | 1 (Pass 18: 2): pnpm's `.modules.yaml`                                        | 306, identical |
| ops    | —        | —              | not compared: the second build ran out of disk in this environment (`ENOSPC`) | —              |

What still differs in the app, and why it stays:

- **Server Action IDs and the files that reference them** (59 page manifests under
  `server/app`, the two root `server-reference-manifest` files, 72 server chunks, 13 client
  chunks): Next.js derives the IDs with a per-build encryption key (`encryptionKey` in
  `server-reference-manifest.json`). A fixed key would have to be supplied at build time
  (`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY`), i.e. baked into the image as a secret shared by
  every build — not done.
- **Preview-mode keys** (`prerender-manifest.json`, `preview-props.json`): per-build
  secrets, rightly different.
- **Output-trace file lists** (46 `.nft.json`): all 46 list the same files, in a different
  order (checked file by file).
- **pnpm's `.modules.yaml`** (worker, ops): an install timestamp in pnpm's own state file,
  which pnpm reads on later installs; left alone (no image runs an install). The differing
  `.bin` shim of Pass 18's worker did not recur in this measurement; the ops image was not
  compared this time.

So the builds are **still not byte-reproducible**; the random build ID is gone, and every
remaining difference is a per-build secret or an ordering/timestamp artifact.

## 5. CI

`.github/workflows/ci.yml`, job _Docker image builds_: builds the three targets with
`GIT_SHA=${{ github.sha }}`, validates the Compose file, then runs
`scripts/release/verify-images.sh … "${{ github.sha }}"`. Any failing check fails the
job; no step is allowed to fail softly. The integration job also runs the restore drill
and its mutation test (`scripts/ops/restore-drill-mutants.sh`); the quality job runs
`terraform fmt/validate/test` against the lock file.

## 6. Terraform provider checksums

`deploy/staging/aws/.terraform.lock.hcl` pins `hashicorp/aws` 6.69.1: the `zh:` hashes of
all 15 platform packages, taken from `terraform-provider-aws_6.69.1_SHA256SUMS`, whose
GPG signature was verified ("Good signature from HashiCorp Security", subkey
`374EC75B485913604A831CC7C820C6D5CD27AB87` of primary key
`C874 011F 0AB4 0511 0D02 1055 3436 5D94 72D7 468F`, the key published at
hashicorp.com/.well-known/pgp-key.txt), and the `h1:` hash of the linux_amd64 package,
which matched those sums. `terraform init` refuses a provider whose checksum differs
(tested with an altered hash). `terraform init` on another platform verifies that
platform's package against its `zh:` entry.

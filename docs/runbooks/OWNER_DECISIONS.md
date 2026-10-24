# Owner decisions — short list (Pass 41, 2026-10-24)

Ranked by how much of the launch path each one unblocks. Each needs an explicit decision;
none was assumed.

| #   | Decision                                                                                                          | Unblocks                                            | Detail                                  |
| --- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------- |
| 1   | Restore GitHub Actions on the account (billing / spending limit / account lock)                                   | CI on the candidate; every later step               | `CI_STATUS.md` § Pass 40                |
| 2   | Approve pushing `p41-rc-candidate` and adopting it as the release candidate (replacing `a463d1c`)                 | CI run on it; staging from it                       | `RC_REVIEW_PASS_41.md`                  |
| 3   | `terraform.tfvars`: region (data residency), `app_domain`, sizes, backup retention                                | Preflight, `terraform plan`                         | `STAGING_EXECUTION_PLAN.md` § Pass 41.1 |
| 4   | Staging approvals, each separately: (1) plan (2) apply (3) ECR push (4) deploy                                    | Hosted staging, A1–A13, PITR, off-host backup       | `STAGING_EXECUTION_PLAN.md`             |
| 5   | Alert destination, on-call person, uptime service, log retention (R-7); backup bucket and retention (R-8)         | A7, A8, A12, O5, O6                                 | `LAUNCH_CLOSURE_MATRIX.md` § 3          |
| 6   | FFmpeg: approve D (credential-less FFmpeg container, 3–7 days) and decide on A (Ubuntu Pro, price from Canonical) | Closing S2                                          | `FFMPEG_RISK_DECISION.md` § 6           |
| 7   | Separate approval for session hashing in production                                                               | Production deploy                                   | `SESSION_TOKENS.md`                     |
| 8   | Target markets and selling entity; engage a lawyer and a tax adviser there                                        | Legal texts, deletion/export scope, VAT/e-invoicing | `COMMERCIAL_DECISION_PACK.md` § 7       |
| 9   | Payment provider (after its written answers) and a sandbox account                                                | Payments work                                       | `PAYMENTS_DESIGN.md` § 8                |
| 10  | Production approval (5)                                                                                           | Launch                                              | after all of the above                  |

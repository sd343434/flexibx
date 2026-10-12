# Flexibx privacy policy — DRAFT (not published, not legal advice)

> **Status: draft for the operator's legal review.** Not linked from the site and not to
> be submitted to Meta until the operator (the legal entity running Flexibx) has filled
> in the bracketed items and approved the text. Every statement below describes what the
> code does today (2026-10-12); a change in the code must be reflected here before
> publishing.

Meta requires a public privacy policy URL for App Review and for switching the app to
Live mode, plus a data deletion callback or instructions URL (already implemented:
`/api/integrations/meta/data-deletion`, page `/{locale}/meta-data-deletion`).

## Open items for the operator

- Legal name, address, country and contact email of the operator; data protection
  contact (if any).
- Applicable law and lawful bases (e.g. Saudi PDPL, GDPR for EU users) — a legal decision.
- Retention periods for accounts, workspaces, plans and audit logs after a workspace or
  account is deleted (the code keeps audit logs; no automatic purge exists except for
  generated videos).
- Hosting provider and region, email provider, storage provider(s) actually used.
- Whether any analytics or error tracking is added (none today).

## 1. Who we are

[Operator legal name], [address], operates Flexibx ("we"). Contact: [email].

## 2. Data we process

| Data                                                                                                                                                                                                       | Source                                 | Purpose                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Account: name, email, password (stored as a hash), language, verification state                                                                                                                            | You                                    | Sign-in, security emails                                                                          |
| Workspace content: brand, products, audiences, campaigns, content drafts, plans, approvals                                                                                                                 | You and your team                      | The service                                                                                       |
| Security and audit records: actions, time, IP address and browser user agent                                                                                                                               | Automatic                              | Security, accountability to your workspace                                                        |
| Meta (Facebook/Instagram ads) connection: app-scoped Facebook user id and name, granted permissions, an access token (encrypted with AES-256-GCM)                                                          | Meta, after you approve the connection | Reading your ad accounts and results; creating campaigns only after an approval in your workspace |
| Ad account data: account names, currency, status, campaigns, ad sets, ads, results (impressions, clicks, spend)                                                                                            | Meta                                   | Showing results and planning                                                                      |
| WhatsApp Business: account and phone number details, message templates; contacts your workspace adds (phone number stored encrypted, consent and opt-out history); messages sent and their delivery status | Meta and your workspace                | Sending approved messages to people who opted in                                                  |
| Text sent to the AI provider (e.g. brand and campaign details for a plan)                                                                                                                                  | You                                    | Generating suggestions; sent with storage disabled at the provider [confirm provider terms]       |
| Generated videos                                                                                                                                                                                           | You                                    | Kept 7 days, then deleted; their records 30 days                                                  |
| Cookies: session, language (`NEXT_LOCALE`), last workspace; the light/dark theme is kept in the browser's local storage                                                                                    | Automatic                              | Sign-in and preferences; no advertising cookies                                                   |

## 3. Meta Platform data

We use data received from Meta only to provide the features you turn on in your
workspace. We do not sell it, use it for advertising profiles, or share it except with
the processors listed below. Campaigns are created or changed on Meta only after a
member with approval rights approves the exact change in Flexibx, within the spending
limits the workspace sets.

## 4. Sharing

Processors: [hosting], [database], [object storage], [email], [AI provider]. Meta
receives the requests needed to run the features you use. No other sharing, except
where required by law.

## 5. Security

Tokens and WhatsApp contact numbers are encrypted; workspaces are isolated from each
other; access follows workspace roles; every sensitive action is recorded.

## 6. Retention and deletion

- Disconnect a platform in Integrations at any time: its token is erased immediately.
- Removing Flexibx in your Facebook settings, or asking Facebook to delete your data,
  revokes every connection linked to your Facebook account and erases the token (and,
  for deletion, the stored Facebook id and name). Status page:
  `/{locale}/meta-data-deletion`.
- Workspace business data stays with the workspace until its owner deletes it.
  [Operator: state retention after deletion.]

## 7. Your rights

[Operator: access, correction, deletion, objection, complaint authority — per applicable
law.] Contact: [email].

## 8. Changes

We will post changes here with a new date. Last updated: [date].

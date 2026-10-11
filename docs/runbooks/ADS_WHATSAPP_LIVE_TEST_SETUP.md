# Meta Ads and WhatsApp: live-test setup

This is everything that must exist outside the code before Flexibx can create Meta
campaigns or send WhatsApp messages for real. Local tests use a fake Graph API. They
prove the app behaves correctly against the documented contract. They do **not** prove
that Meta accepts the requests. Only the supervised run in step 7 does that.

Do the steps in order. Never paste secret values into tickets, chats or logs. Each
secret belongs only in the server's environment (`.env` locally, or the host's secret
store).

## 0. Current state (checked 2026-10-11)

| Setting                                                                        | Local `.env`                  |
| ------------------------------------------------------------------------------ | ----------------------------- |
| `DATABASE_URL`, `APP_URL`                                                      | set (`http://localhost:3000`) |
| `AUTH_SECRET`, `ENCRYPTION_KEY`                                                | present but empty             |
| `META_APP_ID`, `META_APP_SECRET`, `META_GRAPH_VERSION`, `META_REDIRECT_URI`    | absent                        |
| `WHATSAPP_CONFIG_ID`, `WHATSAPP_REDIRECT_URI`, `WHATSAPP_WEBHOOK_VERIFY_TOKEN` | absent                        |
| `ADS_EXECUTION_ENABLED`, `WHATSAPP_SENDING_ENABLED`                            | absent (= off)                |

There are no Meta app, test ad account, Page, WABA, templates or webhook subscriptions
yet. The persistent databases are behind on migrations:

- `flexibx` has 15 of 19 applied;
- `flexibx_test` has 12 of 19.

## 1. Server basics

1. `ENCRYPTION_KEY`: run `openssl rand -base64 32`. This key encrypts every platform
   token. If you change it later, every connection has to be made again.
2. `AUTH_SECRET`: run `openssl rand -base64 32`.
3. `APP_URL`: a public **HTTPS** origin. Meta refuses plain-HTTP redirect and webhook
   URLs. For a local test, use a tunnel, for example
   `cloudflared tunnel --url http://localhost:3000`, and set `APP_URL` to the tunnel
   origin.
4. Apply the pending migrations (16–19: advertising core, WhatsApp core, execution and
   messaging, execution hardening) with `pnpm db:deploy`. Do this **only after the
   owner approves** applying them to that database. Then check that
   `SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL` returns 19.

## 2. Meta app (developers.facebook.com)

1. Create a **Business** type app and attach it to your Business portfolio.
2. Set these environment variables:
   - `META_APP_ID` and `META_APP_SECRET`, from App settings → Basic.
   - `META_GRAPH_VERSION=v26.0`. This is the default; set it explicitly anyway.
3. Add the **Facebook Login for Business** product.
4. Under Valid OAuth Redirect URIs, add both of these:
   - `{APP_URL}/api/integrations/meta/callback`
   - `{APP_URL}/api/integrations/whatsapp/callback`
5. Permissions. While the app is in Development mode, these work only for people who
   have an app role (admin, developer or tester). Request Advanced Access through App
   Review before anyone else can use them.

   | Permission                     | Used for                                           |
   | ------------------------------ | -------------------------------------------------- |
   | `ads_read`                     | reading accounts and insights (always requested)   |
   | `ads_management`               | creating campaigns, ad sets, ads and images        |
   | `pages_show_list`              | listing the person's Pages and their tasks         |
   | `pages_manage_ads`             | creating the creative with the Page's access token |
   | `whatsapp_business_management` | reading the WABA, its numbers and templates        |
   | `whatsapp_business_messaging`  | sending messages                                   |

   Flexibx asks for the three write permissions only when `ADS_EXECUTION_ENABLED=true`,
   and it refuses every write unless all three were granted. A connection made before
   you turn the flag on must be reconnected.

6. Complete **Business Verification** for the portfolio. It is required for Advanced
   Access to `ads_management` and the WhatsApp permissions.

## 3. Test ad account and Page

1. Use a dedicated test ad account in your Business portfolio. Do not use a production
   account.
   - Its currency must use two decimals (USD, EUR, SAR, AED, …). Flexibx refuses
     currencies whose minor unit it cannot confirm.
   - It needs a valid payment method. Nothing spends money while campaigns stay
     PAUSED.
   - Set a low **account spending limit** in Ads Manager as a hard cap at Meta's end.
2. Use a Facebook Page where the connecting person has the **ADVERTISE** task. Flexibx
   lists only those Pages. It fetches the Page's access token from `/me/accounts`
   immediately before it creates the creative, and never stores it.
3. In Flexibx, open Settings → Advertising and connect Meta. Choose the test account and
   then set a **workspace spending limit** in the account's currency. Without one,
   creation and activation are refused.

## 4. WhatsApp Business (same Meta app)

1. Add the **WhatsApp** product to the app.
2. Under Facebook Login for Business → Configurations, create an **Embedded Signup**
   configuration that includes the `whatsapp_business_management` and
   `whatsapp_business_messaging` permissions. Put its id in `WHATSAPP_CONFIG_ID`.
   `WHATSAPP_REDIRECT_URI` is optional and defaults to the WhatsApp callback above.
3. Webhook:
   - Generate a verify token with `openssl rand -hex 24` and put it in
     `WHATSAPP_WEBHOOK_VERIFY_TOKEN`.
   - Under WhatsApp → Configuration, set the callback URL to
     `{APP_URL}/api/integrations/whatsapp/webhook` and enter the same verify token.
     The verify (GET) step must succeed.
   - Subscribe to the **`messages`** and **`user_preferences`** fields.
   - Deliveries are signed with `META_APP_SECRET` (`X-Hub-Signature-256`). Unsigned or
     mis-signed deliveries are rejected.
4. Subscribe the app to the WABA: `POST /{waba-id}/subscribed_apps` with a token for
   that WABA. Do this from Graph API Explorer or Business settings. Flexibx does not call
   it.
5. Business phone number:
   - Use a registered and verified number, or Meta's free test number.
   - Add a payment method to the WABA. Template messages are charged.
6. Templates. In WhatsApp Manager, create and get approval for at least:
   - one **UTILITY** template and one **MARKETING** template;
   - each in the exact language code you will send, for example `ar` or `en_US`;
   - each with the body parameters you plan to fill in.
7. Test recipients:
   - Use real handsets owned by the test team.
   - With Meta's test number, add each one as an allowed recipient (up to five).
   - In Flexibx, record each one's opt-in with its source before any send.
8. In Flexibx, connect WhatsApp (Embedded Signup), select the WABA and then **Sync**.
   Sends rely on number and template data no more than 24 hours old.

## 5. Turn on writes

Only after steps 1–4 are complete:

```
ADS_EXECUTION_ENABLED=true
WHATSAPP_SENDING_ENABLED=true
```

Restart the server. Reconnect Meta so that the write permissions are granted.

## 6. Background work

Approved actions run when they are approved. If a runner dies partway through, its
interrupted work must be recovered:

- `pnpm automation:tick` recovers expired tasks. A send that was in flight becomes
  **UNCERTAIN** and is never retried automatically.
- Run it by hand during the test, or have a scheduler call it every few minutes.

## 7. Supervised live test (one person watching; stop at the first surprise)

Keep the workspace **emergency stop** within reach. It blocks every write before the
next request.

1. **Ads, paused creation.**
   - Create one plan: Facebook placements, AWARENESS or TRAFFIC, the lowest daily
     budget, and the chosen Page.
   - Approve creation.
   - Expect a campaign, ad set, image, creative and ad in Ads Manager, all **PAUSED**,
     and a COMPLETED execution ledger.
   - If Meta rejects any of these assumed parameters, record the exact error and do not
     activate:
     - `is_adset_budget_sharing_enabled=false`
     - `targeting_automation.advantage_audience=0`
     - TRAFFIC with no explicit `destination_type`
2. **Ads, reconciliation.**
   - Start a second creation and engage the emergency stop during it.
   - Expect the run to halt, with no orphan objects left untagged in Ads Manager.
   - Lift the stop and confirm the app resumes or reconciles. It must not create
     duplicates.
3. **Ads, activation (optional; this spends money).**
   - Only with the owner present and the spending limits in place.
   - Activate, check that it is delivering, then pause it again in Flexibx and in Ads
     Manager.
4. **WhatsApp, single send.**
   - Send one UTILITY template to one opted-in test recipient and approve it.
   - Expect SENT, then `delivered` and `read` statuses through the webhook.
5. **WhatsApp, opt-out.**
   - From the test handset, stop marketing messages from the business. Expect a
     `user_preferences` delivery that marks the contact as opted out of marketing.
     Record the **exact** `category` and `value` strings Meta sends. The parser accepts
     only `category: marketing_messages`, and treats any value other than `resume` as a
     stop.
   - A queued MARKETING send to that contact must become CANCELLED.
   - Reply STOP and expect a full opt-out.
6. Afterwards:
   - Set both flags back to empty unless you are continuing.
   - Delete the test campaign in Ads Manager.
   - Record the findings in `docs/ADVERTISING.md` (Documented vs Assumption).

import "server-only";

import { parseMailEnv } from "../env-schema";
import { logger } from "../logger";
import { alert } from "../monitoring/alerts";

import { createMailer, type Mailer } from "./mailer";

export * from "./mailer";

let mailer: Mailer | undefined;

/** The configured mailer for this process (see createMailer). */
export function getMailer(): Mailer {
  if (mailer === undefined) {
    const env = parseMailEnv(process.env);
    mailer = withDeliveryAlerts(
      createMailer(process.env.NODE_ENV, logger, {
        transport: env.MAIL_TRANSPORT,
        outboxDir: env.MAIL_OUTBOX_DIR,
        resend:
          env.RESEND_API_KEY === undefined || env.MAIL_FROM === undefined
            ? undefined
            : { apiKey: env.RESEND_API_KEY, from: env.MAIL_FROM },
      }),
    );
  }
  return mailer;
}

/**
 * A failed delivery raises an alert (email provider down or misconfigured): the template
 * name and transport only — never the address or the message. The error still reaches
 * the caller, which decides what the user sees. The instance itself is kept (tests read
 * the in-memory transport's outbox).
 */
function withDeliveryAlerts(mailer: Mailer): Mailer {
  const send = mailer.send.bind(mailer);
  mailer.send = async (message) => {
    try {
      return await send(message);
    } catch (error) {
      // Not awaited: the caller's answer never waits for the alert delivery.
      void alert({
        key: `email_delivery_failed:${mailer.transport}`,
        severity: "warning",
        title: "Email delivery failed",
        details: {
          transport: mailer.transport,
          template: message.template,
          error: error instanceof Error ? error.name : "unknown",
        },
      });
      throw error;
    }
  };
  return mailer;
}

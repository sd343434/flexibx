import "server-only";

import { parseMailEnv } from "../env-schema";
import { logger } from "../logger";

import { createMailer, type Mailer } from "./mailer";

export * from "./mailer";

let mailer: Mailer | undefined;

/** The configured mailer for this process (see createMailer). */
export function getMailer(): Mailer {
  if (mailer === undefined) {
    const env = parseMailEnv(process.env);
    mailer = createMailer(process.env.NODE_ENV, logger, {
      transport: env.MAIL_TRANSPORT,
      outboxDir: env.MAIL_OUTBOX_DIR,
    });
  }
  return mailer;
}

import "server-only";

import { logger } from "../logger";

import { createMailer, type Mailer } from "./mailer";

export * from "./mailer";

let mailer: Mailer | undefined;

/** The configured mailer for this process (see createMailer). */
export function getMailer(): Mailer {
  mailer ??= createMailer(process.env.NODE_ENV, logger);
  return mailer;
}

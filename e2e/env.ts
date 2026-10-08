import { resolve } from "node:path";

// Shared by playwright.config.ts (test server environment) and the specs.

/** Emails of the test run (MAIL_TRANSPORT=test-outbox), one JSON file per message. */
export const MAIL_OUTBOX_DIR = resolve("test-results/mail-outbox");

/** Trusted client-IP header of the test server; each browser context sends its own. */
export const E2E_IP_HEADER = "x-e2e-client-ip";

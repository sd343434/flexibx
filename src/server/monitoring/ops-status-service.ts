import "server-only";

import { getSystemDb } from "../db/client";
import { parseMonitoringEnv } from "../env-schema";

import {
  collectOpsStatus,
  DEFAULT_LEDGER_INTEGRITY_INTERVAL_MS,
  type OpsStatus,
} from "./ops-status";

/** LEDGER_INTEGRITY_INTERVAL_MINUTES in milliseconds (invalid values: reported at start-up). */
export function ledgerIntegrityIntervalMs(): number {
  try {
    return parseMonitoringEnv(process.env).LEDGER_INTEGRITY_INTERVAL_MINUTES * 60_000;
  } catch {
    return DEFAULT_LEDGER_INTEGRITY_INTERVAL_MS;
  }
}

/** The current operational status (counts only; see ops-status.ts). */
export function getOpsStatus(now: Date = new Date()): Promise<OpsStatus> {
  return collectOpsStatus(getSystemDb(), now, {
    ledgerIntegrityIntervalMs: ledgerIntegrityIntervalMs(),
  });
}

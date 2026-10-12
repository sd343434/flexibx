import "server-only";

import { getSystemDb } from "../db/client";

import { collectOpsStatus, type OpsStatus } from "./ops-status";

/** The current operational status (counts only; see ops-status.ts). */
export function getOpsStatus(now: Date = new Date()): Promise<OpsStatus> {
  return collectOpsStatus(getSystemDb(), now);
}

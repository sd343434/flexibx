import type { Db } from "../db/types";

// Stopping a workspace's Meta Insights sources when it loses its authority over Meta (a
// separate module: the advertising connection and Meta's callbacks call it, and it needs
// nothing from them).

/**
 * The workspace lost its authority over Meta (disconnected, the person removed the app,
 * or asked Meta to delete their data): every source stops, with the reason. Run inside
 * the transaction that records the loss. The numbers already read stay (business
 * metrics, no personal data); see the readiness register for the deletion decision.
 */
export async function revokeInsightsSources(
  tx: Db,
  workspaceId: string,
  reason: "disconnected" | "deauthorized" | "data_deleted",
): Promise<number> {
  const updated = await tx.insightsSource.updateMany({
    where: { workspaceId, enabled: true },
    data: { enabled: false, disabledReason: reason, nextSyncAt: null, version: { increment: 1 } },
  });
  return updated.count;
}

import "server-only";

import { getSystemDb } from "../db/client";

/**
 * Whether the user's account has two-factor authentication on (read from the database).
 * SYSTEM PATH (reviewed): one column of the user's own row.
 */
export async function isTwoFactorEnabled(userId: string): Promise<boolean> {
  const row = await getSystemDb().user.findUnique({
    where: { id: userId },
    select: { twoFactorEnabled: true },
  });
  return row?.twoFactorEnabled === true;
}

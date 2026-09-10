/**
 * Who a broadcast is for.
 *
 * Kept free of imports so the policy can be reasoned about — and tested —
 * without starting a WebSocket server or touching the database.
 */

export function normalizeBroadcastCompanyIds(values: readonly unknown[]): number[] {
  const ids = new Set<number>();
  for (const value of values) {
    const companyId = Number(value);
    if (Number.isSafeInteger(companyId) && companyId > 0) ids.add(companyId);
  }
  return [...ids];
}

export function normalizeBroadcastUserId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const userId = value.trim();
  return userId.length > 0 ? userId : null;
}

/**
 * Whether a socket belonging to one or more authorized company contexts should
 * receive a message scoped to `messageCompanyId`.
 *
 * Unscoped messages reach everyone. Tenant-scoped messages fail closed until at
 * least one authenticated company context resolves.
 */
export function shouldDeliverBroadcastToCompanies(
  socketCompanyIds: readonly number[] | null | undefined,
  messageCompanyId: number | null | undefined
): boolean {
  if (messageCompanyId === undefined || messageCompanyId === null) return true;
  if (!socketCompanyIds?.length) return false;
  return socketCompanyIds.includes(messageCompanyId);
}

/**
 * User-targeted messages fail closed. This is used for cross-company realtime
 * features such as direct chat, where waking every authenticated browser would
 * defeat the purpose of targeted delivery.
 */
export function shouldDeliverBroadcastToUser(
  socketUserId: string | null | undefined,
  recipientUserIds: readonly string[] | null | undefined
): boolean {
  if (recipientUserIds === undefined || recipientUserIds === null) return true;
  if (recipientUserIds.length === 0 || !socketUserId) return false;
  return recipientUserIds.includes(socketUserId);
}

/** Backward-compatible single-company policy used by existing callers/tests. */
export function shouldDeliverBroadcast(
  socketCompanyId: number | null | undefined,
  messageCompanyId: number | null | undefined
): boolean {
  const socketCompanyIds = socketCompanyId === undefined || socketCompanyId === null ? null : [socketCompanyId];
  return shouldDeliverBroadcastToCompanies(socketCompanyIds, messageCompanyId);
}

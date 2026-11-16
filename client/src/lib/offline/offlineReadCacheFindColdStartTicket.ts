// Extracted from ./offlineReadCache.ts to keep that module under the source-size cap.
import { OFFLINE_VAULT_SCHEME } from "./secureSnapshotVault";
import { db, type OfflineColdStartTicket, type OfflineReadGrant } from "../db";
import { offlineReadinessKey } from "./offlineReadPolicy";

export interface OfflineReadActor {
  companyId: number;
  userId: string;
}

export interface ReadBatchInput extends OfflineReadActor {
  snapshots: Array<{ url: string; body: string }>;
  total: number;
  packSummary?: Record<string, { label: string; count: number; completedAt: number }>;
}

export const MAX_OFFLINE_READ_AGE = 8 * 60 * 60 * 1000;

/**
 * Plan batch 5 (decision 10): an encrypted cache, and the cold-start ticket
 * that opens it, stay usable for 24 hours after the user's last online login.
 * Unencrypted (legacy) caches keep the 8-hour limit and never cold-start.
 */
export const COLD_START_WINDOW_MS = 24 * 60 * 60 * 1000;

export const COLD_START_TICKET_MARKER = "erp-offline-cold-start-v1";

/** The identity responses a read-only cold start serves from its ticket, and nothing else. */
export const COLD_START_IDENTITY_URLS = Object.freeze([
  "/api/auth/me",
  "/api/auth/session-company",
  "/api/user/companies",
]);

export type ColdStartIdentity = Record<(typeof COLD_START_IDENTITY_URLS)[number], unknown>;

export const VAULT_CHECK_VALUE = "erp-offline-vault-check-v1";

export async function getOfflineReadGrant(actor: OfflineReadActor): Promise<OfflineReadGrant | null> {
  const grant = await db.offlineReadGrants.get(offlineReadinessKey(actor.companyId, actor.userId));
  if (!grant || grant.companyId !== actor.companyId || grant.userId !== actor.userId) return null;
  return grant;
}

// ---- Plan batch 5 (decision 10): read-only cold start ------------------------
//
// A laptop that reaches neither the cloud nor the factory server becomes a
// read-only viewer. It never takes a write. While the user is verified online
// and has unlocked the encrypted cache, a ticket is sealed with that cache's
// vault key. It holds the identity responses of that verification and expires
// 24 hours after it. After a restart with no connection, the same passphrase
// opens the ticket. That unlocks the cache for reading only, until the
// ticket's expiry. Signing out, or a server answer that the account was
// disabled or removed, wipes the ticket.

export function coldStartTicketScope(
  ticket: Pick<OfflineColdStartTicket, "userId" | "companyId" | "verifiedAt" | "expiresAt">
) {
  return {
    companyId: ticket.companyId,
    userId: ticket.userId,
    url: "erp-internal://offline-cold-start",
    cachedAt: ticket.verifiedAt,
    expiresAt: ticket.expiresAt,
  };
}

/** The newest ticket on this laptop that can still open an encrypted, ready cache. */
export async function findColdStartTicket(now = Date.now()): Promise<OfflineColdStartTicket | null> {
  try {
    const tickets = await db.offlineColdStartTickets.orderBy("verifiedAt").reverse().toArray();
    for (const ticket of tickets) {
      if (
        ticket.expiresAt <= now ||
        ticket.verifiedAt > now ||
        ticket.expiresAt - ticket.verifiedAt > COLD_START_WINDOW_MS
      )
        continue;
      const grant = await getOfflineReadGrant(ticket);
      if (
        grant &&
        grant.status === "ready" &&
        grant.expiresAt > now &&
        grant.protection === OFFLINE_VAULT_SCHEME &&
        grant.vaultSalt === ticket.vaultSalt
      )
        return ticket;
    }
  } catch {
    // Unavailable IndexedDB means no cold start, never a fabricated one.
  }
  return null;
}

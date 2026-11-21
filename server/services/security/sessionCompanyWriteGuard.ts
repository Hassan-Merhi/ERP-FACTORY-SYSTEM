/**
 * Keeps the newest company selection when a session is written.
 *
 * express-session persists the whole session a request loaded. A request that
 * started before a company switch and finishes after it would therefore write
 * the previous company back, and every tab then follows the session to the
 * wrong company. A switch stamps `companySelectedAt`; a write carrying an
 * older stamp than the stored session keeps the stored selection and only
 * contributes its other fields.
 */
export const COMPANY_SELECTION_SESSION_FIELDS = [
  "currentCompanyId",
  "currentCompanyName",
  "currentRole",
  "currentLocationId",
  "currentPOSStation",
  "cashAccountId",
  "canSellNegativeStock",
  "posViewOnly",
  "daybookEditDays",
  "canAccessCustomers",
  "canDeleteRecords",
  "factoryCompanyId",
  "factoryCompanyName",
  "securityPermissions",
  "securityPermissionsCompanyId",
  "companyRevision",
  "companySelectedAt",
] as const;

type SessionRecord = Record<string, unknown>;

function selectedAt(session: SessionRecord): number {
  const value = session.companySelectedAt;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Returns true when the incoming write was stale and the stored selection was kept. */
export function keepNewerCompanySelection(incoming: SessionRecord, stored: SessionRecord | null | undefined): boolean {
  if (!stored || selectedAt(stored) <= selectedAt(incoming)) return false;
  // Never carry a selection across users (a session id is not reused, but a
  // guard that moves company fields must not depend on that).
  if (stored.userId !== incoming.userId) return false;
  for (const field of COMPANY_SELECTION_SESSION_FIELDS) {
    if (field in stored) incoming[field] = stored[field];
    else delete incoming[field];
  }
  return true;
}

interface SessionStoreLike {
  get(sid: string, callback: (error: unknown, session?: unknown) => void): void;
  set(sid: string, session: never, callback?: (error?: unknown) => void): void;
}

/** Wraps a store so every write keeps the newest company selection. */
export function guardCompanySelectionWrites(store: SessionStoreLike): void {
  const persist = store.set.bind(store) as (
    sid: string,
    session: unknown,
    callback?: (error?: unknown) => void
  ) => void;
  (store as { set: unknown }).set = (sid: string, session: SessionRecord, callback?: (error?: unknown) => void) => {
    store.get(sid, (error, stored) => {
      // A failed read must not block the write; the session is still saved.
      if (!error) keepNewerCompanySelection(session, stored as SessionRecord | null | undefined);
      persist(sid, session, callback);
    });
  };
}

import type { DatabaseOrTransaction, DatabasePool, DbTransaction } from "../../db";
import { eq, sql } from "drizzle-orm";
import { userCredentialVersions } from "@shared/schema";

export interface CredentialVersionSession {
  userId?: string | null;
  credentialVersion?: number | null;
  activeCredentialVersion?: number | null;
  credentialVersionCheckedAt?: number | null;
}

const DEFAULT_REFRESH_MS = 60_000;

export async function loadCredentialVersion(db: DatabaseOrTransaction, userId: string): Promise<number> {
  const [row] = await db
    .select({ credentialVersion: userCredentialVersions.credentialVersion })
    .from(userCredentialVersions)
    .where(eq(userCredentialVersions.userId, userId))
    .limit(1);

  if (row) return Number(row.credentialVersion) || 0;

  const [created] = await db
    .insert(userCredentialVersions)
    .values({ userId, credentialVersion: 0 })
    .onConflictDoNothing({ target: userCredentialVersions.userId })
    .returning({ credentialVersion: userCredentialVersions.credentialVersion });

  return Number(created?.credentialVersion) || 0;
}

export async function hydrateActiveCredentialVersion(
  db: DatabaseOrTransaction,
  session: CredentialVersionSession,
  options: { now?: number; refreshMs?: number } = {}
): Promise<number> {
  const userId = session.userId;
  if (!userId) return 0;

  const now = options.now ?? Date.now();
  const refreshMs = options.refreshMs ?? DEFAULT_REFRESH_MS;
  const checkedAt = Number(session.credentialVersionCheckedAt) || 0;

  if (
    Number.isInteger(session.activeCredentialVersion) &&
    session.activeCredentialVersion! >= 0 &&
    checkedAt > 0 &&
    now - checkedAt < refreshMs
  ) {
    return session.activeCredentialVersion!;
  }

  const active = await loadCredentialVersion(db, userId);
  session.activeCredentialVersion = active;
  session.credentialVersionCheckedAt = now;

  // One-time deployment bridge for sessions created before credential versions existed.
  // After the first refresh, all sessions carry an explicit version and fail closed on mismatch.
  if (!Number.isInteger(session.credentialVersion) || session.credentialVersion! < 0) {
    session.credentialVersion = active;
  }

  return active;
}

export async function bumpCredentialVersion(tx: DbTransaction, userId: string): Promise<number> {
  const [row] = await tx
    .insert(userCredentialVersions)
    .values({ userId, credentialVersion: 1, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: userCredentialVersions.userId,
      set: {
        credentialVersion: sql`${userCredentialVersions.credentialVersion} + 1`,
        updatedAt: new Date(),
      },
    })
    .returning({ credentialVersion: userCredentialVersions.credentialVersion });

  return Number(row?.credentialVersion) || 1;
}

export async function revokeUserSessions(pool: DatabasePool, userId: string, exceptSid?: string | null): Promise<void> {
  if (exceptSid) {
    await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1 AND sid <> $2`, [userId, exceptSid]);
    return;
  }
  await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1`, [userId]);
}

export async function revokeUserCompanySessions(
  pool: DatabasePool,
  userId: string,
  companyId: number,
  exceptSid?: string | null
): Promise<void> {
  const companyIdText = String(companyId);
  if (exceptSid) {
    await pool.query(
      `DELETE FROM session WHERE sess->>'userId' = $1 AND sess->>'currentCompanyId' = $2 AND sid <> $3`,
      [userId, companyIdText, exceptSid]
    );
    return;
  }

  await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1 AND sess->>'currentCompanyId' = $2`, [
    userId,
    companyIdText,
  ]);
}

export async function rotateCredentialsAndRevokeSessions(
  db: DatabaseOrTransaction,
  pool: DatabasePool,
  userId: string,
  options: { exceptSid?: string | null } = {}
): Promise<number> {
  const version = await db.transaction((tx: DbTransaction) => bumpCredentialVersion(tx, userId));
  await revokeUserSessions(pool, userId, options.exceptSid);
  return version;
}

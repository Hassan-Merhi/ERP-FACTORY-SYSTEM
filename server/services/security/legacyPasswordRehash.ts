/**
 * Legacy SHA-256 password hashes (accounting audit phase 26 leftover,
 * decided by default: owner can override).
 *
 * Supervisor / admin confirmations (factory stock removal, product creation,
 * the factory docs authorization) still accept a password stored as an
 * unsalted SHA-256 digest, so a user who never signs in again keeps it
 * forever. On the next SUCCESSFUL check the password is rehashed to bcrypt
 * (new hashes are bcrypt only); the swap is compare-and-set on the old digest
 * and audited, so a concurrent password change is never overwritten.
 * `listLegacyPasswordHashUsers` is the diagnostic of the accounts still on
 * SHA-256 (the owner asks them to sign in or resets them).
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { userCompanyRoles, users } from "@shared/schema";

import { db } from "../../db";
import { logger } from "../../lib/logger";
import { hashPassword, isLegacySHA256Hash, verifyLegacyPassword } from "../../routes/helpers/passwordHelpers";
import { writeAuditEvent } from "../audit";

/** Rehashes a verified legacy password to bcrypt; returns whether the stored hash changed. */
export async function rehashLegacyPasswordAfterVerify(
  user: { id: string; username?: string | null },
  password: string,
  legacyHash: string
): Promise<boolean> {
  if (!isLegacySHA256Hash(legacyHash)) return false;
  const bcryptHash = await hashPassword(password);
  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(users)
      .set({ password: bcryptHash })
      .where(and(eq(users.id, user.id), eq(users.password, legacyHash)))
      .returning({ id: users.id });
    if (!updated) return false;
    await writeAuditEvent(
      {
        userId: user.id,
        username: user.username || user.id,
        action: "update",
        tableName: "users",
        recordIdentifier: `password-rehash:${user.id}`,
        reason: "Legacy SHA-256 password rehashed to bcrypt after a successful check",
        changes: { passwordHashAlgorithm: { old: "sha256", new: "bcrypt" } },
      },
      tx
    );
    return true;
  });
}

/**
 * Verifies a supervisor's password (bcrypt, or the legacy SHA-256 digest) and,
 * when a legacy digest matched, rehashes it to bcrypt. A failed rehash is
 * logged and never turns a correct password into a refusal.
 */
export async function verifyAndUpgradeSupervisorPassword(
  user: { id: string; username?: string | null; password: string },
  password: string,
  verifyBcrypt: (password: string, hash: string) => Promise<boolean>
): Promise<boolean> {
  if (!isLegacySHA256Hash(user.password)) return verifyBcrypt(password, user.password);
  if (!verifyLegacyPassword(password, user.password)) return false;
  try {
    await rehashLegacyPasswordAfterVerify(user, password, user.password);
  } catch (error: unknown) {
    logger.warn("[security] Legacy password rehash failed; the check still passed", {
      userId: user.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return true;
}

export interface LegacyPasswordHashUser {
  id: string;
  username: string;
  active: boolean;
}

/** Users of the company whose stored password is still a legacy SHA-256 digest. */
export async function listLegacyPasswordHashUsers(companyId: number): Promise<LegacyPasswordHashUser[]> {
  const members = await db
    .select({ userId: userCompanyRoles.userId })
    .from(userCompanyRoles)
    .where(eq(userCompanyRoles.companyId, companyId));
  const ids = [...new Set(members.map((member) => member.userId))];
  if (ids.length === 0) return [];
  const rows = await db
    .select({ id: users.id, username: users.username, active: users.active })
    .from(users)
    .where(and(inArray(users.id, ids), sql`${users.password} ~* '^[0-9a-f]{64}$'`))
    .orderBy(users.username);
  return rows.map((row) => ({ id: String(row.id), username: row.username, active: row.active }));
}

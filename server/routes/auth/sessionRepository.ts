import { desc, eq, inArray } from "drizzle-orm";
import { loginHistory } from "@shared/schema";

import { db, pool } from "../../db";

export interface StoredSessionRow {
  sid: string;
  sess: Record<string, unknown>;
  expire: Date | string;
}

/**
 * connect-pg-simple is configured with createTableIfMissing, so it creates the
 * session table on its first store write rather than at startup. Until then the
 * table is genuinely absent and there are genuinely zero stored sessions, so
 * these queries answered a 42P01 (undefined_table) that surfaced as a 500 —
 * most visibly on DELETE /api/sessions/:sid, which should report 404 for a
 * session that is not stored.
 *
 * Narrow on purpose: only undefined_table, and only for this table's queries.
 * Any other database error still propagates.
 */
function isMissingSessionTable(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "42P01";
}

export const sessionRepository = {
  async listActiveSessions(userId: string | undefined, includeAllUsers: boolean): Promise<StoredSessionRow[]> {
    try {
      if (includeAllUsers) {
        const result = await pool.query(
          `SELECT sid, sess, expire FROM session WHERE expire > NOW() ORDER BY (sess->>'userId') NULLS LAST, expire DESC`
        );
        return result.rows;
      }

      const result = await pool.query(
        `SELECT sid, sess, expire FROM session WHERE expire > NOW() AND sess->>'userId' = $1 ORDER BY expire DESC`,
        [userId]
      );
      return result.rows;
    } catch (error: unknown) {
      if (isMissingSessionTable(error)) return [];
      throw error;
    }
  },

  async getSession(sid: string): Promise<StoredSessionRow | null> {
    try {
      const result = await pool.query(`SELECT sid, sess, expire FROM session WHERE sid = $1`, [sid]);
      return result.rows[0] ?? null;
    } catch (error: unknown) {
      if (isMissingSessionTable(error)) return null;
      throw error;
    }
  },

  async deleteSession(sid: string) {
    try {
      return await pool.query(`DELETE FROM session WHERE sid = $1`, [sid]);
    } catch (error: unknown) {
      if (isMissingSessionTable(error)) return null;
      throw error;
    }
  },

  async deleteOtherUserSessions(userId: string | undefined, currentSid: string) {
    try {
      return await pool.query(`DELETE FROM session WHERE sess->>'userId' = $1 AND sid != $2`, [userId, currentSid]);
    } catch (error: unknown) {
      if (isMissingSessionTable(error)) return null;
      throw error;
    }
  },

  async getLatestGeoByIp(ips: string[]) {
    if (ips.length === 0) return [];
    return db
      .select({
        ipAddress: loginHistory.ipAddress,
        city: loginHistory.city,
        country: loginHistory.country,
      })
      .from(loginHistory)
      .where(inArray(loginHistory.ipAddress, ips))
      .orderBy(desc(loginHistory.loginAt))
      .limit(100);
  },

  getLoginHistory(companyId?: number) {
    return db
      .select()
      .from(loginHistory)
      .where(companyId ? eq(loginHistory.companyId, companyId) : undefined)
      .orderBy(desc(loginHistory.loginAt))
      .limit(500);
  },
};

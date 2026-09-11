import { desc, eq, inArray } from "drizzle-orm";
import { loginHistory } from "@shared/schema";

import { db, pool } from "../../db";

export interface StoredSessionRow {
  sid: string;
  sess: Record<string, unknown>;
  expire: Date | string;
}

export const sessionRepository = {
  async listActiveSessions(userId: string | undefined, includeAllUsers: boolean): Promise<StoredSessionRow[]> {
    if (includeAllUsers) {
      const result = await pool.query(
        `SELECT sid, sess, expire FROM session WHERE expire > NOW() ORDER BY (sess->>'userId') NULLS LAST, expire DESC`,
      );
      return result.rows;
    }

    const result = await pool.query(
      `SELECT sid, sess, expire FROM session WHERE expire > NOW() AND sess->>'userId' = $1 ORDER BY expire DESC`,
      [userId],
    );
    return result.rows;
  },

  async getSession(sid: string): Promise<StoredSessionRow | null> {
    const result = await pool.query(`SELECT sid, sess, expire FROM session WHERE sid = $1`, [sid]);
    return result.rows[0] ?? null;
  },

  deleteSession(sid: string) {
    return pool.query(`DELETE FROM session WHERE sid = $1`, [sid]);
  },

  deleteOtherUserSessions(userId: string | undefined, currentSid: string) {
    return pool.query(`DELETE FROM session WHERE sess->>'userId' = $1 AND sid != $2`, [userId, currentSid]);
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

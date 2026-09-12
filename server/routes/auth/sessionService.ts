import { sessionRepository } from "./sessionRepository";

const ADMIN_SESSION_ROLES = new Set(["Admin", "Owner", "Developer"]);

export class SessionRouteError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "SessionRouteError";
  }
}

export const sessionService = {
  async list(params: { userId: string | undefined; role: string | undefined; currentSid: string }) {
    const includeAllUsers = ADMIN_SESSION_ROLES.has(params.role || "");
    const rows = await sessionRepository.listActiveSessions(params.userId, includeAllUsers);
    const ips = Array.from(new Set(rows.map((row) => row.sess?.ip).filter(Boolean))) as string[];

    const geoByIp: Record<string, { city: string | null; country: string | null }> = {};
    try {
      const geoRows = await sessionRepository.getLatestGeoByIp(ips);
      for (const geo of geoRows) {
        if (geo.ipAddress && !geoByIp[geo.ipAddress]) {
          geoByIp[geo.ipAddress] = {
            city: geo.city || null,
            country: geo.country || null,
          };
        }
      }
    } catch {
      // Session listing remains available when optional login-history enrichment fails.
    }

    return rows.map((row) => {
      const stored = row.sess || {};
      const geo = stored.ip
        ? geoByIp[stored.ip as string] || { city: null, country: null }
        : { city: null, country: null };
      return {
        sid: row.sid,
        isCurrent: row.sid === params.currentSid,
        userId: stored.userId,
        username: stored.username,
        role: stored.currentRole,
        expires: row.expire,
        userAgent: stored.userAgent || null,
        ip: stored.ip || null,
        loginAt: stored.loginAt || null,
        city: geo.city,
        country: geo.country,
      };
    });
  },

  async revoke(params: { sid: string; userId: string | undefined; role: string | undefined }) {
    const session = await sessionRepository.getSession(params.sid);
    if (!session) throw new SessionRouteError(404, "Session not found");

    const isAdmin = ADMIN_SESSION_ROLES.has(params.role || "");
    if (!isAdmin && session.sess?.userId !== params.userId) {
      throw new SessionRouteError(403, "Access denied");
    }

    await sessionRepository.deleteSession(params.sid);
    return { ok: true };
  },

  async revokeOthers(userId: string | undefined, currentSid: string) {
    await sessionRepository.deleteOtherUserSessions(userId, currentSid);
    return { ok: true };
  },

  async loginHistory(role: string | undefined, companyId: number | undefined) {
    if (!ADMIN_SESSION_ROLES.has(role || "")) {
      throw new SessionRouteError(403, "Access denied. Admin or Owner role required.");
    }
    return sessionRepository.getLoginHistory(companyId);
  },
};

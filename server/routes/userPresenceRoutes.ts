/**
 * User-presence routes.
 *
 * Active-user presence tracking (list, heartbeat/update, per-user status and
 * activity, clear, and leave).
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { eq, and, desc, gt, ne, sql } from "drizzle-orm";
import { db } from "../db";
import { requireAuth } from "../auth";
import { broadcast } from "../wsServer";
import { companies, userActivityLog, userPresence, updatePresenceSchema } from "@shared/schema";
import { installPresenceMaintenance } from "../services/presenceMaintenance";
import { assertScreenFeedTenantAccess } from "../services/screenFeedTenantGate";

const PRESENCE_ROLES = new Set(["Admin", "Owner", "Manager", "Developer"]);

function sessionCompanyId(req: Request): number | null {
  const companyId = Number(req.session.currentCompanyId);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : null;
}

function broadcastPresenceChange(companyId: number | null): void {
  if (!companyId) return;
  // Presence lists are company-scoped, so only sockets for the affected tenant
  // are woken. A route change in one company no longer causes every admin
  // client in the ERP to refetch its active-user list.
  broadcast({ type: "invalidate", topics: ["presence"] }, { companyId });
}

async function authorizePresenceDetail(req: Request, res: Response, watchedUserId: string): Promise<{
  role: string;
  companyId: number;
} | null> {
  const role = req.session.currentRole || "";
  if (!PRESENCE_ROLES.has(role)) {
    res.status(403).json({ message: "Access denied." });
    return null;
  }

  const gate = await assertScreenFeedTenantAccess({
    controllerRole: role,
    controllerCompanyId: sessionCompanyId(req),
    watchedUserId,
  });
  if (!gate.allowed) {
    res.status(gate.status).json({ message: gate.message });
    return null;
  }

  return { role, companyId: gate.companyId };
}

export function registerUserPresenceRoutes(app: Express) {
  installPresenceMaintenance();

  // GET: Fetch active users for the selected company. Stale-row deletion is
  // scheduled centrally; this request is now SELECT-only.
  app.get("/api/user-presence", requireAuth, async (req, res) => {
    const userRole = req.session.currentRole;
    if (!userRole || !PRESENCE_ROLES.has(userRole)) {
      return res.status(403).json({ message: "Access denied. Admin, Owner, or Manager role required." });
    }

    try {
      const companyId = sessionCompanyId(req);
      if (!companyId) return res.json([]);

      const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
      const scope = and(
        gt(userPresence.lastSeen, threeMinutesAgo),
        ne(userPresence.role, "Developer"),
        eq(userPresence.companyId, companyId)
      );

      const activeUsers = await db
        .select()
        .from(userPresence)
        .where(scope)
        .orderBy(desc(userPresence.lastSeen));

      res.json(activeUsers);
    } catch (error: unknown) {
      logger.error("[Presence] Error fetching active users:", { error: getErrorMessage(error) });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PATCH: Update user presence (heartbeat / route change). The request returns
  // immediately; writes remain best-effort. Route changes publish a tenant-
  // scoped invalidation and activity retention is handled by the scheduler.
  app.patch("/api/user-presence", requireAuth, async (req, res) => {
    const parseResult = updatePresenceSchema.safeParse(req.body);
    if (!parseResult.success) {
      return res.status(400).json({ message: "Invalid request body" });
    }

    const { route, type } = parseResult.data;
    const sessionId = req.sessionID;
    const userId = req.user!.id;
    const username = req.user!.username;
    const companyId = sessionCompanyId(req);
    const sessionCompanyName = req.session.currentCompanyName || null;
    const role = req.session.currentRole || null;

    res.status(204).end();

    void (async () => {
      let companyName = sessionCompanyName as string | null;
      if (!companyName && companyId) {
        const [companyRow] = await db
          .select({ name: companies.name })
          .from(companies)
          .where(eq(companies.id, companyId))
          .limit(1);
        companyName = companyRow?.name ?? null;

        if (companyName) {
          req.session.currentCompanyName = companyName;
          req.session.save((error) => {
            if (error) {
              logger.warn("[Presence] Could not persist repaired company name in session.", {
                error: getErrorMessage(error),
                userId,
                companyId,
              });
            }
          });
        }
      }

      await db
        .insert(userPresence)
        .values({
          sessionId,
          userId,
          username,
          currentRoute: route,
          companyId,
          companyName,
          role,
          lastSeen: sql`now()`,
        })
        .onConflictDoUpdate({
          target: userPresence.sessionId,
          set: {
            currentRoute: route,
            companyId,
            companyName,
            role,
            lastSeen: sql`now()`,
          },
        });

      if (type === "route_change") {
        await db.insert(userActivityLog).values({
          userId,
          username,
          companyId,
          companyName,
          route,
        });
        broadcastPresenceChange(companyId);
      }
    })().catch((error: unknown) => {
      logger.error("[Presence] Heartbeat processing error:", { error: getErrorMessage(error) });
    });
  });

  // GET: Fetch a single user's current presence for the Watch panel. The same
  // tenant gate as frame access applies, so Admin/Owner/Manager can see history
  // only for users active in their selected company; Developer keeps support
  // access across companies.
  app.get("/api/user-presence/:userId", requireAuth, async (req, res) => {
    try {
      const access = await authorizePresenceDetail(req, res, req.params.userId);
      if (!access) return;

      const threeMinutesAgo = new Date(Date.now() - 3 * 60 * 1000);
      const whereClause =
        access.role === "Developer"
          ? and(eq(userPresence.userId, req.params.userId), gt(userPresence.lastSeen, threeMinutesAgo))
          : and(
              eq(userPresence.userId, req.params.userId),
              eq(userPresence.companyId, access.companyId),
              gt(userPresence.lastSeen, threeMinutesAgo)
            );

      const rows = await db
        .select()
        .from(userPresence)
        .where(whereClause)
        .orderBy(desc(userPresence.lastSeen))
        .limit(1);
      if (!rows[0]) return res.json(null);

      res.json({
        ...rows[0],
        lastSeen: rows[0].lastSeen instanceof Date ? rows[0].lastSeen.toISOString() : String(rows[0].lastSeen),
      });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // GET: Fetch navigation activity history for a user. Non-developer support
  // roles are restricted to the selected company, matching the frame route.
  app.get("/api/user-presence/:userId/activity", requireAuth, async (req, res) => {
    try {
      const access = await authorizePresenceDetail(req, res, req.params.userId);
      if (!access) return;

      const whereClause =
        access.role === "Developer"
          ? eq(userActivityLog.userId, req.params.userId)
          : and(
              eq(userActivityLog.userId, req.params.userId),
              eq(userActivityLog.companyId, access.companyId)
            );

      const rows = await db
        .select()
        .from(userActivityLog)
        .where(whereClause)
        .orderBy(desc(userActivityLog.occurredAt))
        .limit(50);

      res.json(
        rows.map((row) => ({
          ...row,
          occurredAt:
            row.occurredAt instanceof Date ? row.occurredAt.toISOString() : String(row.occurredAt),
        }))
      );
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // DELETE: Clear user presence on logout — fire-and-forget, never 500.
  app.delete("/api/user-presence", requireAuth, async (req, res) => {
    const sessionId = req.sessionID;
    const companyId = sessionCompanyId(req);
    res.status(204).end();
    if (sessionId) {
      db.delete(userPresence)
        .where(eq(userPresence.sessionId, sessionId))
        .then(() => broadcastPresenceChange(companyId))
        .catch((err: unknown) => logger.error("[Presence] Delete error:", { error: getErrorMessage(err) }));
    }
  });

  // POST: Handle sendBeacon leave (no auth — session may already be ending).
  app.post("/api/user-presence/leave", async (req, res) => {
    const sessionId = req.sessionID;
    const companyId = sessionCompanyId(req);
    res.status(204).end();
    if (sessionId) {
      db.delete(userPresence)
        .where(eq(userPresence.sessionId, sessionId))
        .then(() => broadcastPresenceChange(companyId))
        .catch((err: unknown) => logger.error("[Presence] Leave delete error:", { error: getErrorMessage(err) }));
    }
  });
}

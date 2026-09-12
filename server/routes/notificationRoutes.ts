import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { db } from "../db";
import { requireAuth } from "../auth";
import { notifications, notificationRules, users, companies } from "@shared/schema";
import { eq, and, desc, sql, inArray } from "drizzle-orm";
import { NOTIFICATION_EVENT_TYPES } from "../lib/notificationService";

const ALLOWED_ROLES = ["Developer", "Admin"];

export function registerNotificationRoutes(app: Express) {
  // GET /api/notifications — current user's notifications for the active company, enriched with triggered-by username
  app.get(
    "/api/notifications",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const userId = req.session?.userId;
        const companyId = req.session?.currentCompanyId;
        if (!userId) return res.status(401).json({ message: "Not authenticated" });

        const unreadOnly = req.query.unread === "true";
        const typeFilter = req.query.type as string | undefined;
        const limit = Math.min(parseInt((req.query.limit as string) || "60"), 100);

        const conditions = [eq(notifications.recipientUserId, userId)];
        // Scope to the currently-selected company
        if (companyId) conditions.push(eq(notifications.companyId, companyId));
        if (unreadOnly) conditions.push(eq(notifications.isRead, false));
        if (typeFilter && typeFilter !== "all") {
          if (typeFilter === "loading") {
            conditions.push(sql`${notifications.eventType} IN ('LOADING_STARTED','LOADING_FINALIZED')`);
          } else if (typeFilter === "invoice") {
            conditions.push(sql`${notifications.eventType} IN ('INVOICE_PENDING','INVOICE_FINALIZED')`);
          } else if (typeFilter === "intercompany") {
            conditions.push(eq(notifications.eventType, "INTERCOMPANY_REQUEST"));
          }
        }

        const rows = await db
          .select()
          .from(notifications)
          .where(and(...conditions))
          .orderBy(desc(notifications.createdAt))
          .limit(limit);

        // Enrich with triggeredBy username
        const triggerUserIds = [...new Set(rows.map((r) => r.triggeredByUserId).filter(Boolean))] as string[];
        const triggerUsers =
          triggerUserIds.length > 0
            ? await db
                .select({ id: users.id, username: users.username })
                .from(users)
                .where(inArray(users.id, triggerUserIds))
            : [];
        const userMap = Object.fromEntries(triggerUsers.map((u) => [u.id, u.username]));

        // Enrich with company name
        const companyIds = [...new Set(rows.map((r) => r.companyId).filter((id): id is number => id !== null))];
        const companyRows =
          companyIds.length > 0
            ? await db
                .select({ id: companies.id, name: companies.name })
                .from(companies)
                .where(inArray(companies.id, companyIds))
            : [];
        const companyMap = Object.fromEntries(companyRows.map((c) => [c.id, c.name]));

        const enriched = rows.map((n) => ({
          ...n,
          triggeredByUsername: n.triggeredByUserId ? (userMap[n.triggeredByUserId] ?? null) : null,
          companyName: n.companyId ? (companyMap[n.companyId] ?? null) : null,
        }));

        res.json(enriched);
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // GET /api/notifications/unread-count
  app.get(
    "/api/notifications/unread-count",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const userId = req.session?.userId;
        const companyId = req.session?.currentCompanyId;
        if (!userId) return res.json({ count: 0 });
        const conds = [eq(notifications.recipientUserId, userId), eq(notifications.isRead, false)];
        if (companyId) conds.push(eq(notifications.companyId, companyId));
        const [row] = await db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(notifications)
          .where(and(...conds));
        res.json({ count: row?.count ?? 0 });
      } catch {
        res.json({ count: 0 });
      }
    }
  );

  // POST /api/notifications/:id/read
  app.post(
    "/api/notifications/:id/read",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const userId = req.session?.userId;
        const id = parseInt(req.params.id);
        if (!userId || isNaN(id)) return res.status(400).json({ message: "Invalid request" });
        await db
          .update(notifications)
          .set({ isRead: true, readAt: new Date() })
          .where(and(eq(notifications.id, id), eq(notifications.recipientUserId, userId)));
        res.json({ ok: true });
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // POST /api/notifications/read-all
  app.post(
    "/api/notifications/read-all",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const userId = req.session?.userId;
        const companyId = req.session?.currentCompanyId;
        if (!userId) return res.status(401).json({ message: "Not authenticated" });
        const conds = [eq(notifications.recipientUserId, userId), eq(notifications.isRead, false)];
        if (companyId) conds.push(eq(notifications.companyId, companyId));
        await db
          .update(notifications)
          .set({ isRead: true, readAt: new Date() })
          .where(and(...conds));
        res.json({ ok: true });
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // GET /api/notification-rules — admin/dev only
  app.get(
    "/api/notification-rules",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const role = req.session?.currentRole;
        if (!ALLOWED_ROLES.includes(role ?? "")) {
          return res.status(403).json({ message: "Forbidden" });
        }
        const rules = await db.select().from(notificationRules).orderBy(notificationRules.eventType);
        res.json(rules);
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // PUT /api/notification-rules — admin/dev only; replaces all rules for given eventType
  app.put(
    "/api/notification-rules",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const role = req.session?.currentRole;
        if (!ALLOWED_ROLES.includes(role ?? "")) {
          return res.status(403).json({ message: "Forbidden" });
        }
        const { eventType, recipientUserIds } = req.body;
        if (!eventType || !Array.isArray(recipientUserIds)) {
          return res.status(400).json({ message: "eventType and recipientUserIds[] are required" });
        }
        if (!Object.values(NOTIFICATION_EVENT_TYPES).includes(eventType)) {
          return res.status(400).json({ message: "Invalid eventType" });
        }

        // Replace rules for this event type
        await db.delete(notificationRules).where(eq(notificationRules.eventType, eventType));
        if (recipientUserIds.length > 0) {
          await db.insert(notificationRules).values(
            recipientUserIds.map((uid: string) => ({
              eventType,
              recipientUserId: uid,
              isEnabled: true,
            }))
          );
        }
        const updated = await db.select().from(notificationRules).where(eq(notificationRules.eventType, eventType));
        res.json(updated);
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );

  // GET /api/notification-users — users list for recipient picker (admin/dev only)
  app.get(
    "/api/notification-users",
    requireAuth,
    async (req: import("express").Request, res: import("express").Response) => {
      try {
        const role = req.session?.currentRole;
        if (!ALLOWED_ROLES.includes(role ?? "")) {
          return res.status(403).json({ message: "Forbidden" });
        }
        const allUsers = await db
          .select({ id: users.id, username: users.username })
          .from(users)
          .where(
            and(
              eq(users.active, true),
              sql`${users.id} NOT IN (SELECT DISTINCT user_id FROM user_company_roles WHERE role = 'Developer')`
            )
          )
          .orderBy(users.username);
        res.json(allUsers);
      } catch (err: unknown) {
        res.status(500).json({ message: getErrorMessage(err) });
      }
    }
  );
}

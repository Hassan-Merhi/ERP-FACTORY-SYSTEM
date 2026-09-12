import type { Express } from "express";

import { auditLog, users } from "@shared/schema";
import { and, desc, eq, gte, sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getLogAlertConfiguration } from "../../lib/logAlertDispatcher";
import { getLoggerConfiguration } from "../../lib/logger";
import { requireExportAccess } from "../../lib/permissionMiddleware";
import { getOperationalEventSnapshot } from "../../lib/operationalEvents";
import { resolveActiveCompanyId } from "../helpers/resolveActiveCompanyId";

const WINDOW_DAYS = 30;

function startOfWindow(): Date {
  const date = new Date();
  date.setDate(date.getDate() - WINDOW_DAYS);
  return date;
}

export function registerActivityOverviewRoutes(app: Express) {
  app.get(
    "/api/audit-log/overview",
    requireAuth,
    requireExportAccess("exp_audit_log"),
    async (req, res) => {
      const companyId = resolveActiveCompanyId(req);
      if (!companyId) {
        res.status(409).json({ message: "Select a company before viewing activity history.", code: "AUDIT_COMPANY_REQUIRED" });
        return;
      }

      const since = startOfWindow();
      const baseCondition = and(eq(auditLog.companyId, companyId), gte(auditLog.createdAt, since));
      const [totals, actions, modules, usersSummary, latest] = await Promise.all([
        db
          .select({ total: sql<number>`count(*)::int`, activeUsers: sql<number>`count(distinct ${auditLog.userId})::int` })
          .from(auditLog)
          .where(baseCondition),
        db
          .select({ action: auditLog.action, count: sql<number>`count(*)::int` })
          .from(auditLog)
          .where(baseCondition)
          .groupBy(auditLog.action)
          .orderBy(desc(sql`count(*)`))
          .limit(12),
        db
          .select({ module: auditLog.tableName, count: sql<number>`count(*)::int` })
          .from(auditLog)
          .where(baseCondition)
          .groupBy(auditLog.tableName)
          .orderBy(desc(sql`count(*)`))
          .limit(12),
        db
          .select({ userId: auditLog.userId, username: users.username, count: sql<number>`count(*)::int` })
          .from(auditLog)
          .leftJoin(users, eq(users.id, auditLog.userId))
          .where(baseCondition)
          .groupBy(auditLog.userId, users.username)
          .orderBy(desc(sql`count(*)`))
          .limit(10),
        db
          .select({
            id: auditLog.id,
            action: auditLog.action,
            module: auditLog.tableName,
            recordIdentifier: auditLog.recordIdentifier,
            createdAt: auditLog.createdAt,
            userId: auditLog.userId,
            username: users.username,
            changes: auditLog.changes,
          })
          .from(auditLog)
          .leftJoin(users, eq(users.id, auditLog.userId))
          .where(baseCondition)
          .orderBy(desc(auditLog.createdAt))
          .limit(10),
      ]);

      res.json({
        companyId,
        windowDays: WINDOW_DAYS,
        total: totals[0]?.total ?? 0,
        activeUsers: totals[0]?.activeUsers ?? 0,
        actions,
        modules,
        users: usersSummary,
        latest,
        diagnostics: {
          logger: getLoggerConfiguration(),
          alerts: getLogAlertConfiguration(),
          operationalEvents: getOperationalEventSnapshot(),
        },
      });
    },
  );
}

import { punctuationInsensitiveSearch } from "../lib/searchNormalization";
import type { Express } from "express";
import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { auditLog } from "@shared/schema";
import { requireAuth } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { requireActionAccess } from "../lib/permissionMiddleware";
import { getSessionCompanyId } from "../lib/requestContext";

const auditPermission = requireActionAccess("remote_support_audit");
const MAX_PAGE_SIZE = 100;

function safeDate(value: unknown, endOfDay = false): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  if (endOfDay) date.setHours(23, 59, 59, 999);
  return date;
}

export function registerRemoteSupportAuditRoutes(app: Express): void {
  app.get("/api/screen-feed/control/audit", requireAuth, auditPermission, async (req, res) => {
    try {
      const companyId = getSessionCompanyId(req);
      const requestedLimit = Number.parseInt(String(req.query.limit ?? "50"), 10);
      const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 50));
      const requestedPage = Number.parseInt(String(req.query.page ?? "1"), 10);
      const page = Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1);
      const from = safeDate(req.query.from);
      const to = safeDate(req.query.to, true);
      const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 120) : "";
      const searchPattern = `%${search.replace(/[%_]/g, "\\      const searchPattern = `%${search.replace(/[%_]/g, "\\$&")}%`;")}%`;
      const conditions = [
        eq(auditLog.companyId, companyId),
        eq(auditLog.tableName, "remote_support_sessions"),
        ...(from ? [gte(auditLog.createdAt, from)] : []),
        ...(to ? [lte(auditLog.createdAt, to)] : []),
        ...(search
          ? [
              or(
                punctuationInsensitiveSearch(auditLog.username, search),
                punctuationInsensitiveSearch(auditLog.action, search),
                punctuationInsensitiveSearch(auditLog.recordIdentifier, search)
              )!,
            ]
          : []),
      ];
      const whereClause = and(...conditions);
      const [logs, countRows] = await Promise.all([
        db
          .select({
            id: auditLog.id,
            userId: auditLog.userId,
            username: auditLog.username,
            companyId: auditLog.companyId,
            action: auditLog.action,
            tableName: auditLog.tableName,
            recordId: auditLog.recordId,
            recordIdentifier: auditLog.recordIdentifier,
            changes: auditLog.changes,
            createdAt: auditLog.createdAt,
          })
          .from(auditLog)
          .where(whereClause)
          .orderBy(desc(auditLog.createdAt))
          .limit(pageSize)
          .offset((page - 1) * pageSize),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLog)
          .where(whereClause),
      ]);
      const total = countRows[0]?.count ?? 0;
      res.setHeader("Cache-Control", "no-store");
      res.json({
        logs,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        knownModules: ["remote_support_sessions"],
      });
    } catch (error) {
      logger.error("[RemoteSupport] failed to fetch permanent audit history", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

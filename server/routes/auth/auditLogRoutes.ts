import { releaseDebtEnglish } from "../../i18n/finalCloseoutEnglish";
import type { Express } from "express";

import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { requireExportAccess } from "../../lib/permissionMiddleware";
import { auditLog, companies, factoryUserProfiles, users } from "@shared/schema";
import { and, desc, eq, gte, ilike, lte, or, sql } from "drizzle-orm";
import { resolveActiveCompanyId } from "../helpers/resolveActiveCompanyId";

const moduleLabels: Record<string, string> = {
  vouchers: "Vouchers",
  voucher_entries: "Journal Entries",
  ledger_accounts: "Accounts",
  customers: "Customers",
  suppliers: "Suppliers",
  stock_items: "Stock Items",
  inventory: "Inventory",
  stock_transfers: "Stock Transfers",
  containers: "Containers",
  factory_containers: "Factory Containers",
  factory_offload_charges: "Post-Offload Charges",
  factory_mix_batches: "Mix Batches",
  factory_mix_batch_sources: "Mix Batch Sources",
  production_raw_stock: "Raw Material Stock",
  bales: "Bales",
  factory_customer_orders: "Factory Customer Orders",
  users: "Users",
  user_company_roles: "Roles & Permissions",
  exchange_rates: "Exchange Rates",
  company_settings: "Company Settings",
  reports: "Reports",
};

const actionLabels: Record<string, string> = {
  create: "Created",
  update: "Updated",
  delete: "Deleted",
  restore: "Restored",
  reverse: "Reversed",
  void: "Voided",
  recalculate: "Recalculated",
  repair: "Repaired",
  import: "Imported",
  export: "Exported",
  send_whatsapp: "Sent to WhatsApp",
  send_email: "Sent by Email",
  approve: "Approved",
  cancel: "Cancelled",
  offload: "Offloaded",
  transfer: "Transferred",
  adjust: "Adjusted",
  login: "Login",
  permission_change: "Permission Changed",
  settings_change: "Settings Changed",
};

function deriveModuleLabel(name: string): string {
  return (
    moduleLabels[name] ||
    name
      .replace(/^(factory_|payroll_|rental_|pos_)/, "")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase()) ||
    "Unknown"
  );
}

function summarizeChanges(changes: unknown): string | null {
  if (!changes || typeof changes !== "object" || Array.isArray(changes)) return null;
  const fields = Object.keys(changes as Record<string, unknown>);
  if (fields.length === 0) return null;
  const labels = fields.slice(0, 3).map((field) =>
    field
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/_/g, " ")
      .replace(/\b\w/g, (character) => character.toUpperCase())
  );
  return `${labels.join(", ")}${fields.length > labels.length ? ` and ${fields.length - labels.length} more` : ""}`;
}

function formatAuditRow(row: { id: number; userId: string; storedUsername: string; companyId: number | null; action: string; tableName: string; recordId: number | null; recordIdentifier: string | null; changes: unknown; createdAt: Date; resolvedUsername: string | null; displayName: string | null; companyName: string | null; companyCode: string | null; }) {
  const { storedUsername, resolvedUsername, displayName, companyName, companyCode, ...rest } = row;
  const actionLower = String(rest.action || "").toLowerCase();
  return {
    ...rest,
    username: resolvedUsername || displayName || storedUsername || "Unknown",
    companyName: companyName || null,
    companyCode: companyCode || null,
    moduleLabel: deriveModuleLabel(rest.tableName),
    actionLabel:
      actionLabels[actionLower] ||
      (rest.action
        ? String(rest.action)
            .replace(/_/g, " ")
            .replace(/\b\w/g, (character) => character.toUpperCase())
        : "Unknown"),
    targetUrl: null as string | null,
  };
}

export function registerAuthAuditLogRoutes(app: Express) {
  app.get("/api/audit-log", requireAuth, requireExportAccess("exp_audit_log"), async (req, res) => {
    try {
      const companyId = resolveActiveCompanyId(req);
      const query = req.query as Record<string, string>;
      const requestedLimit = Number.parseInt(query.limit ?? "50", 10);
      const pageSize = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 50));
      const pageNum = Math.max(1, Number.parseInt(query.page || "1", 10) || 1);
      const offset = query.offset ? Math.max(0, Number.parseInt(query.offset, 10) || 0) : (pageNum - 1) * pageSize;
      const resolvedTable = query.tableName || query.module || "";
      const resolvedFrom = query.dateFrom || query.from || "";
      const resolvedTo = query.dateTo || query.to || "";
      const excludedActions = [
        "create",
        "delete",
        "login",
        "import",
        "export",
        "send_whatsapp",
        "send_email",
        "permission_change",
        "settings_change",
        "approve",
      ];
      const baseConditions = [
        sql`${auditLog.userId} NOT IN (SELECT user_id FROM user_company_roles WHERE role = 'Developer')`,
        sql`${auditLog.tableName} != 'security_events'`,
        sql`lower(${auditLog.action}) NOT IN (${sql.join(
          excludedActions.map((value) => sql`${value}`),
          sql`, `
        )})`,
        ...(companyId ? [eq(auditLog.companyId, companyId)] : []),
      ];
      const filterConditions = [];
      if (resolvedTable) filterConditions.push(eq(auditLog.tableName, resolvedTable));
      if (query.userId) filterConditions.push(eq(auditLog.userId, query.userId));
      if (query.action && query.action !== "all") {
        const values = query.action
          .split(",")
          .map((value) => value.trim().toLowerCase())
          .filter(Boolean);
        if (values.length === 1) filterConditions.push(sql`lower(${auditLog.action}) = ${values[0]}`);
        if (values.length > 1)
          filterConditions.push(
            sql`lower(${auditLog.action}) IN (${sql.join(
              values.map((value) => sql`${value}`),
              sql`, `
            )})`
          );
      }
      if (resolvedFrom) filterConditions.push(gte(auditLog.createdAt, new Date(resolvedFrom)));
      if (resolvedTo) {
        const to = new Date(resolvedTo);
        to.setHours(23, 59, 59, 999);
        filterConditions.push(lte(auditLog.createdAt, to));
      }
      if (query.search?.trim()) {
        const value = `%${query.search.trim()}%`;
        filterConditions.push(
          or(
            ilike(auditLog.recordIdentifier, value),
            ilike(auditLog.username, value),
            ilike(auditLog.tableName, value),
            ilike(auditLog.action, value)
          )!
        );
      }

      const selection = {
        id: auditLog.id,
        userId: auditLog.userId,
        storedUsername: auditLog.username,
        companyId: auditLog.companyId,
        action: auditLog.action,
        tableName: auditLog.tableName,
        recordId: auditLog.recordId,
        recordIdentifier: auditLog.recordIdentifier,
        changes: auditLog.changes,
        createdAt: auditLog.createdAt,
        resolvedUsername: users.username,
        displayName: factoryUserProfiles.displayName,
        companyName: companies.name,
        companyCode: companies.code,
      };

      if (query.detailId) {
        const detailId = Number.parseInt(query.detailId, 10);
        if (!Number.isFinite(detailId))
          return res.status(400).json({ message: releaseDebtEnglish("Invalid audit log id") });
        const [rawDetail] = await db
          .select(selection)
          .from(auditLog)
          .leftJoin(users, eq(users.id, auditLog.userId))
          .leftJoin(
            factoryUserProfiles,
            and(
              eq(factoryUserProfiles.userId, auditLog.userId),
              companyId ? eq(factoryUserProfiles.companyId, companyId) : sql`1 = 0`
            )
          )
          .leftJoin(companies, eq(companies.id, auditLog.companyId))
          .where(and(...baseConditions, eq(auditLog.id, detailId)))
          .limit(1);
        if (!rawDetail) return res.status(404).json({ message: releaseDebtEnglish("Audit log entry not found") });
        return res.json(formatAuditRow(rawDetail));
      }

      const whereClause = and(...baseConditions, ...filterConditions);
      const [rawLogs, countResult, modulesResult] = await Promise.all([
        db
          .select(selection)
          .from(auditLog)
          .leftJoin(users, eq(users.id, auditLog.userId))
          .leftJoin(
            factoryUserProfiles,
            and(
              eq(factoryUserProfiles.userId, auditLog.userId),
              companyId ? eq(factoryUserProfiles.companyId, companyId) : sql`1 = 0`
            )
          )
          .leftJoin(companies, eq(companies.id, auditLog.companyId))
          .where(whereClause)
          .orderBy(desc(auditLog.createdAt))
          .limit(pageSize)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLog)
          .where(whereClause),
        db
          .selectDistinct({ tableName: auditLog.tableName })
          .from(auditLog)
          .where(and(...baseConditions))
          .orderBy(auditLog.tableName),
      ]);
      const summaryProfile = query.profile === "summary";
      const logs = rawLogs.map((raw) => {
        const formatted = formatAuditRow(raw);
        if (!summaryProfile) return formatted;
        const { changes, ...summary } = formatted;
        return { ...summary, changeSummary: summarizeChanges(changes) };
      });
      const total = countResult[0]?.count ?? 0;
      res.set("Cache-Control", "private, max-age=15");
      res.json({
        logs,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        total,
        knownModules: modulesResult.map((row) => row.tableName).filter(Boolean),
      });
    } catch (error: unknown) {
      logger.error("Error fetching audit logs:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

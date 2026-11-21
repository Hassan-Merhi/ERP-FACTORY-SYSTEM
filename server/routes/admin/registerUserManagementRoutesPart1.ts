// Extracted from ./registerUserManagementRoutes.ts
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import { logAudit } from "../_helpers";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { sessionRetirementActor } from "../../services/accounting/voucherRetirement";
import {
  LegacyEmployeeAccountRefusal,
  migrateLegacyEmployeeAccountTx,
} from "../../services/accounting/legacyEmployeeAccountMigration";
import { ledgerAccounts, userCompanyRoles } from "@shared/schema";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";

export function registerUserManagementRoutesPart1(app: Express) {
  // Legacy EMP-* ledger accounts onto the employee (phase 19 A, G2): one
  // transaction per request, the company's employee by code, lines in a closed
  // period refused, one audit row per account in the transaction, Admin/Owner.
  // See services/accounting/legacyEmployeeAccountMigration.ts.
  app.post(
    "/api/admin/migrate-employee-account/:accountId",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) {
          return res.status(400).json({ message: "No company selected" });
        }
        const accountId = parseInt(req.params.accountId);
        if (isNaN(accountId)) {
          return res.status(400).json({ message: "Invalid account ID" });
        }
        const actor = sessionRetirementActor(req);
        const result = await db.transaction((tx) =>
          migrateLegacyEmployeeAccountTx(tx, { companyId, accountId, actor })
        );
        res.json({
          message: `Migrated ${result.migratedEntries} voucher entries from ${result.accountCode} to employee ${result.employeeCode}`,
          ...result,
        });
      } catch (error: unknown) {
        if (error instanceof LegacyEmployeeAccountRefusal) {
          return res.status(error.status).json({ code: error.code, message: error.message, vouchers: error.vouchers });
        }
        const closed = closedPeriodErrorResponse(error);
        if (closed) return res.status(closed.status).json(closed.body);
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Every live EMP-* account of the current company, in one transaction. An
  // account the migration refuses is listed as skipped with the reason and
  // left as it was. (It was POST /api/admin/cleanup-legacy-employee-accounts;
  // the path no longer carries the maintenance keyword, so the Owner passes
  // privilegedMaintenanceRoutePolicy.)
  app.post(
    "/api/admin/legacy-employee-accounts/migrate-all",
    requireAuth,
    requireRole("Admin", "Owner"),
    async (req, res) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) {
          return res.status(400).json({ message: "No company selected" });
        }
        const actor = sessionRetirementActor(req);
        const results = await db.transaction(async (tx) => {
          const empAccounts = await tx
            .select({ id: ledgerAccounts.id, code: ledgerAccounts.code })
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, companyId),
                like(ledgerAccounts.code, "EMP-%"),
                isNull(ledgerAccounts.deletedAt)
              )
            )
            .orderBy(ledgerAccounts.id);
          const rows: Array<{
            accountCode: string;
            accountId: number;
            employeeCode: string;
            migratedEntries: number;
            status: "migrated" | "deleted" | "skipped";
            code?: string;
            message: string;
          }> = [];
          for (const account of empAccounts) {
            const employeeCode = account.code.slice("EMP-".length);
            try {
              const result = await migrateLegacyEmployeeAccountTx(tx, { companyId, accountId: account.id, actor });
              rows.push({
                accountCode: account.code,
                accountId: account.id,
                employeeCode,
                migratedEntries: result.migratedEntries,
                status: result.migratedEntries > 0 ? "migrated" : "deleted",
                message:
                  result.migratedEntries > 0
                    ? `Migrated ${result.migratedEntries} entries to employee ${employeeCode}`
                    : "Account had no entries, soft-deleted",
              });
            } catch (error: unknown) {
              // Every refusal is raised before the account or its lines change.
              if (!(error instanceof LegacyEmployeeAccountRefusal)) throw error;
              rows.push({
                accountCode: account.code,
                accountId: account.id,
                employeeCode,
                migratedEntries: 0,
                status: "skipped",
                code: error.code,
                message: error.message,
              });
            }
          }
          return rows;
        });

        const migrated = results.filter((r) => r.status === "migrated").length;
        const deleted = results.filter((r) => r.status === "deleted").length;
        const skipped = results.filter((r) => r.status === "skipped").length;
        res.json({
          message: `Cleanup complete: ${migrated} migrated, ${deleted} deleted, ${skipped} skipped`,
          results,
          summary: { migrated, deleted, skipped, total: results.length },
        });
      } catch (error: unknown) {
        const closed = closedPeriodErrorResponse(error);
        if (closed) return res.status(closed.status).json(closed.body);
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Recalculate Opening Balance Equity adjustment
  // Self-sufficient: computes rawBalance server-side so no body params are needed.

  app.get("/api/settings/role-permissions", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      // Allow Developer/Admin to query any company via ?companyId=N; others use session
      let companyId = req.session.currentCompanyId;
      if ((req.user?.role === "Developer" || req.user?.role === "Admin") && req.query.companyId) {
        companyId = parseInt(req.query.companyId as string);
      }
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const permissions = await storage.getRoleFeaturePermissions(companyId);
      res.json(permissions);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Update role permissions (bulk upsert)
  app.put("/api/settings/role-permissions", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { permissions } = req.body;
      if (!Array.isArray(permissions)) {
        return res.status(400).json({ message: "permissions must be an array" });
      }

      // Add companyId to each permission
      const permissionsWithCompany = permissions.map((p) => ({
        ...p,
        companyId,
      }));

      // Phase 21 (B): the upserts and one audit row per change commit together.
      const results = await db.transaction(async (tx) => {
        const upserted = await storage.bulkUpsertRoleFeaturePermissions(permissionsWithCompany, tx);
        for (const p of permissions) {
          await logAudit(
            {
              userId: req.user!.id,
              username: req.session.username || "unknown",
              companyId,
              action: "update",
              tableName: "role_feature_permissions",
              recordId: null,
              recordIdentifier: `role:${p.role} feature:${p.featureKey} enabled:${p.enabled}`,
              changes: { enabled: { old: !p.enabled, new: p.enabled } },
            },
            tx
          );
        }
        return upserted;
      });

      // Session invalidation: force affected users to re-login so new permissions take effect
      try {
        const affectedRoles = [...new Set(permissions.map((p) => p.role as string))];
        const affectedUsers = await db
          .select({ userId: userCompanyRoles.userId })
          .from(userCompanyRoles)
          .where(and(eq(userCompanyRoles.companyId, companyId), inArray(userCompanyRoles.role, affectedRoles)));
        for (const u of affectedUsers) {
          await db.execute(sql`DELETE FROM session WHERE sess::jsonb ->> 'userId' = ${u.userId}`);
        }
      } catch {
        // Non-fatal — session table may not exist in all environments
      }

      res.json({ message: "Permissions updated successfully", permissions: results });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get permissions for the current user's role (used by sidebar)
  app.get("/api/my-permissions", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const role = req.session.currentRole;

      if (!companyId || !role) {
        return res.status(400).json({ message: "No company or role selected" });
      }

      // Get all permissions for this company and role
      const allPermissions = await storage.getRoleFeaturePermissions(companyId);
      const rolePermissions = allPermissions.filter((p) => p.role === role);

      res.json(rolePermissions);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

// Extracted from ./userManagementRoutes.ts to keep that module under the source-size cap.
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import { logAudit } from "../_helpers";
import { closedPeriodErrorResponse } from "../../lib/closedPeriodError";
import { sessionRetirementActor } from "../../services/accounting/voucherRetirement";
import { effectiveErpPageKeys } from "../../services/security/erpViewerPagePolicy";
import { parseErpHiddenCostFields, parseErpPageGrantKeys } from "@shared/erpPageGrantInput";
import {
  LegacyEmployeeAccountRefusal,
  migrateLegacyEmployeeAccountTx,
} from "../../services/accounting/legacyEmployeeAccountMigration";
import {
  erpUserPageAccess,
  FEATURE_KEYS,
  ledgerAccounts,
  userCompanyRoles,
  users,
  voucherEntries,
} from "@shared/schema";
import { and, eq, inArray, isNull, like, sql } from "drizzle-orm";

export function registerUserManagementRoutes(app: Express) {
  app.get("/api/admin/legacy-employee-accounts", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Find all EMP-* ledger accounts (both active and soft-deleted)
      const allAccounts = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.companyId, companyId), like(ledgerAccounts.code, "EMP-%")));

      // For each account, get usage count in voucher entries
      const accountsWithUsage = await Promise.all(
        allAccounts.map(async (account) => {
          const entries = await db
            .select({ count: sql<number>`count(*)` })
            .from(voucherEntries)
            .where(eq(voucherEntries.ledgerAccountId, account.id));

          const usageCount = entries[0]?.count || 0;

          // Extract employee code from EMP-{code}
          const employeeCode = account.code.replace("EMP-", "");

          // Try to find matching employee in the same company
          const employee = await storage.getEmployeeByCode(employeeCode);
          const employeeInSameCompany = employee && employee.companyId === companyId ? employee : null;

          return {
            id: account.id,
            code: account.code,
            name: account.name,
            accountType: account.accountType,
            isDeleted: !!account.deletedAt,
            deletedAt: account.deletedAt,
            usageCount,
            employeeCode,
            employeeId: employeeInSameCompany?.id || null,
            employeeName: employeeInSameCompany
              ? `${employeeInSameCompany.firstName} ${employeeInSameCompany.lastName}`
              : null,
            canMigrate: !!employeeInSameCompany && usageCount > 0,
            canDelete: usageCount === 0,
          };
        })
      );

      res.json({
        accounts: accountsWithUsage,
        totalCount: accountsWithUsage.length,
        activeCount: accountsWithUsage.filter((a) => !a.isDeleted).length,
        withEntriesCount: accountsWithUsage.filter((a) => a.usageCount > 0).length,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

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

  // ==========================================
  // Test Data Import API (for testing Net Profit)
  // ==========================================

  // Create a test data voucher (Journal entry marked as optional with TEST- prefix)

  app.get("/api/erp-user-page-access/:userId", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      // An ERP page assignment is valid only for a member of this company.
      // Do not expose historical orphan grants to another company's admin.
      const [membership] = await db
        .select({ id: userCompanyRoles.id })
        .from(userCompanyRoles)
        .where(and(eq(userCompanyRoles.companyId, companyId), eq(userCompanyRoles.userId, req.params.userId)))
        .limit(1);
      if (!membership) return res.status(404).json({ message: "User is not assigned to this company" });
      const pageKeys = await storage.getErpUserPageAccess(companyId, req.params.userId);
      res.json({ pageKeys });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/erp-user-page-access/:userId", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const pageKeys = parseErpPageGrantKeys(req.body?.pageKeys);
      if (pageKeys === null) {
        return res.status(400).json({ message: "pageKeys must be a unique list of recognized ERP features" });
      }

      // The membership lock, delete and replacement insert must be atomic:
      // a concurrent company-role removal or an insertion failure must never
      // leave a partially updated grant list.
      const assigned = await db.transaction(async (tx) => {
        const [membership] = await tx
          .select({ id: userCompanyRoles.id })
          .from(userCompanyRoles)
          .where(and(eq(userCompanyRoles.companyId, companyId), eq(userCompanyRoles.userId, req.params.userId)))
          .for("update")
          .limit(1);
        if (!membership) return false;

        await tx
          .delete(erpUserPageAccess)
          .where(and(eq(erpUserPageAccess.companyId, companyId), eq(erpUserPageAccess.userId, req.params.userId)));
        if (pageKeys.length > 0) {
          await tx
            .insert(erpUserPageAccess)
            .values(pageKeys.map((pageKey: string) => ({ companyId, userId: req.params.userId, pageKey })));
        }
        return true;
      });

      if (!assigned) return res.status(404).json({ message: "User is not assigned to this company" });
      res.json({ message: "Page access updated", pageKeys });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/erp-user-hidden-costs/:userId", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const [membership] = await db
        .select({ id: userCompanyRoles.id })
        .from(userCompanyRoles)
        .where(and(eq(userCompanyRoles.companyId, companyId), eq(userCompanyRoles.userId, req.params.userId)))
        .limit(1);
      if (!membership) return res.status(404).json({ message: "User is not assigned to this company" });

      const fields = await storage.getErpUserHiddenCostFields(req.params.userId);
      res.json({ hiddenCostFields: fields });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/erp-user-hidden-costs/:userId", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const hiddenCostFields = parseErpHiddenCostFields(req.body?.hiddenCostFields);
      if (hiddenCostFields === null) {
        return res.status(400).json({ message: "hiddenCostFields must contain unique recognized ERP restrictions" });
      }

      const assigned = await db.transaction(async (tx) => {
        const [membership] = await tx
          .select({ id: userCompanyRoles.id })
          .from(userCompanyRoles)
          .where(and(eq(userCompanyRoles.companyId, companyId), eq(userCompanyRoles.userId, req.params.userId)))
          .for("update")
          .limit(1);
        if (!membership) return false;

        const [updated] = await tx
          .update(users)
          .set({ hiddenErpCostFields: hiddenCostFields })
          .where(eq(users.id, req.params.userId))
          .returning({ id: users.id });
        return Boolean(updated);
      });

      if (!assigned) return res.status(404).json({ message: "User is not assigned to this company" });
      res.json({ message: "ERP cost field restrictions updated", hiddenCostFields });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/my-erp-pages", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const role = req.session.currentRole;
      const userId = req.user?.id;
      if (!companyId || !role || !userId) return res.status(400).json({ message: "No company or role selected" });
      const hiddenErpCostFields = await storage.getErpUserHiddenCostFields(userId);
      if (role === "Admin" || role === "Developer") {
        return res.json({ pageKeys: [...FEATURE_KEYS], fullAccess: true, hiddenErpCostFields: [] });
      }
      const pageKeys = await storage.getErpUserPageAccess(companyId, userId);
      // Analytics is part of the Owner role even for existing owners whose
      // per-user page list was saved before this permission was added.
      const effectivePageKeys = effectiveErpPageKeys(role, pageKeys);
      const visiblePageKeys =
        role === "Owner"
          ? [...new Set([...effectivePageKeys, "analytics"])]
          : role === "ERP Tester"
            ? effectivePageKeys.filter((key) => key !== "settings")
            : effectivePageKeys;
      res.json({ pageKeys: visiblePageKeys, fullAccess: false, hiddenErpCostFields });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── File Folders ──────────────────────────────────────────────
}

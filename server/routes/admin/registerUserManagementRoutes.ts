// Extracted from ./userManagementRoutes.ts to keep that module under the source-size cap.
import { getErrorMessage } from "../../lib/httpHandlers";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole } from "../../auth";
import { effectiveErpPageKeys } from "../../services/security/erpViewerPagePolicy";
import { parseErpHiddenCostFields, parseErpPageGrantKeys } from "@shared/erpPageGrantInput";
import {
  erpUserPageAccess,
  FEATURE_KEYS,
  ledgerAccounts,
  userCompanyRoles,
  users,
  voucherEntries,
} from "@shared/schema";
import { and, eq, like, sql } from "drizzle-orm";
import { registerUserManagementRoutesPart1 } from "./registerUserManagementRoutesPart1";

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

  registerUserManagementRoutesPart1(app);

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

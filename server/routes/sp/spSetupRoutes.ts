import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth, requireRole } from "../../auth";
import { eq, and, isNull, asc } from "drizzle-orm";
import { ledgerAccounts, locations, bankAccounts } from "@shared/schema";
import { requireSpCompany, getSpAccount, SP_ACCOUNTS } from "./spHelpers";
import { ensureSpSupplierVoucherSyncTrigger, getSpSupplierVoucherLinkGapCount } from "./spSupplierVoucherSync";
import { loadGoldenCoastAccounts, loadGoldenCoastSettings, loadCompanyAccountNames } from "./spGoldenCoastSetupRoutes";
import { summarizeGoldenCoastAccountSetup } from "../../services/accounting/goldenCoastPhase2Accounts";

// ── Setup ─────────────────────────────────────────────────────────────────

export function registerSpSetupRoutes(app: Express) {
  app.post("/api/sp/setup", requireAuth, requireRole("Admin"), async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const created: string[] = [];
      const existing: string[] = [];
      const liveAccountNames = new Set(
        (
          await db
            .select({ name: ledgerAccounts.name })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)))
        ).map((account) => account.name)
      );

      for (const acct of SP_ACCOUNTS) {
        const found = await getSpAccount(companyId, acct.subType);
        if (!found) {
          const [codeCollision] = await db
            .select({ id: ledgerAccounts.id })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, acct.code)))
            .limit(1);
          const code = codeCollision ? `${acct.code}-${companyId}` : acct.code;
          let name = acct.name;
          if (liveAccountNames.has(name)) {
            name = `${acct.name} (${acct.code})`;
            let suffix = 2;
            while (liveAccountNames.has(name)) {
              name = `${acct.name} (${acct.code}-${suffix})`;
              suffix += 1;
            }
          }
          await db.insert(ledgerAccounts).values({
            companyId,
            code,
            name,
            accountType: acct.accountType,
            subType: acct.subType,
            isHidden: acct.isHidden,
            active: true,
          });
          liveAccountNames.add(name);
          created.push(name);
        } else {
          existing.push(acct.name);
        }
      }

      // Ensure a default location exists for inventory tracking
      const locs = await db
        .select()
        .from(locations)
        .where(and(eq(locations.companyId, companyId), isNull(locations.deletedAt)));
      if (locs.length === 0) {
        await db.insert(locations).values({
          companyId,
          code: "SP-WH-001",
          name: "Main Warehouse",
          active: true,
        });
        created.push("Default location: Main Warehouse");
      }

      // Wave 16 (A): setup installs the link trigger and reports supplier links
      // that differ; it no longer rewrites posted vouchers. They are repaired
      // through the Owner preview/apply (/api/sp/admin/supplier-voucher-links/plan and /apply).
      await ensureSpSupplierVoucherSyncTrigger();
      const supplierVoucherLinkGapCount = await getSpSupplierVoucherLinkGapCount(companyId);

      res.json({
        created,
        existing,
        repairedSupplierVoucherLinks: 0,
        supplierVoucherLinkGapCount,
        requiredAccountCount: SP_ACCOUNTS.length,
        message: created.length > 0 ? "Setup complete" : "Already configured",
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/sp/setup/status", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const accounts = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)))
        .orderBy(asc(ledgerAccounts.code));

      const spAccounts = accounts.filter((a) => a.subType?.startsWith("sp_"));
      const isConfigured = SP_ACCOUNTS.every((sa) => spAccounts.some((a) => a.subType === sa.subType));

      const locs = await db
        .select()
        .from(locations)
        .where(and(eq(locations.companyId, companyId), isNull(locations.deletedAt)));

      const banks = await db.select().from(bankAccounts).where(eq(bankAccounts.companyId, companyId));
      const supplierVoucherLinkGapCount = await getSpSupplierVoucherLinkGapCount(companyId);

      // Golden Coast Phase 2 balance-sheet roles are reported alongside the
      // legacy SP chart so an Admin can verify both from one setup screen.
      const [goldenCoastAccounts, goldenCoastSettings, goldenCoastNames] = await Promise.all([
        loadGoldenCoastAccounts(db, companyId),
        loadGoldenCoastSettings(db, companyId),
        loadCompanyAccountNames(db, companyId),
      ]);
      const goldenCoast = summarizeGoldenCoastAccountSetup({
        companyId,
        accounts: goldenCoastAccounts,
        settings: goldenCoastSettings,
        existingNames: goldenCoastNames,
      });

      res.json({
        isConfigured,
        spAccounts,
        requiredAccountCount: SP_ACCOUNTS.length,
        locations: locs,
        bankAccounts: banks,
        supplierVoucherLinkGapCount,
        goldenCoast,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

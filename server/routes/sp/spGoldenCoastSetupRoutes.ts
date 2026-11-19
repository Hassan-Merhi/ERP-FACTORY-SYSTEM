import type { Express, Request, Response } from "express";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { ledgerAccounts } from "@shared/schema";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { privilegedMutationRateLimit, privilegedReadRateLimit } from "../../middleware/privilegedEndpointSecurity";
import {
  GoldenCoastPhase2SetupError,
  type GoldenCoastSettingsKey,
  planGoldenCoastAccountProvisioning,
  summarizeGoldenCoastAccountSetup,
} from "../../services/accounting/goldenCoastAccounts";
import {
  GoldenCoastPhase13IntercompanyError,
  goldenCoastPhase13IntercompanyDefinitions,
  summarizeGoldenCoastPhase13IntercompanyAccount,
} from "../../services/accounting/goldenCoastIntercompany";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import { requireSpCompany } from "./spHelpers";
import {
  GoldenCoastSetupRouteError,
  applyIntercompanyPlan,
  assertHadiCompanyAuthorized,
  bindGoldenCoastSettings,
  goldenCoastRequestBudget,
  isHadiCompanyAuthorized,
  loadCompanyAccountNames,
  loadGoldenCoastAccounts,
  loadGoldenCoastSettings,
  loadIntercompanyCandidates,
  resolveCompanyPair,
  type DatabaseTransaction,
  type GoldenCoastCompanyPair,
} from "./spGoldenCoastSetupRoutesResolveCompanyPair";

async function phase13StatusWithAuthorizedHadi(tx: DatabaseTransaction, pair: GoldenCoastCompanyPair) {
  const defs = goldenCoastPhase13IntercompanyDefinitions({
    goldenCoastCompanyName: pair.goldenCoastCompanyName,
    hadiCompanyName: pair.hadiCompanyName,
  });

  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
  const goldenCoastRows = await loadIntercompanyCandidates(tx, pair.goldenCoastCompanyId, defs.golden_coast_hadi);
  const goldenCoastAccount = summarizeGoldenCoastPhase13IntercompanyAccount({
    companyId: pair.goldenCoastCompanyId,
    definition: defs.golden_coast_hadi,
    accounts: goldenCoastRows,
  });

  await assertTransactionCompanyScope(tx, pair.hadiCompanyId);
  const hadiRows = await loadIntercompanyCandidates(tx, pair.hadiCompanyId, defs.hadi_golden_coast);
  const hadiAccount = summarizeGoldenCoastPhase13IntercompanyAccount({
    companyId: pair.hadiCompanyId,
    definition: defs.hadi_golden_coast,
    accounts: hadiRows,
  });
  await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);

  const blockers = [goldenCoastAccount, hadiAccount]
    .filter((item) => item.status !== "ok")
    .flatMap((item) => item.issues.map((issue) => `${item.role}: ${issue}`));
  return {
    isConfigured: blockers.length === 0,
    parentCompanyId: pair.hadiCompanyId,
    parentCompanyName: pair.hadiCompanyName,
    parentAuthorized: true,
    goldenCoastAccount,
    hadiAccount,
    blockers,
  };
}

async function phase13Status(req: Request, companyId: number) {
  const pair = await resolveCompanyPair(db, companyId);
  const defs = goldenCoastPhase13IntercompanyDefinitions({
    goldenCoastCompanyName: pair.goldenCoastCompanyName,
    hadiCompanyName: pair.hadiCompanyName,
  });
  const goldenCoastRows = await loadIntercompanyCandidates(db, companyId, defs.golden_coast_hadi);
  const goldenCoastAccount = summarizeGoldenCoastPhase13IntercompanyAccount({
    companyId,
    definition: defs.golden_coast_hadi,
    accounts: goldenCoastRows,
  });

  if (!isHadiCompanyAuthorized(pair)) {
    const blockers = [...goldenCoastAccount.issues];
    blockers.push(
      `Authorize HADI company ${pair.hadiCompanyId} with targetCompanyId=${pair.hadiCompanyId} to verify or repair the reciprocal account.`
    );
    return {
      isConfigured: false,
      parentCompanyId: pair.hadiCompanyId,
      parentCompanyName: pair.hadiCompanyName,
      parentAuthorized: false,
      goldenCoastAccount,
      hadiAccount: null,
      blockers,
    };
  }

  return db.transaction(async (tx) => phase13StatusWithAuthorizedHadi(tx, pair));
}

async function handleGoldenCoastSetup(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const pair = await resolveCompanyPair(db, companyId);
    assertHadiCompanyAuthorized(pair);

    const result = await db.transaction(async (tx) => {
      await assertTransactionCompanyScope(tx, companyId);
      const accounts = await loadGoldenCoastAccounts(tx, companyId);
      const existingNames = await loadCompanyAccountNames(tx, companyId);
      const plan = planGoldenCoastAccountProvisioning({ companyId, accounts, existingNames });

      const created: Array<{ role: string; accountId: number; code: string; name: string }> = [];
      const repaired: Array<{ role: string; accountId: number; fields: string[] }> = [];
      const settingsBindings: Partial<Record<GoldenCoastSettingsKey, number>> = {};

      for (const item of plan.items) {
        if (item.accountId == null) {
          const [clash] = await tx
            .select({ id: ledgerAccounts.id })
            .from(ledgerAccounts)
            .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, item.code)))
            .limit(1);
          const code = clash ? `${item.code}-${item.subType.slice(-6).toUpperCase()}` : item.code;
          const [inserted] = await tx
            .insert(ledgerAccounts)
            .values({
              companyId,
              code,
              name: item.name,
              accountType: item.accountType,
              subType: item.subType,
              openingBalanceSide:
                item.role === "fresh_start_equity" || item.role === "hassan_equity" ? "Cr" : undefined,
              isHidden: !item.requiresVisible,
              active: true,
            })
            .returning({ id: ledgerAccounts.id, code: ledgerAccounts.code, name: ledgerAccounts.name });
          const accountId = Number(inserted.id);
          created.push({ role: item.role, accountId, code: inserted.code, name: inserted.name });
          if (item.settingsKey) settingsBindings[item.settingsKey] = accountId;
          continue;
        }

        if (item.settingsKey) settingsBindings[item.settingsKey] = item.accountId;
        if (item.repairs.length === 0) continue;
        const patch: Record<string, unknown> = {};
        for (const repair of item.repairs) patch[repair.field] = repair.to;
        await tx
          .update(ledgerAccounts)
          .set(patch)
          .where(and(eq(ledgerAccounts.id, item.accountId), eq(ledgerAccounts.companyId, companyId)));
        repaired.push({
          role: item.role,
          accountId: item.accountId,
          fields: item.repairs.map((repair) => repair.field),
        });
      }

      // Partner equity is credit-normal. Older Golden Coast setup runs left the
      // opening side at the ledger default (Dr), which made a correct profit
      // credit appear to reduce the partner balance in the Accounts screen.
      await tx
        .update(ledgerAccounts)
        .set({ openingBalanceSide: "Cr" })
        .where(
          and(
            eq(ledgerAccounts.companyId, companyId),
            inArray(ledgerAccounts.subType, ["gc_partner_capital", "gc_owner_capital"]),
            eq(ledgerAccounts.accountType, "Equity"),
            isNull(ledgerAccounts.deletedAt)
          )
        );

      const settingsChanged = await bindGoldenCoastSettings(tx, companyId, settingsBindings);
      const defs = goldenCoastPhase13IntercompanyDefinitions({
        goldenCoastCompanyName: pair.goldenCoastCompanyName,
        hadiCompanyName: pair.hadiCompanyName,
      });

      await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);
      const goldenCoastIntercompany = await applyIntercompanyPlan(
        tx,
        pair.goldenCoastCompanyId,
        defs.golden_coast_hadi
      );
      await assertTransactionCompanyScope(tx, pair.hadiCompanyId);
      const hadiIntercompany = await applyIntercompanyPlan(tx, pair.hadiCompanyId, defs.hadi_golden_coast);
      await assertTransactionCompanyScope(tx, pair.goldenCoastCompanyId);

      const finalAccounts = await loadGoldenCoastAccounts(tx, companyId);
      const finalSettings = await loadGoldenCoastSettings(tx, companyId);
      const finalNames = await loadCompanyAccountNames(tx, companyId);
      const status = summarizeGoldenCoastAccountSetup({
        companyId,
        accounts: finalAccounts,
        settings: finalSettings,
        existingNames: finalNames,
      });
      const phase13 = await phase13StatusWithAuthorizedHadi(tx, pair);

      return {
        created,
        repaired,
        settingsChanged,
        warnings: plan.warnings,
        status,
        phase13,
        intercompanyChanges: [goldenCoastIntercompany, hadiIntercompany],
      };
    });

    logger.info("Golden Coast account setup applied", {
      module: "golden-coast-phase13",
      companyId,
      created: result.created.length,
      repaired: result.repaired.length,
      settingsChanged: result.settingsChanged,
      intercompanyChanges: result.intercompanyChanges,
    });

    res.json({
      success: true,
      ...result,
      message:
        result.created.length === 0 &&
        result.repaired.length === 0 &&
        result.settingsChanged.length === 0 &&
        result.intercompanyChanges.every((item) => item.action === "none")
          ? "Golden Coast accounts already configured"
          : "Golden Coast account setup and HADI intercompany repair complete",
    });
  } catch (error: unknown) {
    if (error instanceof GoldenCoastSetupRouteError) {
      res.status(error.status).json({ message: error.message, code: error.code });
      return;
    }
    if (error instanceof GoldenCoastPhase2SetupError) {
      res.status(400).json({ message: error.message, code: "GC_PHASE2_SETUP_INVALID" });
      return;
    }
    if (error instanceof GoldenCoastPhase13IntercompanyError) {
      res.status(409).json({ message: error.message, code: "GC_PHASE13_INTERCOMPANY_INVALID" });
      return;
    }
    logger.error("Golden Coast account setup failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handleGoldenCoastSetupStatus(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;

    const [accounts, settings, existingNames, phase13] = await Promise.all([
      loadGoldenCoastAccounts(db, companyId),
      loadGoldenCoastSettings(db, companyId),
      loadCompanyAccountNames(db, companyId),
      phase13Status(req, companyId),
    ]);

    res.json({
      ...summarizeGoldenCoastAccountSetup({ companyId, accounts, settings, existingNames }),
      phase13,
    });
  } catch (error: unknown) {
    if (error instanceof GoldenCoastSetupRouteError) {
      res.status(error.status).json({ message: error.message, code: error.code });
      return;
    }
    if (error instanceof GoldenCoastPhase2SetupError) {
      res.status(400).json({ message: error.message, code: "GC_PHASE2_SETUP_INVALID" });
      return;
    }
    if (error instanceof GoldenCoastPhase13IntercompanyError) {
      res.status(409).json({ message: error.message, code: "GC_PHASE13_INTERCOMPANY_INVALID" });
      return;
    }
    logger.error("Golden Coast setup status failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerSpGoldenCoastSetupRoutes(app: Express): void {
  app.post(
    "/api/sp/setup/golden-coast",
    privilegedMutationRateLimit,
    goldenCoastRequestBudget,
    requireAuth,
    requireRole("Admin"),
    (req, res) => {
      void handleGoldenCoastSetup(req, res);
    }
  );
  app.get("/api/sp/setup/golden-coast/status", privilegedReadRateLimit, requireAuth, (req, res) => {
    void handleGoldenCoastSetupStatus(req, res);
  });
}

export { loadGoldenCoastAccounts, loadGoldenCoastSettings, loadCompanyAccountNames };

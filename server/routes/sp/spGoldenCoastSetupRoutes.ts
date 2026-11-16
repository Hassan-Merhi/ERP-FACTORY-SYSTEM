import type { Express, Request, Response } from "express";
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import { companies, companySettings, ledgerAccounts } from "@shared/schema";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  privilegedMutationRateLimit,
  privilegedReadRateLimit,
  privilegedRequestBudget,
} from "../../middleware/privilegedEndpointSecurity";
import {
  GOLDEN_COAST_PHASE2_LOOKUP_SUBTYPES,
  GoldenCoastPhase2SetupError,
  type GoldenCoastLedgerRow,
  type GoldenCoastSettingsKey,
  type GoldenCoastSettingsSnapshot,
  planGoldenCoastAccountProvisioning,
  summarizeGoldenCoastAccountSetup,
} from "../../services/accounting/goldenCoastAccounts";
import {
  GoldenCoastPhase13IntercompanyError,
  goldenCoastPhase13IntercompanyDefinitions,
  planGoldenCoastPhase13IntercompanyAccount,
  summarizeGoldenCoastPhase13IntercompanyAccount,
  type GoldenCoastPhase13IntercompanyDefinition,
  type GoldenCoastPhase13LedgerRow,
} from "../../services/accounting/goldenCoastIntercompany";
import { getCompanyRequestRuntimeContext } from "../../services/security/companyRequestRuntimeContext";
import { assertTransactionCompanyScope } from "../../services/security/transactionCompanyScope";
import { requireSpCompany } from "./spHelpers";

// ── Golden Coast account + readiness provisioning ────────────────────────────
// Phase 2 owns the canonical Golden Coast balance-sheet roles. Phase 13 extends
// this same Admin setup action with the reciprocal Golden Coast ↔ HADI
// intercompany accounts needed by Phase 7. No HADI transfer workflow is changed
// here; setup only provisions/repairs the accounts that Phase 7 already expects.

type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type DbLike = DatabaseTransaction | typeof db;

const goldenCoastRequestBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 25 });

interface GoldenCoastCompanyPair {
  goldenCoastCompanyId: number;
  goldenCoastCompanyName: string;
  hadiCompanyId: number;
  hadiCompanyName: string;
}

class GoldenCoastSetupRouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code: string, status: number) {
    super(message);
    this.name = "GoldenCoastSetupRouteError";
    this.code = code;
    this.status = status;
  }
}

/** Loads every Phase 2 role candidate, including inactive/soft-deleted rows. */
async function loadGoldenCoastAccounts(tx: DbLike, companyId: number): Promise<GoldenCoastLedgerRow[]> {
  const rows = await tx
    .select({
      id: ledgerAccounts.id,
      companyId: ledgerAccounts.companyId,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      accountType: ledgerAccounts.accountType,
      subType: ledgerAccounts.subType,
      isHidden: ledgerAccounts.isHidden,
      active: ledgerAccounts.active,
      deletedAt: ledgerAccounts.deletedAt,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        inArray(ledgerAccounts.subType, [...GOLDEN_COAST_PHASE2_LOOKUP_SUBTYPES])
      )
    );

  return rows.map((row) => ({ ...row, id: Number(row.id), companyId: Number(row.companyId) }));
}

/** Every live account name in one company, used to avoid unique-name clashes. */
async function loadCompanyAccountNames(tx: DbLike, companyId: number): Promise<Map<string, number>> {
  const rows = await tx
    .select({ id: ledgerAccounts.id, name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)));
  return new Map(rows.map((row) => [row.name, Number(row.id)]));
}

async function loadGoldenCoastSettings(tx: DbLike, companyId: number): Promise<GoldenCoastSettingsSnapshot> {
  const [row] = await tx
    .select({
      spPosPayableAccountId: companySettings.spPosPayableAccountId,
      spPosProfitAccountId: companySettings.spPosProfitAccountId,
    })
    .from(companySettings)
    .where(eq(companySettings.companyId, companyId))
    .limit(1);
  return row ?? {};
}

async function bindGoldenCoastSettings(
  tx: DatabaseTransaction,
  companyId: number,
  bindings: Partial<Record<GoldenCoastSettingsKey, number>>
): Promise<GoldenCoastSettingsKey[]> {
  const current = await loadGoldenCoastSettings(tx, companyId);
  const changed: GoldenCoastSettingsKey[] = [];
  const updates: Partial<Record<GoldenCoastSettingsKey, number>> = {};

  for (const [key, accountId] of Object.entries(bindings) as Array<[GoldenCoastSettingsKey, number]>) {
    if (Number(current[key] ?? 0) === Number(accountId)) continue;
    updates[key] = accountId;
    changed.push(key);
  }
  if (changed.length === 0) return changed;

  const [existing] = await tx
    .select({ id: companySettings.id })
    .from(companySettings)
    .where(eq(companySettings.companyId, companyId))
    .limit(1);

  if (existing) {
    await tx
      .update(companySettings)
      .set({ ...updates, updatedAt: new Date() })
      .where(eq(companySettings.companyId, companyId));
  } else {
    await tx.insert(companySettings).values({ companyId, ...updates });
  }

  return changed;
}

async function resolveCompanyPair(conn: DbLike, companyId: number): Promise<GoldenCoastCompanyPair> {
  const [goldenCoast] = await conn
    .select({
      id: companies.id,
      name: companies.name,
      parentCompanyId: companies.parentCompanyId,
      active: companies.active,
    })
    .from(companies)
    .where(and(eq(companies.id, companyId), eq(companies.active, true)))
    .limit(1);
  if (!goldenCoast) {
    throw new GoldenCoastSetupRouteError(
      "The selected Golden Coast company is missing or inactive",
      "GC_PHASE13_COMPANY_INVALID",
      409
    );
  }

  const hadiCompanyId = Number(goldenCoast.parentCompanyId ?? 0);
  if (!Number.isInteger(hadiCompanyId) || hadiCompanyId <= 0 || hadiCompanyId === companyId) {
    throw new GoldenCoastSetupRouteError(
      "Golden Coast must have a distinct active parent HADI company configured before intercompany setup can complete",
      "GC_PHASE13_PARENT_COMPANY_INVALID",
      409
    );
  }

  const [hadi] = await conn
    .select({ id: companies.id, name: companies.name })
    .from(companies)
    .where(and(eq(companies.id, hadiCompanyId), eq(companies.active, true)))
    .limit(1);
  if (!hadi) {
    throw new GoldenCoastSetupRouteError(
      "The configured Golden Coast parent HADI company is missing or inactive",
      "GC_PHASE13_PARENT_COMPANY_INVALID",
      409
    );
  }

  return {
    goldenCoastCompanyId: Number(goldenCoast.id),
    goldenCoastCompanyName: String(goldenCoast.name),
    hadiCompanyId: Number(hadi.id),
    hadiCompanyName: String(hadi.name),
  };
}

function isHadiCompanyAuthorized(pair: GoldenCoastCompanyPair): boolean {
  return getCompanyRequestRuntimeContext()?.authorizedCompanyIds?.includes(pair.hadiCompanyId) === true;
}

function assertHadiCompanyAuthorized(pair: GoldenCoastCompanyPair): void {
  if (isHadiCompanyAuthorized(pair)) return;
  throw new GoldenCoastSetupRouteError(
    `HADI company ${pair.hadiCompanyId} is not authorized for this request; send targetCompanyId=${pair.hadiCompanyId} so the tenant boundary verifies membership first`,
    "GC_PHASE13_HADI_SCOPE_UNAUTHORIZED",
    403
  );
}

async function loadIntercompanyCandidates(
  conn: DbLike,
  companyId: number,
  definition: GoldenCoastPhase13IntercompanyDefinition
): Promise<GoldenCoastPhase13LedgerRow[]> {
  const rows = await conn
    .select({
      id: ledgerAccounts.id,
      companyId: ledgerAccounts.companyId,
      code: ledgerAccounts.code,
      name: ledgerAccounts.name,
      accountType: ledgerAccounts.accountType,
      subType: ledgerAccounts.subType,
      isHidden: ledgerAccounts.isHidden,
      active: ledgerAccounts.active,
      deletedAt: ledgerAccounts.deletedAt,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        or(
          eq(ledgerAccounts.subType, definition.subType),
          eq(ledgerAccounts.code, definition.code),
          eq(ledgerAccounts.name, definition.name)
        )
      )
    );
  return rows.map((row) => ({ ...row, id: Number(row.id), companyId: Number(row.companyId) }));
}

async function applyIntercompanyPlan(
  tx: DatabaseTransaction,
  companyId: number,
  definition: GoldenCoastPhase13IntercompanyDefinition
): Promise<{ role: string; action: string; accountId: number; fields: string[] }> {
  const accounts = await loadIntercompanyCandidates(tx, companyId, definition);
  const plan = planGoldenCoastPhase13IntercompanyAccount({ companyId, definition, accounts });

  if (plan.accountId == null) {
    const [codeClash] = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, definition.code)))
      .limit(1);
    const liveNames = await loadCompanyAccountNames(tx, companyId);
    const code = codeClash ? `${definition.code}-${companyId}` : definition.code;
    const name = liveNames.has(definition.name) ? `${definition.name} (${definition.code})` : definition.name;
    const [inserted] = await tx
      .insert(ledgerAccounts)
      .values({
        companyId,
        code,
        name,
        accountType: definition.accountType,
        subType: definition.subType,
        isHidden: false,
        active: true,
      })
      .returning({ id: ledgerAccounts.id });
    return { role: definition.role, action: "create", accountId: Number(inserted.id), fields: [] };
  }

  if (plan.repairs.length > 0) {
    const patch: Record<string, unknown> = {};
    for (const repair of plan.repairs) patch[repair.field] = repair.to;
    await tx
      .update(ledgerAccounts)
      .set(patch)
      .where(and(eq(ledgerAccounts.id, plan.accountId), eq(ledgerAccounts.companyId, companyId)));
  }

  return {
    role: definition.role,
    action: plan.action,
    accountId: plan.accountId,
    fields: plan.repairs.map((repair) => repair.field),
  };
}

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

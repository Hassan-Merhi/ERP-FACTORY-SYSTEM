import type { Express, Request, Response } from "express";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { bankAccounts, ledgerAccounts, voucherEntries, vouchers } from "@shared/schema";
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
  PostingValidationError,
  postBalancedVoucherTx,
  type CentralPostingResult,
} from "../../services/accounting/centralPostingEngine";
import { createDatabasePostingDependencies } from "../../services/accounting/databasePostingDependencies";
import { buildGenericVoucherPostingRequest } from "../../services/accounting/genericVoucherPosting";
import {
  getGoldenCoastAccountDefinition,
  summarizeGoldenCoastAccountSetup,
  type GoldenCoastAccountRole,
  type GoldenCoastLedgerRow,
} from "../../services/accounting/goldenCoastAccounts";
import {
  GOLDEN_COAST_PHASE3_CUTOVER_DATE,
  GoldenCoastPhase3CutoverError,
  buildGoldenCoastPhase3CutoverPlan,
  goldenCoastPhase3VoucherNumber,
  type GoldenCoastPhase3CashAccount,
  type GoldenCoastPhase3RoleAccounts,
} from "../../services/accounting/goldenCoastCutover";
import { requireSpCompany } from "./spHelpers";
import { loadGoldenCoastAccounts, loadGoldenCoastSettings } from "./spGoldenCoastSetupRoutes";
import { goldenCoastExistingPositionCarryForwardVoucherNumber } from "../../services/accounting/goldenCoastCutoverMarkers";

const postingDependencies = createDatabasePostingDependencies();
const phase3RequestBudget = privilegedRequestBudget({ maxBodyBytes: 16 * 1024, maxCollectionItems: 25 });
type DatabaseTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type PersistedPostingResult = CentralPostingResult<typeof vouchers.$inferSelect, typeof voucherEntries.$inferSelect>;

const CUTOVER_ROLES = [
  "fresh_start_equity",
  "hassan_equity",
  "hassan_savings",
  "gc_sales_cash",
  "profit_pending_distribution",
  "stock_otw",
  "stock_in_hand",
  "container_reserve",
] as const satisfies readonly GoldenCoastAccountRole[];

class GoldenCoastPhase3RouteError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(message: string, code = "GC_PHASE3_CUTOVER_INVALID", status = 400) {
    super(message);
    this.name = "GoldenCoastPhase3RouteError";
    this.code = code;
    this.status = status;
  }
}

function businessDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function parseCashAccount(value: unknown): GoldenCoastPhase3CashAccount {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new GoldenCoastPhase3RouteError("cashAccount is required");
  }
  const input = value as Record<string, unknown>;
  if (input.kind !== "ledger" && input.kind !== "bank") {
    throw new GoldenCoastPhase3RouteError('cashAccount.kind must be "ledger" or "bank"');
  }
  const id = Number(input.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new GoldenCoastPhase3RouteError("cashAccount.id must be a positive integer");
  }
  return {
    kind: input.kind,
    id,
    ...(typeof input.name === "string" && input.name.trim() ? { name: input.name.trim() } : {}),
  };
}

function activeCanonicalAccount(
  accounts: readonly GoldenCoastLedgerRow[],
  role: GoldenCoastAccountRole
): GoldenCoastLedgerRow {
  const definition = getGoldenCoastAccountDefinition(role);
  const matches = accounts.filter(
    (account) => account.subType === definition.subType && account.active === true && account.deletedAt == null
  );
  if (matches.length !== 1) {
    throw new GoldenCoastPhase3RouteError(
      matches.length === 0
        ? `Golden Coast Phase 2 role ${role} is missing; run Golden Coast account setup first`
        : `Golden Coast Phase 2 role ${role} is ambiguous (${matches.length} active accounts share ${definition.subType}); repair duplicates before cutover`,
      "GC_PHASE3_PHASE2_NOT_READY",
      409
    );
  }
  return matches[0];
}

function resolveRoleAccounts(accounts: readonly GoldenCoastLedgerRow[]): GoldenCoastPhase3RoleAccounts & {
  profitPendingDistributionAccountId: number;
} {
  return {
    freshStartEquityAccountId: activeCanonicalAccount(accounts, "fresh_start_equity").id,
    hassanEquityAccountId: activeCanonicalAccount(accounts, "hassan_equity").id,
    hassanSavingsAccountId: activeCanonicalAccount(accounts, "hassan_savings").id,
    gcSalesCashAccountId: activeCanonicalAccount(accounts, "gc_sales_cash").id,
    profitPendingDistributionAccountId: activeCanonicalAccount(accounts, "profit_pending_distribution").id,
    stockOtwAccountId: activeCanonicalAccount(accounts, "stock_otw").id,
    stockInHandAccountId: activeCanonicalAccount(accounts, "stock_in_hand").id,
    containerReserveAccountId: activeCanonicalAccount(accounts, "container_reserve").id,
  };
}

async function validateCashAccountTx(
  tx: DatabaseTransaction | typeof db,
  companyId: number,
  account: GoldenCoastPhase3CashAccount
): Promise<void> {
  if (account.kind === "bank") {
    const [row] = await tx
      .select({ id: bankAccounts.id })
      .from(bankAccounts)
      .where(
        and(
          eq(bankAccounts.id, account.id),
          eq(bankAccounts.companyId, companyId),
          eq(bankAccounts.active, true),
          isNull(bankAccounts.deletedAt)
        )
      )
      .limit(1);
    if (!row) {
      throw new GoldenCoastPhase3RouteError("cashAccount must reference an active bank account in this company");
    }
    return;
  }

  const [row] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.id, account.id),
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt),
        inArray(ledgerAccounts.accountType, ["Cash", "Bank"])
      )
    )
    .limit(1);
  if (!row) {
    throw new GoldenCoastPhase3RouteError(
      "cashAccount must reference an active Cash/Bank ledger account in this company"
    );
  }
}

async function existingCutoverVoucherTx(tx: DatabaseTransaction | typeof db, companyId: number) {
  const voucherNumber = goldenCoastPhase3VoucherNumber(companyId);
  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.companyId, companyId), eq(vouchers.voucherNumber, voucherNumber)))
    .limit(1);
  return voucher ?? null;
}

async function existingPositionCarryForwardVoucherTx(tx: DatabaseTransaction | typeof db, companyId: number) {
  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, companyId),
        eq(vouchers.voucherNumber, goldenCoastExistingPositionCarryForwardVoucherNumber(companyId)),
        isNull(vouchers.deletedAt)
      )
    )
    .limit(1);
  return voucher ?? null;
}

async function canonicalPreCutoverBalances(
  tx: DatabaseTransaction | typeof db,
  companyId: number,
  accounts: readonly GoldenCoastLedgerRow[]
): Promise<Array<{ role: GoldenCoastAccountRole; accountId: number; debitMinusCreditUsd: string }>> {
  const resolved = CUTOVER_ROLES.map((role) => ({ role, account: activeCanonicalAccount(accounts, role) }));
  const ids = resolved.map(({ account }) => account.id);

  const openingRows = await tx
    .select({
      id: ledgerAccounts.id,
      openingBalance: ledgerAccounts.openingBalance,
      openingBalanceSide: ledgerAccounts.openingBalanceSide,
    })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), inArray(ledgerAccounts.id, ids)));

  const rows = await tx
    .select({
      ledgerAccountId: voucherEntries.ledgerAccountId,
      debit: sql<string>`COALESCE(SUM(${voucherEntries.debitAmount}), 0)`,
      credit: sql<string>`COALESCE(SUM(${voucherEntries.creditAmount}), 0)`,
    })
    .from(voucherEntries)
    .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
    .where(
      and(
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        inArray(voucherEntries.ledgerAccountId, ids),
        sql`${vouchers.voucherDate} < ${GOLDEN_COAST_PHASE3_CUTOVER_DATE}`
      )
    )
    .groupBy(voucherEntries.ledgerAccountId);

  const openingById = new Map(
    openingRows.map((row) => {
      const absolute = Number(row.openingBalance ?? 0);
      return [Number(row.id), row.openingBalanceSide === "Cr" ? -absolute : absolute] as const;
    })
  );
  const voucherById = new Map(
    rows.map((row) => [Number(row.ledgerAccountId), Number(row.debit ?? 0) - Number(row.credit ?? 0)] as const)
  );

  return resolved.map(({ role, account }) => ({
    role,
    accountId: account.id,
    debitMinusCreditUsd: ((openingById.get(account.id) ?? 0) + (voucherById.get(account.id) ?? 0)).toFixed(2),
  }));
}

async function readiness(tx: DatabaseTransaction | typeof db, companyId: number) {
  const [accounts, settings, existingVoucher, existingPositionCarryForwardVoucher] = await Promise.all([
    loadGoldenCoastAccounts(tx, companyId),
    loadGoldenCoastSettings(tx, companyId),
    existingCutoverVoucherTx(tx, companyId),
    existingPositionCarryForwardVoucherTx(tx, companyId),
  ]);
  const phase2 = summarizeGoldenCoastAccountSetup({ companyId, accounts, settings });
  const blockers: string[] = [];
  let preCutoverBalances: Array<{
    role: GoldenCoastAccountRole;
    accountId: number;
    debitMinusCreditUsd: string;
  }> = [];

  if (!phase2.isConfigured) {
    blockers.push("Golden Coast Phase 2 account setup is not fully configured.");
  } else {
    try {
      resolveRoleAccounts(accounts);
      if (!existingVoucher && !existingPositionCarryForwardVoucher) {
        preCutoverBalances = await canonicalPreCutoverBalances(tx, companyId, accounts);
        const nonZero = preCutoverBalances.filter((item) => Math.abs(Number(item.debitMinusCreditUsd)) > 0.005);
        if (nonZero.length > 0) {
          blockers.push(
            `Canonical cutover accounts already contain pre-${GOLDEN_COAST_PHASE3_CUTOVER_DATE} opening or ledger balances; ` +
              "Phase 3 refuses to layer a fresh opening journal on top of historical balances. Reconcile or migrate those balances first."
          );
        }
      }
    } catch (error) {
      blockers.push(error instanceof Error ? error.message : String(error));
    }
  }

  return {
    cutoverDate: GOLDEN_COAST_PHASE3_CUTOVER_DATE,
    voucherNumber: goldenCoastPhase3VoucherNumber(companyId),
    phase2,
    fundingModel: {
      freshStartContributedInventory: "Excluded from Hassan funding usage",
      cashFundedInventory: "Consumes Hassan funding",
      hassanSavings: "Automatic residual of Hassan's $100,000 opening funding balance",
    },
    preCutoverBalances,
    existingVoucher,
    existingPositionCarryForwardVoucher,
    posted: !!existingVoucher || !!existingPositionCarryForwardVoucher,
    openingMode: existingPositionCarryForwardVoucher
      ? "existing-position-carry-forward"
      : existingVoucher
        ? "standard"
        : null,
    blockers,
    canPreview: phase2.isConfigured,
    canPost: phase2.isConfigured && blockers.length === 0 && !existingVoucher && !existingPositionCarryForwardVoucher,
  };
}

function respondKnownError(res: Response, error: unknown): boolean {
  if (error instanceof GoldenCoastPhase3RouteError) {
    res.status(error.status).json({ message: error.message, code: error.code });
    return true;
  }
  if (error instanceof GoldenCoastPhase3CutoverError) {
    res.status(400).json({ message: error.message, code: "GC_PHASE3_CUTOVER_INVALID" });
    return true;
  }
  if (error instanceof PostingValidationError) {
    res
      .status(error.code === "POSTING_IDEMPOTENCY_CORRUPT" ? 409 : 400)
      .json({ message: error.message, code: error.code });
    return true;
  }
  return false;
}

async function handleStatus(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    res.json(await readiness(db, companyId));
  } catch (error) {
    if (respondKnownError(res, error)) return;
    logger.error("Golden Coast Phase 3 status failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handlePreview(req: Request, res: Response): Promise<void> {
  try {
    const companyId = await requireSpCompany(req, res);
    if (!companyId) return;
    const [accounts, settings] = await Promise.all([
      loadGoldenCoastAccounts(db, companyId),
      loadGoldenCoastSettings(db, companyId),
    ]);
    const phase2 = summarizeGoldenCoastAccountSetup({ companyId, accounts, settings });
    if (!phase2.isConfigured) {
      throw new GoldenCoastPhase3RouteError(
        "Golden Coast Phase 2 account setup must be fully configured before Phase 3 can be previewed",
        "GC_PHASE3_PHASE2_NOT_READY",
        409
      );
    }
    const resolved = resolveRoleAccounts(accounts);
    const cashAccount = parseCashAccount(req.body?.cashAccount);
    await validateCashAccountTx(db, companyId, cashAccount);
    const plan = buildGoldenCoastPhase3CutoverPlan({
      companyId,
      stockOtwUsd: req.body?.stockOtwUsd,
      stockInHandUsd: req.body?.stockInHandUsd,
      containerReserveUsd: req.body?.containerReserveUsd,
      freshStartContributedStockOtwUsd: req.body?.freshStartContributedStockOtwUsd,
      freshStartContributedStockInHandUsd: req.body?.freshStartContributedStockInHandUsd,
      gcSalesCashUsd: req.body?.gcSalesCashUsd,
      hassanSavingsUsd: req.body?.hassanSavingsUsd,
      cashAccount,
      accounts: resolved,
    });
    res.json({ plan, readiness: await readiness(db, companyId) });
  } catch (error) {
    if (respondKnownError(res, error)) return;
    logger.error("Golden Coast Phase 3 preview failed", { error });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

async function handlePost(req: Request, res: Response): Promise<void> {
  const startedAt = Date.now();
  let companyId: number | null = null;
  try {
    companyId = await requireSpCompany(req, res);
    if (!companyId) return;

    const requestDate = businessDate();
    if (requestDate < GOLDEN_COAST_PHASE3_CUTOVER_DATE) {
      throw new GoldenCoastPhase3RouteError(
        `Golden Coast Phase 3 cannot be posted before ${GOLDEN_COAST_PHASE3_CUTOVER_DATE}`,
        "GC_PHASE3_CUTOVER_NOT_OPEN",
        409
      );
    }

    const selectedCompany = companyId;
    const cashAccount = parseCashAccount(req.body?.cashAccount);
    const result = await db.transaction(async (tx) => {
      const state = await readiness(tx, selectedCompany);
      const existingOpeningVoucher = state.existingVoucher ?? state.existingPositionCarryForwardVoucher;
      if (existingOpeningVoucher) {
        const entries = await tx
          .select()
          .from(voucherEntries)
          .where(eq(voucherEntries.voucherId, existingOpeningVoucher.id));
        return {
          posted: { voucher: existingOpeningVoucher, entries, replayed: true } as PersistedPostingResult,
          plan: null,
        };
      }
      if (!state.canPost) {
        throw new GoldenCoastPhase3RouteError(
          state.blockers.join(" ") || "Golden Coast Phase 3 cutover is not ready",
          "GC_PHASE3_CUTOVER_BLOCKED",
          409
        );
      }

      const accounts = await loadGoldenCoastAccounts(tx, selectedCompany);
      const resolved = resolveRoleAccounts(accounts);
      await validateCashAccountTx(tx, selectedCompany, cashAccount);

      const plan = buildGoldenCoastPhase3CutoverPlan({
        companyId: selectedCompany,
        stockOtwUsd: req.body?.stockOtwUsd,
        stockInHandUsd: req.body?.stockInHandUsd,
        containerReserveUsd: req.body?.containerReserveUsd,
        freshStartContributedStockOtwUsd: req.body?.freshStartContributedStockOtwUsd,
        freshStartContributedStockInHandUsd: req.body?.freshStartContributedStockInHandUsd,
        gcSalesCashUsd: req.body?.gcSalesCashUsd,
        hassanSavingsUsd: req.body?.hassanSavingsUsd,
        cashAccount,
        accounts: resolved,
      });
      const built = buildGenericVoucherPostingRequest({
        companyId: selectedCompany,
        clientRequestId: `gc-phase3-cutover:${selectedCompany}:${GOLDEN_COAST_PHASE3_CUTOVER_DATE}`,
        voucher: {
          voucherNumber: plan.voucherNumber,
          voucherType: plan.voucherType,
          voucherDate: plan.cutoverDate,
          description: plan.description,
          currency: "USD",
        },
        entries: plan.entries,
        exchangeRate: null,
        actor: {
          userId: req.session.userId ?? null,
          username: req.session.username || "unknown",
          reason: String(req.body?.reason ?? "Golden Coast Phase 3 opening-balance cutover"),
        },
      });
      const posted = (await postBalancedVoucherTx(tx, built.request, postingDependencies)) as PersistedPostingResult;
      return { posted, plan };
    });

    logger.info("Golden Coast Phase 3 cutover posting succeeded", {
      module: "golden-coast-phase3",
      companyId: selectedCompany,
      voucherId: result.posted.voucher.id,
      replayed: result.posted.replayed,
      durationMs: Date.now() - startedAt,
    });
    res.json({
      success: true,
      cutoverDate: GOLDEN_COAST_PHASE3_CUTOVER_DATE,
      voucher: result.posted.voucher,
      entries: result.posted.entries,
      replayed: result.posted.replayed,
      plan: result.plan,
    });
  } catch (error) {
    if (respondKnownError(res, error)) return;
    logger.error("Golden Coast Phase 3 cutover posting failed", {
      module: "golden-coast-phase3",
      companyId,
      durationMs: Date.now() - startedAt,
      error,
    });
    res.status(500).json({ message: getErrorMessage(error) });
  }
}

export function registerSpGoldenCoastPhase3CutoverRoutes(app: Express): void {
  app.get(
    "/api/sp/golden-coast/phase3/status",
    privilegedReadRateLimit,
    requireAuth,
    requireRole("Admin"),
    (req, res) => {
      void handleStatus(req, res);
    }
  );
  app.post(
    "/api/sp/golden-coast/phase3/preview",
    privilegedReadRateLimit,
    phase3RequestBudget,
    requireAuth,
    requireRole("Admin"),
    (req, res) => {
      void handlePreview(req, res);
    }
  );
  // `cutover` in the path deliberately activates the existing SP sensitive-action
  // guard: exact confirmation "RUN SP MIGRATION", reason >= 5 characters and a
  // unique idempotency key are required before this handler can run.
  app.post(
    "/api/sp/golden-coast/phase3/cutover",
    privilegedMutationRateLimit,
    phase3RequestBudget,
    requireAuth,
    requireRole("Admin"),
    (req, res) => {
      void handlePost(req, res);
    }
  );
}

export { businessDate, canonicalPreCutoverBalances, parseCashAccount, resolveRoleAccounts };

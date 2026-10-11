import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import Decimal from "decimal.js";
import { requireAuth, requireNonPOS } from "../../auth";
import {
  getCashBankAccountSummary,
  getCashBankRevaluation,
  type CashBankCurrencySummary,
} from "../../services/accounting/cashBankRevaluationService";

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** One account line in a net-position side. */
type NetPositionAccountRow = {
  id?: number;
  /** A bank_accounts line (the report's engine bank rows and their translation). */
  bankAccountId?: number;
  name: string;
  code?: string | null;
  value: number;
  category?: string;
  currencyRevalued?: boolean;
  nativeBalancesByCurrency?: unknown;
  historicalBaseBalance?: unknown;
  currentTranslatedBaseBalance?: unknown;
  translationDifference?: unknown;
};

/** One side (for-us / on-us) of the net-position payload. */
type NetPositionSide = {
  accounts: NetPositionAccountRow[];
  total: number;
  breakdown?: Array<{ name: string; value: number }>;
};

type NetPositionEquity = {
  total?: number;
  includedInNetPosition?: boolean;
};

type NetPositionBreakdown = {
  equity?: NetPositionEquity;
} & Record<string, unknown>;

/** The net-position payload this route re-translates in place. */
type NetPositionPayload = {
  forUs?: NetPositionSide;
  onUs?: NetPositionSide;
  forUsTotal?: number;
  onUsTotal?: number;
  netPosition?: number;
  netWorth?: number;
  equity?: NetPositionEquity;
  netPositionBreakdown?: NetPositionBreakdown;
  currency?: Record<string, unknown> & {
    currentCashBankTranslationApplied?: boolean;
  };
  currencyRevaluation?: Record<string, unknown>;
} & Record<string, unknown>;

function rebuildBreakdown(accounts: NetPositionAccountRow[]): Array<{ name: string; value: number }> {
  const totals = new Map<string, number>();
  for (const account of accounts) {
    const category = account.category || "Other";
    totals.set(category, (totals.get(category) || 0) + Number(account.value || 0));
  }
  return [...totals.entries()]
    .map(([name, value]) => ({ name, value: round2(value) }))
    .filter((row) => Math.abs(row.value) >= 0.005)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value));
}

function restoreEquityInclusionContract(payload: NetPositionPayload) {
  const equity = payload.equity;
  if (equity && equity.includedInNetPosition == null) {
    equity.includedInNetPosition = false;
  }

  const breakdownEquity = payload.netPositionBreakdown?.equity;
  if (breakdownEquity && breakdownEquity.includedInNetPosition == null) {
    breakdownEquity.includedInNetPosition = equity?.includedInNetPosition ?? false;
  }

  return payload;
}

function applyCurrentCashTranslation(payload: NetPositionPayload, summaries: CashBankCurrencySummary[]) {
  if (!payload?.forUs || !payload?.onUs) return payload;

  const resolved = summaries.filter((row) => row.currentTranslatedBaseBalance !== null);
  const resolvedLedgerIds = new Set(resolved.filter((row) => row.accountKind === "ledger").map((row) => row.id));
  // The report already lists every bank account at its historical base (engine
  // "bank" rows, carrying bankAccountId): a resolved bank's row is replaced by
  // its current translation below, exactly like a resolved ledger account, so a
  // bank is never listed twice. An unresolved bank keeps its historical row.
  const resolvedBankIds = new Set(resolved.filter((row) => row.accountKind === "bank").map((row) => row.id));
  const isReplaced = (row: NetPositionAccountRow) =>
    (row.bankAccountId != null && resolvedBankIds.has(row.bankAccountId)) ||
    (row.bankAccountId == null && !!row.id && resolvedLedgerIds.has(row.id));

  const oldForUsAccounts = Array.isArray(payload.forUs.accounts) ? payload.forUs.accounts : [];
  const oldOnUsAccounts = Array.isArray(payload.onUs.accounts) ? payload.onUs.accounts : [];
  const removedForUs = oldForUsAccounts.filter(isReplaced);
  const removedOnUs = oldOnUsAccounts.filter(isReplaced);

  const forUsAccounts = oldForUsAccounts.filter((row: NetPositionAccountRow) => !isReplaced(row));
  const onUsAccounts = oldOnUsAccounts.filter((row: NetPositionAccountRow) => !isReplaced(row));

  let forUsTotal = new Decimal(payload.forUs.total ?? payload.forUsTotal ?? 0);
  let onUsTotal = new Decimal(payload.onUs.total ?? payload.onUsTotal ?? 0);
  for (const row of removedForUs) forUsTotal = forUsTotal.minus(row.value || 0);
  for (const row of removedOnUs) onUsTotal = onUsTotal.minus(row.value || 0);

  for (const summary of resolved) {
    const translated = new Decimal(summary.currentTranslatedBaseBalance || 0);
    const accountRow = {
      id: summary.accountKind === "ledger" ? summary.id : undefined,
      bankAccountId: summary.accountKind === "bank" ? summary.id : undefined,
      name: summary.name,
      code: summary.code,
      value: translated.abs().toDecimalPlaces(2).toNumber(),
      category: "Cash / Bank (Current Translation)",
      currencyRevalued: true,
      nativeBalancesByCurrency: summary.nativeBalancesByCurrency,
      historicalBaseBalance: summary.historicalBaseBalance,
      currentTranslatedBaseBalance: summary.currentTranslatedBaseBalance,
      translationDifference: summary.translationDifference,
    };
    if (translated.gte(0)) {
      forUsAccounts.push(accountRow);
      forUsTotal = forUsTotal.plus(translated);
    } else {
      onUsAccounts.push(accountRow);
      onUsTotal = onUsTotal.plus(translated.abs());
    }
  }

  const forUsRounded = round2(forUsTotal.toNumber());
  const onUsRounded = round2(onUsTotal.toNumber());
  const equityContribution =
    payload.equity?.includedInNetPosition === true ? new Decimal(payload.equity.total ?? 0) : new Decimal(0);
  const netPosition = round2(new Decimal(forUsRounded).minus(onUsRounded).plus(equityContribution).toNumber());

  payload.forUs.accounts = forUsAccounts
    .filter((row) => Math.abs(Number(row.value || 0)) >= 0.005)
    .sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
  payload.onUs.accounts = onUsAccounts
    .filter((row) => Math.abs(Number(row.value || 0)) >= 0.005)
    .sort((a, b) => Number(b.value || 0) - Number(a.value || 0));
  payload.forUs.total = forUsRounded;
  payload.onUs.total = onUsRounded;
  payload.forUs.breakdown = rebuildBreakdown(payload.forUs.accounts);
  payload.onUs.breakdown = rebuildBreakdown(payload.onUs.accounts);
  payload.forUsTotal = forUsRounded;
  payload.onUsTotal = onUsRounded;
  payload.netPosition = netPosition;
  payload.netWorth = netPosition;
  payload.netPositionLabel = netPosition >= 0 ? "Net Assets" : "Net Liabilities";
  return payload;
}

/**
 * Registered from statsRoutes only to keep the top-level route registry small.
 * The account URLs deliberately live under /api/accounts so accounting users do
 * not need the separate Analytics-module permission to view cash/bank balances.
 */
export function registerStatsMultiCurrencyRoutes(app: Express) {
  // Register before /api/stats/net-profit. It post-processes the live snapshot so
  // only actual cash/bank accounts are translated at the current rate. Historical
  // or date-filtered snapshots remain based on their stored historical amounts.
  app.use(async (req, res, next) => {
    if (req.method !== "GET" || req.path !== "/api/stats/net-profit" || req.query.toDate) {
      return next();
    }
    const companyId = req.session.currentCompanyId;
    if (!companyId) return next();

    try {
      // Engine attribution (wave 10 part 3): bank aggregates hold only the lines
      // naming the bank and no ledger account, and a linked bank keeps its own
      // row, so the translated rows partition the lines exactly as the report's
      // historical ledger and bank rows do.
      const revaluation = await getCashBankRevaluation(companyId, { attribution: "engine" });
      const resolvedAccounts = revaluation.accounts.filter((row) => row.currentTranslatedBaseBalance !== null);
      const currentTranslatedLedgerAccountIds = resolvedAccounts
        .filter((row) => row.accountKind === "ledger")
        .map((row) => row.id);
      const currentTranslatedBankAccountIds = resolvedAccounts
        .filter((row) => row.accountKind === "bank")
        .map((row) => row.id);
      const currentCashBankTranslationDifference = round2(
        resolvedAccounts.reduce((total, row) => total.plus(row.translationDifference ?? 0), new Decimal(0)).toNumber()
      );
      const originalJson = res.json.bind(res);
      res.json = ((payload) => {
        // The existing report engine caches its object. Clone before adjusting so
        // repeated requests never reapply translation to the cached reference.
        const reportTotalsProvisional = Boolean(payload?.currencyRevaluation?.reportTotalsProvisional);
        const copy = payload == null ? payload : JSON.parse(JSON.stringify(payload));
        const translated = applyCurrentCashTranslation(copy, revaluation.accounts);
        const adjusted = restoreEquityInclusionContract(translated);
        if (adjusted?.currency) adjusted.currency.currentCashBankTranslationApplied = true;
        adjusted.currencyRevaluation = {
          currentCfaPerUsd: revaluation.currentCfaPerUsd,
          unresolvedAccountCount: revaluation.unresolvedAccountCount,
          unresolvedAccounts: revaluation.accounts
            .filter((row) => row.totalsProvisional)
            .map((row) => ({
              accountKind: row.accountKind,
              id: row.id,
              name: row.name,
              openingBalanceCurrencyUnresolved: row.openingBalanceCurrencyUnresolved,
              unresolvedLegacyEntryCount: row.unresolvedLegacyEntryCount,
              currentRateMissing: row.currentRateMissing,
              unresolvedTranslationCurrencies: row.unresolvedTranslationCurrencies,
            })),
          appliedToCurrentSnapshotOnly: true,
          reportTotalsProvisional,
          currentTranslatedLedgerAccountIds,
          currentTranslatedBankAccountIds,
          currentCashBankTranslationDifference,
        };
        return originalJson(adjusted);
      }) as typeof res.json;
    } catch (error) {
      logger.error("Unable to prepare cash-only Net Position translation:", {
        error: error,
      });
    }
    return next();
  });

  app.get("/api/accounts/multi-currency/cash-bank-revaluation", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      return res.json(await getCashBankRevaluation(companyId));
    } catch (error: unknown) {
      logger.error("Multi-currency cash/bank revaluation failed:", {
        error: error,
      });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/accounts/multi-currency/:kind/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const kind = req.params.kind;
      if (kind !== "ledger" && kind !== "bank") {
        return res.status(400).json({ message: "Account kind must be ledger or bank" });
      }
      const accountId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(accountId) || accountId <= 0) {
        return res.status(400).json({ message: "Invalid account ID" });
      }

      const summary = await getCashBankAccountSummary(companyId, kind, accountId);
      if (!summary) return res.status(404).json({ message: "Cash/bank account not found" });
      return res.json(summary);
    } catch (error: unknown) {
      logger.error("Multi-currency account summary failed:", {
        error: error,
      });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

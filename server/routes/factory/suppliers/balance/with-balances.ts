/**
 * supplierBalanceRoutes: SupplierWithBalances endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { requireAuth } from "../../../../auth";
import { toMoney, sumMoney } from "../../../../lib/money";
import type Decimal from "decimal.js";
import { supplierUsdEquivalent } from "./supplierUsdEquivalent";
import { FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL } from "./factorySupplierLedger";
import {
  ZERO,
  addTo,
  handleGetFactorySuppliersWithBalancesStep1,
  type MoneyBucket,
} from "./handleGetFactorySuppliersWithBalancesStep1";
import { handleGetFactorySuppliersWithBalancesStep2 } from "./handleGetFactorySuppliersWithBalancesStep2";
import { handleGetFactorySuppliersWithBalancesStep3 } from "./handleGetFactorySuppliersWithBalancesStep3";

export function registerSupplierWithBalancesRoutes(app: Express) {
  app.get("/api/factory/suppliers/with-balances", requireAuth, async (req: Request, res: Response) => {
    try {
      const step1Result = await handleGetFactorySuppliersWithBalancesStep1(req, res);
      if (step1Result.done) return step1Result.value;
      const {
        allFxTransfers,
        allOffloadAdditionalCharges,
        allPayments,
        companyId,
        configuredFxRates,
        containers,
        includeOtw,
        ledgerExposure,
        ledgerFields,
        settlementBalances,
        suppliersList,
        voucherFxUnresolvedSuppliers,
        voucherPaidBySupplierCurrency,
        voucherPaidBySupplierCurrencyUsd,
      } = step1Result;
      const { computeStats } = handleGetFactorySuppliersWithBalancesStep2({
        allFxTransfers,
        allOffloadAdditionalCharges,
        allPayments,
        configuredFxRates,
        containers,
        voucherFxUnresolvedSuppliers,
        voucherPaidBySupplierCurrency,
        voucherPaidBySupplierCurrencyUsd,
      });
      const { brokerParentIds, brokerStmtMap, statsById } = await handleGetFactorySuppliersWithBalancesStep3({
        companyId,
        computeStats,
        includeOtw,
        suppliersList,
      });
      const { suppliersWithBalances } = handleGetFactorySuppliersWithBalancesStep4({
        brokerParentIds,
        brokerStmtMap,
        configuredFxRates,
        ledgerExposure,
        ledgerFields,
        settlementBalances,
        statsById,
        suppliersList,
      });
      handleGetFactorySuppliersWithBalancesStep5({ suppliersWithBalances }, res);
    } catch (error: unknown) {
      logger.error("Error fetching factory suppliers with balances:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

function handleGetFactorySuppliersWithBalancesStep4({
  brokerParentIds,
  brokerStmtMap,
  configuredFxRates,
  ledgerExposure,
  ledgerFields,
  settlementBalances,
  statsById,
  suppliersList,
}: Pick<
  Extract<Awaited<ReturnType<typeof handleGetFactorySuppliersWithBalancesStep1>>, { done: false }> &
    Awaited<ReturnType<typeof handleGetFactorySuppliersWithBalancesStep3>>,
  | "brokerParentIds"
  | "brokerStmtMap"
  | "configuredFxRates"
  | "ledgerExposure"
  | "ledgerFields"
  | "settlementBalances"
  | "statsById"
  | "suppliersList"
>) {
  // Second pass: for parent suppliers, roll up children's stats
  const suppliersWithBalances = suppliersList.map((s) => {
    const own = statsById[s.id];
    const children = suppliersList.filter((c) => c.parentId === s.id);

    if (!brokerParentIds.has(s.id)) {
      const settlement = settlementBalances.get(s.id);
      const settlementDisplay = settlement
        ? {
            displayBalanceBasis: "settlement-statement" as const,
            usdEquivalentBalance: settlement.usdEquivalentBalance,
            usdEquivalentMissingRates: settlement.usdEquivalentMissingRates,
            settlementBalances: settlement.settlementBalances,
          }
        : {};
      return {
        ...s,
        totalContainers: own.totalContainers,
        totalKg: own.totalKg.toFixed(3),
        totalPaid: own.totalPaid.toFixed(2),
        totalCommissionUsd: own.commissionValue.toFixed(2),
        approxFxRate: own.approxFxRate.gt(0) ? own.approxFxRate.toFixed(4) : null,
        pendingContainers: own.pendingContainers,
        otwByCurrency: own.otwByCurrency,
        receivedContainers: own.receivedContainers,
        lastContainerDate: own.lastContainerDate,
        dueContainers: own.dueContainers,
        dueContainersCount: own.dueContainers.length,
        autoSettledFreightUsd: own.autoSettledFreightUsd.toFixed(2),
        ...ledgerFields(s.id),
        ...settlementDisplay,
        operationalMemo: {
          label: FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL,
          totalValue: own.balance.toFixed(2),
          currencyBalances: own.currencyBalances,
          fxUnresolved: own.fxUnresolved,
        },
      };
    }

    // TRUE BROKER BALANCE MODEL — parent supplier (broker) aggregation:
    // The broker's own balance (totalValue / currencyBalances) reflects ONLY direct broker entries
    // and explicit FX-in transfers. Linked supplier balances are NOT merged into broker-owned totals.
    // They are returned separately as linkedSupplierExposure for informational display.
    const childStats = children.map((c) => statsById[c.id]);
    // Informational aggregates that span all parties (container counts, kg, dates)
    const aggContainers = own.totalContainers + childStats.reduce((n: number, cs) => n + cs.totalContainers, 0);
    const aggKg = own.totalKg.plus(sumMoney(childStats.map((cs) => cs.totalKg)));
    const aggPending = own.pendingContainers + childStats.reduce((n: number, cs) => n + cs.pendingContainers, 0);
    const aggOtwByCurrency: Record<string, number> = { ...own.otwByCurrency };
    for (const cs of childStats) {
      for (const [cc, n] of Object.entries(cs.otwByCurrency || {})) {
        aggOtwByCurrency[cc] = (aggOtwByCurrency[cc] || 0) + (n as number);
      }
    }
    const aggReceived = own.receivedContainers + childStats.reduce((n: number, cs) => n + cs.receivedContainers, 0);
    const allDates = [own.lastContainerDate, ...childStats.map((cs) => cs.lastContainerDate)].filter(
      (d): d is string => typeof d === "string"
    );
    const aggLastDate =
      allDates.length > 0 ? allDates.reduce((latest, d) => (new Date(d) > new Date(latest) ? d : latest)) : null;
    const aggDueContainers = [...own.dueContainers, ...childStats.flatMap((cs) => cs.dueContainers)];

    // Linked supplier exposure: per-child per-currency balances (informational, NOT counted in broker totals)
    const linkedSupplierExposure = children.map((c, i: number) => {
      const childLedger = ledgerFields(c.id);
      return {
        supplierId: c.id,
        supplierName: c.name,
        ledgerBalance: childLedger.ledgerBalance,
        currencyBalances: childLedger.currencyBalances,
        notInLedgerTotal: childLedger.notInLedgerTotal,
        operationalCurrencyBalances: childStats[i].currencyBalances,
        autoSettledFreightUsd: childStats[i].autoSettledFreightUsd.toFixed(2),
      };
    });

    // Aggregate exposure totals for summary display (informational only).
    // Auto-settled cross-currency freight (e.g. USD freight on AUD containers) flows into
    // the broker's own USD pool automatically — exclude it from the linked exposure aggregate
    // so it doesn't appear as an unresolved obligation.
    const exposureCurrencyMap: MoneyBucket = {};
    const exposureFxMap: Record<string, { wSum: Decimal; vSum: Decimal }> = {};
    for (const cs of childStats) {
      for (const cb of cs.currencyBuckets) {
        // For USD balances on a linked supplier, subtract auto-settled freight so the broker
        // card doesn't show it as an open exposure (it's already in the broker pool).
        const effectiveBal = cb.currencyCode === "USD" ? cb.balance.minus(cs.autoSettledFreightUsd) : cb.balance;
        if (effectiveBal.gt(0)) {
          addTo(exposureCurrencyMap, cb.currencyCode, effectiveBal);
          if (cb.currencyCode !== "USD" && cb.fxRateToUsd.gt(0)) {
            const fxEntry = (exposureFxMap[cb.currencyCode] ??= { wSum: ZERO, vSum: ZERO });
            fxEntry.wSum = fxEntry.wSum.plus(effectiveBal.times(cb.fxRateToUsd));
            fxEntry.vSum = fxEntry.vSum.plus(effectiveBal);
          }
        }
      }
    }
    const exposureCurrencyBalances = Object.entries(exposureCurrencyMap)
      .filter(([, bal]) => bal.gt(0.001))
      .map(([currencyCode, bal]) => {
        const fxEntry = exposureFxMap[currencyCode];
        return {
          currencyCode,
          balance: bal,
          fxRateToUsd: fxEntry?.vSum.gt(0) ? fxEntry.wSum.dividedBy(fxEntry.vSum) : toMoney(1),
        };
      })
      .sort((a, _b) => (a.currencyCode === "USD" ? 1 : -1));

    // Use broker-statement KPIs so the list card total matches the detail page.
    // Formula: USD_pool + EUR × configuredRate + AUD × configuredRate = totalValue
    const stmt = brokerStmtMap[s.id];
    let brokerPoolUsd: Decimal = own.balance;
    let finalExposureCurrencyBalances = exposureCurrencyBalances;

    if (stmt) {
      const usdLedger = stmt.currencyLedgers.find((l) => l.currencyCode === "USD");
      // A broker's pool is independent from linked-supplier exposure.
      // Use every currency from the same broker statement, not EUR/AUD only.
      brokerPoolUsd = usdLedger ? toMoney(usdLedger.netBalance) : ZERO;
      finalExposureCurrencyBalances = stmt.currencyLedgers
        .filter((section) => section.currencyCode !== "USD")
        .filter((section) => toMoney(section.netBalance).abs().gt(0.001))
        .map((section) => ({
          currencyCode: section.currencyCode,
          balance: toMoney(section.netBalance),
          fxRateToUsd: toMoney(configuredFxRates[section.currencyCode] ?? 0),
        }));
    }

    const grandTotal = finalExposureCurrencyBalances.reduce(
      (sum, e) => sum.plus(e.currencyCode === "USD" ? e.balance : e.balance.times(e.fxRateToUsd)),
      brokerPoolUsd
    );

    const brokerLedger = ledgerFields(s.id);
    // The broker is a different model: its statement's signed currency pools
    // are authoritative; linked suppliers are NOT added a second time.
    const brokerDisplay = stmt
      ? supplierUsdEquivalent(
          stmt.currencyLedgers.map((section) => ({
            currencyCode: section.currencyCode,
            balance: section.netBalance,
          })),
          configuredFxRates
        )
      : { usdEquivalentBalance: null, usdEquivalentMissingRates: [] as string[] };
    // Exactly the data used by BrokerOverviewPanel's KPI cards. These
    // balances are broker pool/settlement balances, NOT the broker's GL
    // ledger balance or the combined liabilities of linked suppliers.
    // Return each currency separately: EUR overpaid must never silently
    // be folded into a positive USD pool.
    const brokerStatementBalances = stmt
      ? stmt.currencyLedgers
          .map((section) => ({
            currencyCode: section.currencyCode,
            balance: toMoney(section.netBalance).toFixed(2),
            isBrokerPool: section.isBrokerPool,
          }))
          .filter((section) => toMoney(section.balance).abs().gt(0.001))
      : null;
    return {
      ...s,
      totalContainers: aggContainers,
      totalKg: aggKg.toFixed(3),
      // The broker's own ledger balance (true broker model: linked suppliers
      // are not merged in; they are listed in linkedSupplierExposure).
      ...brokerLedger,
      ...brokerDisplay,
      // Keep the posted GL figure in ledgerBalance, but do not present it
      // as the USD broker pool, which is independently computed.
      brokerPoolUsd: stmt ? brokerPoolUsd.toFixed(2) : null,
      brokerStatementBalances,
      totalPaid: own.totalPaid.toFixed(2),
      totalCommissionUsd: own.commissionValue.toFixed(2),
      approxFxRate: own.approxFxRate.gt(0) ? own.approxFxRate.toFixed(4) : null,
      pendingContainers: aggPending,
      otwByCurrency: aggOtwByCurrency,
      receivedContainers: aggReceived,
      lastContainerDate: aggLastDate,
      dueContainers: aggDueContainers,
      dueContainersCount: aggDueContainers.length,
      linkedSupplierExposure,
      // Linked suppliers' ledger balances per currency (what they are owed), informational.
      exposureCurrencyBalances: ledgerExposure(children.map((c) => c.id)),
      fxUnresolved: brokerLedger.fxUnresolved || children.some((c) => ledgerFields(c.id).fxUnresolved),
      operationalMemo: {
        label: FACTORY_SUPPLIER_OPERATIONAL_MEMO_LABEL,
        // Grand total: USD_pool + EUR × rate + AUD × rate (the broker statement's KPI).
        totalValue: grandTotal.toFixed(2),
        brokerPoolUsd: brokerPoolUsd.toFixed(2),
        currencyBalances: own.currencyBalances,
        exposureCurrencyBalances: finalExposureCurrencyBalances.map((e) => ({
          currencyCode: e.currencyCode,
          balance: e.balance.toNumber(),
          fxRateToUsd: e.fxRateToUsd.toNumber(),
        })),
        fxUnresolved: own.fxUnresolved || childStats.some((cs) => cs.fxUnresolved),
      },
    };
  });
  return { suppliersWithBalances };
}

function handleGetFactorySuppliersWithBalancesStep5(
  {
    suppliersWithBalances,
  }: Pick<Awaited<ReturnType<typeof handleGetFactorySuppliersWithBalancesStep4>>, "suppliersWithBalances">,
  res: Response
) {
  res.json(suppliersWithBalances.sort((a, b) => a.name.localeCompare(b.name)));
  return {};
}

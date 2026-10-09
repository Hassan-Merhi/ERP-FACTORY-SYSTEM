/**
 * Perpetual-inventory readiness report (2026-10 accounting audit, wave 15).
 *
 * Read-only. For one company it gathers everything the cut-over checklist of
 * the production report asks for, so the same checks can be run after each
 * deployment, and lists what still blocks the switch:
 *
 *   - stock on locations that no longer exist, and rows with values outside
 *     the valuation policy (the cut-over apply refuses while any is left;
 *     resolved through the readiness resolution);
 *   - factory raw stock, mixes and bales that carry no USD cost, and the open
 *     mixes among them (a mix source with no USD rate);
 *   - stock bales from a stock entry with no mix, costed at the catalogue
 *     production price (wave 17 B, owner decision 2), listed as unvalued;
 *   - finalized factory invoices on or after the cut-over with no ledger
 *     journal;
 *   - legacy factory foreign-currency lines the wave 6 repair has not
 *     converted, and those of them with no rate on or before their date;
 *   - documents already dated on or after the planned cut-over date (the
 *     apply refuses them);
 *   - the opening plan, the cut-over state, the global posting switch and,
 *     once the cut-over is applied, the reconciliation.
 *
 * Every figure is read on one repeatable-read snapshot. Nothing is written.
 * The cut-over apply refuses on the same factory figures
 * (factoryCutoverBlockers.ts, wave 17 B).
 */
import { db } from "../../../db";
import { toMoney } from "../../../lib/money";
import { planFactoryFxLegacyRepair } from "../../factory/factoryFxLegacyRepair";
import { planReadinessResolutionTx } from "../../inventory/inventoryReadinessResolution";
import { assertTransactionCompanyScope } from "../../security/transactionCompanyScope";
import { DEFAULT_PERPETUAL_INVENTORY_FROM, PERPETUAL_INVENTORY_POSTING_READY, getInventoryCutover } from "./cutover";
import { noMixCataloguePricedBales } from "./factoryCutoverBlockers";
import { listUnpostedFactoryInvoices } from "./factoryInvoice";
import { factoryStockValuation } from "./factoryValuation";
import { isSupplierPartnerCompany } from "./linkedJournal";
import {
  documentsOnOrAfterCutover,
  planOpeningInventoryJournal,
  type DocumentsOnOrAfterCutover,
} from "./openingJournal";
import { reconcilePerpetualInventory } from "./reconciliation";
import {
  retailInventoryReconciliationTx,
  type RetailInventoryReconciliation,
} from "../../retail/retailInventoryJournal";

export type ReadinessBlockerCode =
  | "POSTING_NOT_READY"
  | "ORPHANED_LOCATION_STOCK"
  | "ANOMALOUS_VALUES"
  | "UNVALUED_FACTORY_ROWS"
  | "OPEN_MIXES_WITHOUT_USD_RATE"
  | "NO_MIX_BALES_AT_CATALOGUE_PRICE"
  | "UNPOSTED_FACTORY_INVOICES"
  | "LEGACY_FX_LINES_UNREPAIRED"
  | "LEGACY_FX_LINES_WITHOUT_DATED_RATE"
  | "DOCUMENTS_ON_OR_AFTER_CUTOVER"
  | "RECONCILIATION_DIFFERENCE"
  | "RETAIL_INVENTORY_UNRECONCILED";

export interface ReadinessBlocker {
  code: ReadinessBlockerCode;
  count: number;
  /** The value involved, when there is one (2dp text). */
  value: string | null;
  message: string;
}

export interface PerpetualReadinessReport {
  companyId: number;
  generatedAt: string;
  /** The cut-over date the checks are for: the applied one, else the one asked for (default 2026-11-01). */
  effectiveFrom: string;
  postingReady: boolean;
  supplierPartner: boolean;
  cutover: { effectiveFrom: string; openingVoucherId: number | null } | null;
  orphanedStock: { locations: number; rows: number; value: string };
  anomalousValues: { rows: number; value: string };
  unvaluedFactoryRows: { rawStock: number; mixes: number; bales: number };
  openMixesWithoutUsdRate: number;
  /** Stock bales with no mix, costed at the catalogue production price (decision 2): unvalued. */
  noMixCataloguePricedBales: { count: number; cost: string; baleIds: number[] };
  unpostedFactoryInvoices: number;
  legacyFxLines: { unrepaired: number; repairable: number; withoutDatedRate: number };
  documentsOnOrAfterCutover: DocumentsOnOrAfterCutover | null;
  openingPlan: { lines: number; total: string; unvalued: number } | null;
  reconciliation: { reconciled: boolean; differences: number } | null;
  /** Wave 17 (D): RETAIL-INVENTORY against the Retail stock sub-ledger, for a company with Retail stock or accounts. */
  retailInventory: RetailInventoryReconciliation | null;
  blockers: ReadinessBlocker[];
  ready: boolean;
}

/** The readiness report for one company (see the module comment). */
export async function perpetualReadinessReport(
  companyId: number,
  requestedEffectiveFrom: string = DEFAULT_PERPETUAL_INVENTORY_FROM
): Promise<PerpetualReadinessReport> {
  const report = await db.transaction(
    async (tx) => {
      await assertTransactionCompanyScope(tx, companyId);
      const cutover = await getInventoryCutover(tx, companyId);
      const effectiveFrom = cutover?.effectiveFrom ?? requestedEffectiveFrom;
      const supplierPartner = await isSupplierPartnerCompany(tx, companyId);
      const resolution = await planReadinessResolutionTx(tx, companyId);
      const factory = await factoryStockValuation(tx, companyId);
      const unvaluedBySource = (source: string) => factory.unvalued.filter((row) => row.source === source).length;
      // Open mixes (not closed, weight left) recorded with no USD cost: a source
      // had no USD rate when it was mixed (factoryStockValuation lists them).
      const openMixesWithoutUsdRate = unvaluedBySource("factory_mix_batches");
      const noMixBales = await noMixCataloguePricedBales(tx, companyId);
      const unposted = await listUnpostedFactoryInvoices(tx, companyId);
      const documents = cutover ? null : await documentsOnOrAfterCutover(tx, companyId, effectiveFrom);
      const opening = cutover ? null : await planOpeningInventoryJournal(companyId, effectiveFrom, tx);
      const reconciliation = cutover ? await reconcilePerpetualInventory(tx, companyId) : null;
      const retail = await retailInventoryReconciliationTx(tx, companyId);
      return {
        retailInventory: retail.applicable ? retail : null,
        cutover,
        effectiveFrom,
        supplierPartner,
        resolution,
        factory,
        unvaluedBySource,
        openMixesWithoutUsdRate,
        noMixBales,
        unposted,
        documents,
        opening,
        reconciliation,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" }
  );
  const fx = await planFactoryFxLegacyRepair(companyId);
  const withoutDatedRate = fx.skippedByReason.RATE_NOT_SET ?? 0;

  const { totals } = report.resolution;
  const blockers: ReadinessBlocker[] = [];
  const add = (code: ReadinessBlockerCode, count: number, value: string | null, message: string) => {
    if (count > 0) blockers.push({ code, count, value, message });
  };
  add(
    "POSTING_NOT_READY",
    PERPETUAL_INVENTORY_POSTING_READY ? 0 : 1,
    null,
    "PERPETUAL_INVENTORY_POSTING_READY is false: no cut-over can be applied"
  );
  if (!report.supplierPartner) {
    add(
      "ORPHANED_LOCATION_STOCK",
      totals.orphanedRows,
      totals.orphanedValue,
      `${totals.orphanedRows} stock rows on ${totals.orphanedLocations} locations that no longer exist`
    );
    add(
      "ANOMALOUS_VALUES",
      totals.anomalousRows,
      totals.anomalousValue,
      `${totals.anomalousRows} stock rows hold a value outside the valuation policy`
    );
  }
  const unvaluedOther = report.factory.unvalued.length - report.openMixesWithoutUsdRate;
  add(
    "UNVALUED_FACTORY_ROWS",
    unvaluedOther,
    null,
    `${unvaluedOther} factory raw-stock or bale rows carry no USD cost`
  );
  add(
    "OPEN_MIXES_WITHOUT_USD_RATE",
    report.openMixesWithoutUsdRate,
    null,
    `${report.openMixesWithoutUsdRate} open mixes are recorded without a USD rate`
  );
  add(
    "NO_MIX_BALES_AT_CATALOGUE_PRICE",
    report.noMixBales.count,
    report.noMixBales.cost,
    `${report.noMixBales.count} stock bales have no mix and are costed at the catalogue production price (unvalued)`
  );
  add(
    "UNPOSTED_FACTORY_INVOICES",
    report.unposted.length,
    null,
    `${report.unposted.length} finalized factory invoices on or after the cut-over carry no ledger journal`
  );
  add(
    "LEGACY_FX_LINES_UNREPAIRED",
    fx.legacyLines,
    null,
    `${fx.legacyLines} legacy factory foreign-currency lines still carry native amounts (wave 6 repair)`
  );
  add(
    "LEGACY_FX_LINES_WITHOUT_DATED_RATE",
    withoutDatedRate,
    null,
    `${withoutDatedRate} of them have no exchange rate on or before their date`
  );
  if (report.documents) {
    const count =
      report.documents.vouchers +
      report.documents.offloads +
      report.documents.factoryReceipts +
      report.documents.stockMovements;
    add(
      "DOCUMENTS_ON_OR_AFTER_CUTOVER",
      count,
      null,
      `${count} documents are already dated on or after ${report.effectiveFrom}`
    );
  }
  if (report.reconciliation && !report.reconciliation.reconciled) {
    const differences = report.reconciliation.lines.filter((line) => line.difference !== "0.00").length;
    add(
      "RECONCILIATION_DIFFERENCE",
      Math.max(differences + report.reconciliation.unpostedFactoryInvoices.length, 1),
      null,
      "The ledger and the stock sub-ledgers differ"
    );
  }

  if (report.retailInventory) {
    const retail = report.retailInventory;
    add(
      "RETAIL_INVENTORY_UNRECONCILED",
      retail.opening && toMoney(retail.difference).isZero() ? 0 : 1,
      retail.difference,
      retail.opening
        ? `RETAIL-INVENTORY differs from the Retail stock sub-ledger by ${retail.difference}`
        : "The Retail inventory opening has not been applied (RETAIL-INVENTORY is not connected to the Retail stock)"
    );
  }

  return {
    companyId,
    generatedAt: new Date().toISOString(),
    effectiveFrom: report.effectiveFrom,
    postingReady: PERPETUAL_INVENTORY_POSTING_READY,
    supplierPartner: report.supplierPartner,
    cutover: report.cutover
      ? { effectiveFrom: report.cutover.effectiveFrom, openingVoucherId: report.cutover.openingVoucherId }
      : null,
    orphanedStock: { locations: totals.orphanedLocations, rows: totals.orphanedRows, value: totals.orphanedValue },
    anomalousValues: { rows: totals.anomalousRows, value: totals.anomalousValue },
    unvaluedFactoryRows: {
      rawStock: report.unvaluedBySource("factory_raw_stock"),
      mixes: report.unvaluedBySource("factory_mix_batches"),
      bales: report.unvaluedBySource("factory_bales"),
    },
    openMixesWithoutUsdRate: report.openMixesWithoutUsdRate,
    noMixCataloguePricedBales: report.noMixBales,
    unpostedFactoryInvoices: report.unposted.length,
    legacyFxLines: { unrepaired: fx.legacyLines, repairable: fx.repairableLines, withoutDatedRate },
    documentsOnOrAfterCutover: report.documents,
    openingPlan: report.opening
      ? { lines: report.opening.lines.length, total: report.opening.total, unvalued: report.opening.unvalued.length }
      : null,
    reconciliation: report.reconciliation
      ? {
          reconciled: report.reconciliation.reconciled,
          differences: report.reconciliation.lines.filter((line) => line.difference !== "0.00").length,
        }
      : null,
    retailInventory: report.retailInventory,
    blockers,
    ready: blockers.length === 0,
  };
}

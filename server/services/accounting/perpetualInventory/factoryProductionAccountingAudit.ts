/**
 * Unified Accounting — Phase 7, Factory production and container accounting.
 *
 * READ ONLY. Existing authoritative writers:
 * - factoryStockValuation / GL-FACTORY-STOCK (current raw, WIP, bales)
 * - factoryInvoice / INV-GL (only finalized customer invoices)
 * - orderChargeLedger / CHARGE (only finalized order charges)
 * - factoryContainerReceipts (immutable receipts with fixed native/USD cost)
 *
 * Historical factory raw, WIP and bale costs are overwritten by subsequent
 * production/cost cascades. Never pretend current costing is an as-of snapshot.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { assertTransactionCompanyScope } from "../../security/transactionCompanyScope";
import { companyBusinessDate } from "../companyBusinessDate";
import { fxDay } from "../monetaryFxRates";
import { getInventoryCutover, PERPETUAL_INVENTORY_POSTING_READY } from "./cutover";
import { factoryStockValuation } from "./factoryValuation";
import { factoryGoodsInTransitHeld, factoryStockJournalNumber } from "./factoryStockJournal";
import { ledgerBalancesByCode, isSupplierPartnerCompany } from "./linkedJournal";
import {
  containersTx,
  limit,
  money,
  value,
  type FactoryProductionAccountingAudit,
  type JournalRow,
  type Money,
} from "./factoryProductionAccountingAuditTypes";
import { invoicesTx } from "./factoryProductionAccountingAuditInvoicesTx";
export type {
  FactoryAuditSeverity,
  FactoryContainerAudit,
  FactoryInvoiceAudit,
  FactoryProductionAccountingAudit,
} from "./factoryProductionAccountingAuditTypes";
export async function factoryProductionAccountingAuditTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    asOfDate?: string;
  }
): Promise<FactoryProductionAccountingAudit> {
  const companyId = input.companyId;
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error("FACTORY_ACCOUNTING_INVALID_COMPANY");
  await assertTransactionCompanyScope(tx, companyId);
  const now = await companyBusinessDate(companyId, tx);
  const day = fxDay(input.asOfDate ?? now);
  const cut = await getInventoryCutover(tx, companyId);
  const partner = await isSupplierPartnerCompany(tx, companyId);
  const val = await factoryStockValuation(tx, companyId);
  const codes = ["FACTORY_RAW_MATERIAL_STOCK", "FACTORY_WIP", "FACTORY_FINISHED_GOODS", "FACTORY_GOODS_IN_TRANSIT"];
  // Historical Factory costing CANNOT be reconstructed: only expose a same-day
  // comparison and always label the subledger as current costing.
  const canCompare = day === now && cut !== null && !partner;
  const ledger = canCompare ? await ledgerBalancesByCode(tx, companyId, codes, day) : new Map<string, Decimal>();
  const inTransit = await factoryGoodsInTransitHeld(tx, companyId, day);
  const targets = new Map<string, Decimal>([
    ["FACTORY_RAW_MATERIAL_STOCK", val.raw],
    ["FACTORY_WIP", val.wip],
    ["FACTORY_FINISHED_GOODS", val.finished],
    ["FACTORY_GOODS_IN_TRANSIT", inTransit],
  ]);
  const accounts: Record<string, { amount: string; difference: Money }> = {};
  for (const [code, target] of targets) {
    const got = ledger.get(code);
    accounts[code] = {
      amount: got === undefined ? "Not available" : money(got),
      difference: got === undefined ? null : money(got.minus(target)),
    };
  }
  const name = factoryStockJournalNumber(companyId, day);
  const journal = resultRows<JournalRow>(
    await tx.execute(sql`
   SELECT id,voucher_number,COALESCE(effective_date,voucher_date)::text AS date
    FROM vouchers WHERE company_id=${companyId} AND voucher_number=${name}
      AND deleted_at IS NULL AND optional=false LIMIT 1
 `)
  )[0];
  const [containers, invoices] = await Promise.all([
    containersTx(tx, companyId, day, day !== now),
    invoicesTx(tx, companyId, day, cut?.effectiveFrom ?? null, day !== now),
  ]);
  const warnings: string[] = [];
  if (day !== now)
    warnings.push(
      "Factory costs, order statuses and voucher lifecycle are current, NOT reconstructed as of the selected date. Financial discrepancies and historical GL-to-cost comparison are withheld."
    );
  if (!cut) warnings.push("Perpetual inventory cutover is not applied. Factory daily stock journal not required.");
  if (!PERPETUAL_INVENTORY_POSTING_READY)
    warnings.push("Perpetual inventory posting gate is disabled; no opening or daily journals were activated.");
  if (partner)
    warnings.push(
      "Supplier Partner inventory is accounted for separately; Factory journal comparison is not applicable."
    );
  if (invoices.some((i) => i.status !== "FINALIZED"))
    warnings.push("Unfinalized/verified/loading orders remain operational and do not create customer receivables.");
  if (containers.some((c) => c.receiptCount === 0 && value(c.rawReceivedKg).gt(0)))
    warnings.push(
      "Some older containers have raw stock without a complete incremental receipt log. Manual review, no backfill."
    );
  const allIssues = [...containers, ...invoices];
  return {
    companyId,
    asOfDate: day,
    reportCurrency: "USD",
    postingReady: PERPETUAL_INVENTORY_POSTING_READY,
    cutover: cut ? { effectiveFrom: cut.effectiveFrom, openingVoucherId: cut.openingVoucherId } : null,
    supplierPartner: partner,
    valuation: {
      basis: day === now ? "CURRENT_COSTING" : "CURRENT_COSTING_NOT_HISTORICAL",
      asOfDate: now,
      rawUsd: money(val.raw),
      wipUsd: money(val.wip),
      finishedUsd: money(val.finished),
      totalUsd: money(val.raw.plus(val.wip).plus(val.finished)),
      goodsInTransitUsd: money(inTransit),
      reservedForOpenOrders: val.reservedForOrders,
      soldNotInvoiced: val.soldNotInvoiced,
      unvalued: val.unvalued,
      ledger: accounts,
      journal: { number: name, id: journal?.id ?? null, date: journal?.date ?? null },
    },
    containers,
    invoices,
    summary: {
      containers: containers.length,
      invoices: invoices.length,
      unfinalized: invoices.filter((i) => i.status !== "FINALIZED").length,
      missingFinalizedInvoices: invoices.filter((i) =>
        i.issues.includes("Finalized invoice is missing a live accounting voucher")
      ).length,
      prematureCustomerPostings: invoices.filter((i) => i.issues.some((q) => q.startsWith("Unfinalized order has")))
        .length,
      unverifiedContainerCosts: containers.filter((c) => c.issues.some((x) => x.includes("USD") || x.includes("rate")))
        .length,
      unvaluedStock: val.unvalued.length,
      critical: allIssues.filter((r) => r.severity === "critical").length,
      review: allIssues.filter((r) => r.severity === "review").length,
      truncated: containers.length === limit || invoices.length === limit,
    },
    warnings,
    policy: {
      draftAndVerifiedOrders:
        "DRAFT/LOADING/PENDING_VERIFICATION/VERIFIED orders are not customer invoices or settled freight.",
      invoiceDate:
        "Invoice source date is COALESCE(finalized_at,created_at) in the existing Factory posting writer; do not use loading-start dates.",
      freight:
        "Freight/charges cannot reach customer statements until order FINALIZED; independently posted charge vouchers are counted once.",
      costValuation:
        "Factory raw = available kg × verified USD landed cost; WIP = unconsumed mix + pending pressing bales; Finished = bales at recorded USD cost.",
      productionVariance:
        "Existing per-company daily GL-FACTORY-STOCK is the only stock consolidation writer; waste, cascade and production differences keep distinct offset accounts.",
      factoryReceipts:
        "Incremental receipt events have native and USD frozen cost snapshots; missing USD values require review, never guessed rate.",
      transfers:
        "ERP bale mirrors are excluded from ERP Inventory to avoid double valuation of Factory finished goods.",
      cutover:
        "The existing perpetual activation gate remains false; this report never creates opening balances or vouchers.",
      historical:
        "Historical Factory raw/mix/bale cost reconstruction cannot be inferred from current overwritten cost rows.",
    },
  };
}

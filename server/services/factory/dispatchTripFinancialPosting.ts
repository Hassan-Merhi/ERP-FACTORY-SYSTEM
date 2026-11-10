/**
 * Phase 4 — financially post a CLOSED physical Factory dispatch.
 *
 * No invoice number, stock movement, new customer balance cache row or ERP
 * supplier import here. Receivables are carried by vouchers; the existing
 * customer statement/Net Position project the voucher once (not a cache copy).
 *
 * Goods: Dr customer receivable / Cr FACTORY_DISPATCH_CLEARING.
 * Billable charges: Dr customer receivable / Cr chosen income account.
 * Discounts: Dr chosen contra account / Cr customer receivable.
 * Internal expenses: Dr chosen expense/asset / Cr chosen offset payable/bank.
 *
 * Phase 8 must clear FACTORY_DISPATCH_CLEARING to sales when ONE consolidated
 * invoice is finalized, not debit receivables again.
 */
import { sql } from "drizzle-orm";
import type Decimal from "decimal.js";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { MoneyDecimal, sumMoney } from "../../lib/money";
import { customerLedgerAccountTx } from "../accounting/perpetualInventory/factoryInvoice";
import { ledgerAccountByCodeTx } from "../accounting/perpetualInventory/linkedJournal";
import {
  mirroredUsdLines, postFactoryVoucherTx, type FactoryVoucherLine,
} from "./factoryVoucherPosting";
import { loadDispatchTripFinancialSource } from "./dispatchTripFinancialSource";
import {
  accountAcceptsCharge, accountAcceptsOffset, buildTripChargePreview,
  tripChargeFingerprint, type TripChargeRow, type TripChargeKind, type ErpChargeType,
} from "../../routes/factory/customer-orders/loadingDispatchFinancialChargeModel";

export class TripFinancialPostingError extends Error {
  constructor(readonly code: string, message: string, readonly status = 409) {
    super(message);
    this.name = "TripFinancialPostingError";
  }
}
const refuse = (code: string, message: string, status = 409): never => {
  throw new TripFinancialPostingError(code, message, status);
};
const rows = async (tx: DbTransaction, q: ReturnType<typeof sql>) => resultRows(await tx.execute(q));
const numberId = (value: unknown): number => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) refuse("FINANCIAL_ID_INVALID", "Stored financial identifier is invalid");
  return n;
};
const money = (value: string) => new MoneyDecimal(value);
const zero = new MoneyDecimal(0);
const keyOf = (companyId: number, dispatchId: number, revision: number, part: string) =>
  `factory-dispatch:${companyId}:${dispatchId}:${revision}:${part}`;

export interface DispatchPostingScope {
  companyId: number;
  orderId: number;
  dispatchId: number;
  userId: string;
  username: string;
}
export interface DispatchPostingRequest {
  sourceFingerprint: string;
  chargeFingerprint: string;
  postingDate: string;
}
export interface DispatchPostingResult {
  financialId: number;
  status: "POSTED";
  revision: number;
  goodsSubtotal: string;
  billableChargesTotal: string;
  discountTotal: string;
  internalExpenseTotal: string;
  customerTotal: string;
  voucherIds: number[];
  replayed: boolean;
}
async function readFinancial(tx: DbTransaction, scope: DispatchPostingScope) {
  const r = (await rows(tx, sql`
    SELECT id, status, posting_revision AS "postingRevision",
           snapshot_revision AS "snapshotRevision",
           source_fingerprint AS "sourceFingerprint", currency,
           goods_subtotal::text AS "goodsSubtotal",
           billable_charges_total::text AS "billableChargesTotal",
           discount_total::text AS "discountTotal",
           customer_total::text AS "customerTotal"
      FROM factory_dispatch_trip_financials
     WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
       AND dispatch_id = ${scope.dispatchId} FOR UPDATE
  `))[0];
  return r ? {
    id: numberId(r.id), status: String(r.status), postingRevision: Number(r.postingRevision),
    snapshotRevision: Number(r.snapshotRevision), sourceFingerprint: r.sourceFingerprint == null ? null : String(r.sourceFingerprint),
    currency: String(r.currency),
    goodsSubtotal: String(r.goodsSubtotal), billableChargesTotal: String(r.billableChargesTotal),
    discountTotal: String(r.discountTotal), customerTotal: String(r.customerTotal),
  } : null;
}
async function readCharges(tx: DbTransaction, financialId: number, revision: number, scope: DispatchPostingScope): Promise<TripChargeRow[]> {
  const found = await rows(tx, sql`
    SELECT id, name, kind, amount::text, currency, revision,
           ledger_account_id AS "ledgerAccountId",
           offset_ledger_account_id AS "offsetLedgerAccountId",
           erp_charge_type AS "erpChargeType", notes, locked_at AS "lockedAt"
      FROM factory_dispatch_trip_charges
     WHERE financial_id = ${financialId} AND company_id = ${scope.companyId}
       AND order_id = ${scope.orderId} AND dispatch_id = ${scope.dispatchId}
       AND revision = ${revision} ORDER BY id FOR UPDATE
  `);
  return found.map(r => ({
    id: numberId(r.id), name: String(r.name), kind: String(r.kind) as TripChargeKind,
    amount: String(r.amount), currency: String(r.currency), revision: Number(r.revision),
    ledgerAccountId: numberId(r.ledgerAccountId),
    offsetLedgerAccountId: r.offsetLedgerAccountId == null ? null : numberId(r.offsetLedgerAccountId),
    erpChargeType: (r.erpChargeType ?? null) as ErpChargeType,
    notes: r.notes == null ? null : String(r.notes),
    lockedAt: r.lockedAt == null ? null : String(r.lockedAt),
  }));
}
async function assertChargeAccounts(tx: DbTransaction, companyId: number, charges: TripChargeRow[]) {
  if (!charges.length) return;
  const ids = Array.from(new Set(charges.flatMap(c => [c.ledgerAccountId, ...(c.offsetLedgerAccountId ? [c.offsetLedgerAccountId] : [])])));
  const accounts = await rows(tx, sql`
    SELECT id, account_type AS "accountType", active, is_hidden AS "hidden", deleted_at AS "deletedAt"
      FROM ledger_accounts WHERE company_id = ${companyId} AND id IN (${sql.join(ids.map(i => sql`${i}`), sql`,`)})
  `);
  const byId = new Map(accounts.map(a => [Number(a.id), a]));
  for (const charge of charges) {
    const a = byId.get(charge.ledgerAccountId);
    if (!a || !a.active || a.deletedAt || a.hidden || !accountAcceptsCharge(charge.kind, String(a.accountType))) {
      refuse("TRIP_CHARGE_ACCOUNT_INVALID", `Charge "${charge.name}" has no valid active company-owned account`);
    }
    if (charge.currency !== "USD" || charge.lockedAt) refuse("TRIP_CHARGE_CURRENCY_OR_LOCKED", "Only unlocked USD charge drafts can be posted");
    if (charge.kind === "INTERNAL") {
      const offset = charge.offsetLedgerAccountId ? byId.get(charge.offsetLedgerAccountId) : null;
      if (!offset || !offset.active || offset.deletedAt || offset.hidden || !accountAcceptsOffset(String(offset.accountType)) ||
          charge.ledgerAccountId === charge.offsetLedgerAccountId) {
        refuse("TRIP_CHARGE_OFFSET_INVALID", `Internal expense "${charge.name}" requires a valid company offset account`);
      }
    } else if (charge.offsetLedgerAccountId !== null) {
      refuse("TRIP_CHARGE_OFFSET_INVALID", "Only internal expenses may have a separate offset account");
    }
  }
}
async function lockTripOrder(tx: DbTransaction, scope: DispatchPostingScope) {
  const [o] = await rows(tx, sql`
    SELECT id, status, deleted_at AS "deletedAt"
      FROM customer_orders
     WHERE company_id = ${scope.companyId} AND id = ${scope.orderId} FOR UPDATE
  `);
  if (!o || o.deletedAt || !["LOADING", "PENDING_VERIFICATION", "VERIFIED"].includes(String(o.status))) {
    refuse("TRIP_LOADING_INACTIVE", "Only an active unfinalized loading can financially finalize a truck");
  }
  const [trip] = await rows(tx, sql`
    SELECT id, status FROM factory_loading_dispatches
     WHERE company_id = ${scope.companyId} AND order_id = ${scope.orderId}
       AND id = ${scope.dispatchId} FOR UPDATE
  `);
  if (!trip || trip.status !== "CLOSED") refuse("TRIP_NOT_CLOSED", "End Dispatch before financially finalizing its charges");
}
async function writeAudit(tx: DbTransaction, scope: DispatchPostingScope, financialId: number, event: string, details: object, reason: string | null = null) {
  await tx.execute(sql`
    INSERT INTO factory_dispatch_financial_events
      (company_id,order_id,dispatch_id,financial_id,event_type,details,reason,actor_user_id,actor_username)
    VALUES (${scope.companyId},${scope.orderId},${scope.dispatchId},${financialId},
            ${event},${JSON.stringify(details)}::jsonb,${reason},${scope.userId},${scope.username})
  `);
}
function requireDate(date: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(date + "T12:00:00Z").getTime())) {
    refuse("TRIP_POSTING_DATE_INVALID", "Provide a valid company business date before posting");
  }
}
/** Posting stays disabled until BOTH manual TablePlus SQL files are applied. */
async function assertHardenedFinancialSchemaTx(tx: DbTransaction): Promise<void> {
  const [ready] = await rows(tx, sql`
    SELECT
      (SELECT relforcerowsecurity FROM pg_class
        WHERE oid=to_regclass('public.factory_dispatch_trip_financials')) AS "financialRls",
      (SELECT relforcerowsecurity FROM pg_class
        WHERE oid=to_regclass('public.factory_dispatch_trip_postings')) AS "postingsRls",
      EXISTS(
        SELECT 1 FROM pg_trigger
         WHERE tgrelid=to_regclass('public.factory_loading_dispatches')
           AND tgname='factory_dispatch_physical_posted_guard'
           AND tgenabled <> 'D'
      ) AS "physicalGuard",
      EXISTS(
        SELECT 1 FROM pg_trigger
         WHERE tgrelid=to_regclass('public.customer_order_bales')
           AND tgname='factory_dispatch_order_bale_financial_guard'
           AND tgenabled <> 'D'
      ) AS "baleGuard"
  `);
  if (!ready?.financialRls || !ready?.postingsRls ||
      !ready?.physicalGuard || !ready?.baleGuard) {
    refuse("TRIP_FINANCIAL_SQL_PENDING",
      "Trip financial posting is disabled until the final Phase 2 and Phase 4 TablePlus SQL has been installed.",
      503);
  }
}
/** One atomic finalization; caller creates a real database transaction. */
export async function postDispatchTripFinancialTx(
  tx: DbTransaction, scope: DispatchPostingScope, req: DispatchPostingRequest
): Promise<DispatchPostingResult> {
  requireDate(req.postingDate);
  await assertHardenedFinancialSchemaTx(tx);
  await lockTripOrder(tx, scope);
  const financial = await readFinancial(tx, scope);
  if (financial?.status === "POSTED") {
    const [record] = await rows(tx, sql`
      SELECT voucher_ids AS "voucherIds", source_fingerprint AS "sourceFingerprint"
        FROM factory_dispatch_trip_postings
       WHERE financial_id = ${financial.id} AND kind = 'POST'
         AND posting_revision = ${financial.postingRevision} LIMIT 1
    `);
    if (!record || !Array.isArray(record.voucherIds)) {
      refuse("TRIP_POSTING_INCOMPLETE", "The original financial posting evidence is missing; accounting review required");
    }
    if (req.sourceFingerprint !== financial.sourceFingerprint ||
        req.sourceFingerprint !== String(record.sourceFingerprint)) {
      refuse("TRIP_ALREADY_POSTED_DIFFERENT_SOURCE",
        "The trip has already been posted from another signed source revision");
    }
    const postedCharges = await readCharges(tx, financial.id, financial.postingRevision, scope);
    const totals = buildTripChargePreview(financial.goodsSubtotal, postedCharges);
    return {
      financialId: financial.id, status: "POSTED", revision: financial.postingRevision,
      goodsSubtotal: financial.goodsSubtotal, billableChargesTotal: financial.billableChargesTotal,
      discountTotal: financial.discountTotal, customerTotal: financial.customerTotal,
      internalExpenseTotal: totals.internalExpenseTotal,
      voucherIds: record.voucherIds.map(numberId),
      replayed: true,
    };
  }
  if (financial && !["DRAFT", "REVERSED"].includes(financial.status)) {
    refuse("TRIP_ALREADY_CONSOLIDATED", "This trip is part of a finalized invoice and cannot be posted again");
  }
  if (financial && financial.currency !== "USD") {
    refuse("TRIP_CURRENCY_UNSUPPORTED", "Only USD trip financial finalization is enabled");
  }

  const source = await loadDispatchTripFinancialSource(tx, scope.companyId, scope.orderId, scope.dispatchId);
  if (source.sourceFingerprint !== req.sourceFingerprint) {
    refuse("TRIP_SOURCE_CHANGED", "Signed barcodes or prices have changed. Refresh the financial preview.");
  }
  const revision = (financial?.postingRevision ?? 0) + 1;
  const charges = financial ? await readCharges(tx, financial.id, revision, scope) : [];
  if (tripChargeFingerprint(charges) !== req.chargeFingerprint) {
    refuse("TRIP_CHARGES_CHANGED", "Charge draft changed. Refresh the financial preview.");
  }
  await assertChargeAccounts(tx, scope.companyId, charges);
  const totals = buildTripChargePreview(source.goodsSubtotal, charges);

  // Prevent ordinary invoicing from having already applied order charges to
  // the same receipt and prevent a second financial workflow from mixing in.
  const [alreadyInvoiced] = await rows(tx, sql`
    SELECT id FROM customer_orders WHERE id = ${scope.orderId}
      AND company_id = ${scope.companyId} AND invoice_number IS NOT NULL LIMIT 1
  `);
  if (alreadyInvoiced) refuse("TRIP_ORDER_ALREADY_INVOICED", "This loading already owns an invoice number");

  let financialId = financial?.id ?? 0;
  if (!financial) {
    const [inserted] = await rows(tx, sql`
      INSERT INTO factory_dispatch_trip_financials
        (company_id, order_id, dispatch_id, status, currency)
      VALUES (${scope.companyId}, ${scope.orderId}, ${scope.dispatchId}, 'DRAFT', 'USD')
      RETURNING id
    `);
    financialId = numberId(inserted.id);
  }
  // Freeze source membership first, before any financial effects.
  for (const bale of source.bales) {
    await tx.execute(sql`
      INSERT INTO factory_dispatch_trip_financial_bales (
        financial_id,company_id,order_id,dispatch_id,closure_history_id,
        snapshot_revision,source_scan_id,bale_id,bale_reference,article_code,product_name,
        weight_kg,price_source,pricing_mode,unit_price,line_total
      ) VALUES (
        ${financialId},${scope.companyId},${scope.orderId},${scope.dispatchId},
        ${source.closureHistoryId}::bigint,${revision},${bale.scanId}::bigint,${bale.baleId},
        ${bale.baleReference},${bale.articleCode},${bale.productName},
        ${bale.weightKg},${bale.priceSource},${bale.pricingMode},${bale.unitPrice},${bale.lineTotal}
      )
    `);
  }

  const customerLedgerId = await customerLedgerAccountTx(tx, scope.companyId, source.customerId);
  const clearingId = await ledgerAccountByCodeTx(
    tx, scope.companyId, "FACTORY_DISPATCH_CLEARING", "Factory Dispatch Clearing", "Liability"
  );
  const customerTotal = money(totals.customerTotal);
  const goods = money(source.goodsSubtotal);
  const positive = (v: Decimal) => v.gt(0);
  const invoiceLines: FactoryVoucherLine[] = [];
  if (positive(customerTotal)) invoiceLines.push({
    ledgerAccountId: customerLedgerId, customerId: source.customerId,
    debit: customerTotal, narration: `Truck ${scope.dispatchId} customer receivable`,
  });
  if (positive(goods)) invoiceLines.push({
    ledgerAccountId: clearingId, credit: goods, narration: "Pending consolidated Factory goods sale",
  });
  for (const charge of charges) {
    const amount = money(charge.amount);
    if (charge.kind === "BILLABLE") invoiceLines.push({
      ledgerAccountId: charge.ledgerAccountId, credit: amount, narration: charge.name,
    });
    if (charge.kind === "DISCOUNT") invoiceLines.push({
      ledgerAccountId: charge.ledgerAccountId, debit: amount, narration: charge.name,
    });
  }
  const voucherDebits = sumMoney(invoiceLines.map(line => line.debit ?? 0));
  const voucherCredits = sumMoney(invoiceLines.map(line => line.credit ?? 0));
  if (!voucherDebits.eq(voucherCredits)) {
    refuse("TRIP_JOURNAL_UNBALANCED", "Customer receivable and trip charge journal does not balance");
  }
  const voucherIds: number[] = [];
  let salesVoucherId: number | null = null;
  if (invoiceLines.length > 0) {
    const r = await postFactoryVoucherTx(tx, {
      companyId: scope.companyId,
      voucherNumber: `FDTR-${scope.companyId}-${scope.dispatchId}-${revision}`,
      voucherDate: req.postingDate,
      description: `Factory dispatch trip ${scope.dispatchId}, pending consolidated invoice`,
      sourceModule: "FACTORY",
      source: { sourceType: "factory-dispatch-trip", sourceId: `${financialId}:${revision}`, phase: "receivable" },
      lines: invoiceLines, actor: { userId: scope.userId, username: scope.username },
    });
    salesVoucherId = r.voucher.id;
    voucherIds.push(salesVoucherId);
  }
  for (const charge of charges.filter(c => c.kind === "INTERNAL")) {
    const amount = money(charge.amount);
    const r = await postFactoryVoucherTx(tx, {
      companyId: scope.companyId,
      voucherNumber: `FDTE-${scope.companyId}-${scope.dispatchId}-${revision}-${charge.id}`,
      voucherDate: req.postingDate,
      description: `Factory dispatch trip ${scope.dispatchId} internal expense: ${charge.name}`,
      sourceModule: "FACTORY",
      source: { sourceType: "factory-dispatch-trip-internal", sourceId: `${financialId}:${revision}:${charge.id}`, phase: "expense" },
      lines: [
        { ledgerAccountId: charge.ledgerAccountId, debit: amount, narration: charge.name },
        { ledgerAccountId: charge.offsetLedgerAccountId!, credit: amount, narration: charge.name },
      ], actor: { userId: scope.userId, username: scope.username },
    });
    voucherIds.push(r.voucher.id);
    await tx.execute(sql`
      UPDATE factory_dispatch_trip_charges SET locked_at = NOW(), posted_voucher_id = ${r.voucher.id}
       WHERE id = ${charge.id} AND financial_id = ${financialId} AND locked_at IS NULL
    `);
  }
  if (salesVoucherId !== null) {
    await tx.execute(sql`
      UPDATE factory_dispatch_trip_charges SET locked_at = NOW(), posted_voucher_id = ${salesVoucherId}
       WHERE financial_id = ${financialId} AND revision = ${revision}
         AND kind IN ('BILLABLE', 'DISCOUNT') AND locked_at IS NULL
    `);
  }
  await tx.execute(sql`
    UPDATE factory_dispatch_trip_financials
       SET status='POSTED', snapshot_revision=${revision}, posting_revision=${revision},
           closure_history_id=${source.closureHistoryId}::bigint, manifest_fingerprint=${source.manifestFingerprint},
           source_fingerprint=${source.sourceFingerprint}, valuation_date=${req.postingDate}::date, fx_rate=1,
           goods_subtotal=${totals.goodsSubtotal}, billable_charges_total=${totals.billableChargesTotal},
           discount_total=${totals.discountTotal}, customer_total=${totals.customerTotal},
           posted_at=NOW(), posted_by_user_id=${scope.userId}, updated_at=NOW()
     WHERE id=${financialId} AND company_id=${scope.companyId} AND order_id=${scope.orderId}
       AND dispatch_id=${scope.dispatchId} AND status IN ('DRAFT','REVERSED')
  `);
  await tx.execute(sql`
    INSERT INTO factory_dispatch_trip_postings
      (financial_id,company_id,order_id,dispatch_id,posting_revision,kind,idempotency_key,
       source_fingerprint,amount,voucher_ids,posted_by_user_id)
    VALUES (${financialId},${scope.companyId},${scope.orderId},${scope.dispatchId},${revision},
            'POST',${keyOf(scope.companyId,scope.dispatchId,revision,"post")},
            ${source.sourceFingerprint},${totals.customerTotal},${JSON.stringify(voucherIds)}::jsonb,${scope.userId})
  `);
  await writeAudit(tx, scope, financialId, "TRIP_FINANCIALLY_POSTED", {
    revision, closureHistoryId: source.closureHistoryId, sourceFingerprint: source.sourceFingerprint,
    chargeFingerprint: req.chargeFingerprint, voucherIds, totals,
  });
  return { financialId, status: "POSTED", revision, ...totals, voucherIds, replayed: false };
}

/** 
 * Conservative reversal: only before ERP PO export or consolidation, with
 * no customer payment against the order. Correct through mirror vouchers;
 * historical bales/charges/postings stay immutable. Never delete a voucher.
 */
export async function reverseDispatchTripFinancialTx(
  tx: DbTransaction, scope: DispatchPostingScope, args: { date: string; reason: string }
) {
  requireDate(args.date);
  await assertHardenedFinancialSchemaTx(tx);
  if (args.reason.trim().length < 10 || args.reason.trim().length > 1000) {
    refuse("TRIP_REVERSAL_REASON_REQUIRED", "Enter an explanation between 10 and 1,000 characters");
  }
  await lockTripOrder(tx, scope);
  const financial = await readFinancial(tx, scope);
  if (!financial || financial.status !== "POSTED") {
    refuse("TRIP_NOT_POSTED", "Only a financially posted, unconsolidated trip can be reversed");
  }
  const [exported] = await rows(tx, sql`
    SELECT id FROM factory_dispatch_trip_exports WHERE financial_id=${financial.id} LIMIT 1
  `);
  if (exported) refuse("TRIP_EXPORTED_LOCKED", "This trip has already been exported to ERP; use a controlled cross-company correction");
  const [settlement] = await rows(tx, sql`
    SELECT id FROM customer_balances
     WHERE company_id=${scope.companyId} AND reference_type='INVOICE'
       AND reference_id=${scope.orderId} AND transaction_type='PAYMENT' LIMIT 1
  `);
  if (settlement) refuse("TRIP_SETTLEMENT_LOCKED", "Payments linked to this loading must be reversed before financial correction");
  // A receipt or credit may be recorded directly against the customer's
  // ledger rather than the order-specific customer_balances cache. Refuse a
  // potentially settled reversal instead of guessing which credit applied.
  const [customerCredit] = await rows(tx, sql`
    SELECT 1
      FROM customer_orders o
      JOIN factory_dispatch_trip_financials f
        ON f.company_id=o.company_id AND f.order_id=o.id
      JOIN voucher_entries ve ON ve.customer_id=o.customer_id
      JOIN vouchers v ON v.id=ve.voucher_id AND v.company_id=o.company_id
     WHERE o.company_id=${scope.companyId} AND o.id=${scope.orderId}
       AND f.id=${financial.id} AND v.deleted_at IS NULL
       AND COALESCE(v.optional, FALSE)=FALSE
       AND COALESCE(ve.credit_amount, 0) > 0
       AND (
         COALESCE(v.effective_date,v.voucher_date) >= f.valuation_date
         OR v.created_at >= f.posted_at
       )
     LIMIT 1
  `);
  if (customerCredit) {
    refuse("TRIP_CUSTOMER_CREDIT_RECONCILIATION_REQUIRED",
      "A customer payment or credit exists after this trip was posted. Reconcile or reverse that credit first.");
  }
  const [original] = await rows(tx, sql`
    SELECT id,voucher_ids AS "voucherIds",source_fingerprint AS "sourceFingerprint"
      FROM factory_dispatch_trip_postings WHERE financial_id=${financial.id}
        AND posting_revision=${financial.postingRevision} AND kind='POST' LIMIT 1
  `);
  if (!original || !Array.isArray(original.voucherIds)) {
    refuse("TRIP_POSTING_INCOMPLETE", "Original immutable posting evidence is missing");
  }
  const reversedVoucherIds: number[] = [];
  for (const value of original.voucherIds) {
    const voucherId = numberId(value);
    const [voucher] = await rows(tx, sql`
      SELECT id,deleted_at AS "deletedAt", voucher_date AS "voucherDate"
        FROM vouchers WHERE id=${voucherId} AND company_id=${scope.companyId} FOR UPDATE
    `);
    if (!voucher || voucher.deletedAt) refuse("TRIP_POSTING_INCOMPLETE", "Original voucher is no longer live");
    const lines = await rows(tx, sql`
      SELECT ledger_account_id AS "ledgerAccountId",customer_id AS "customerId",
             supplier_id AS "supplierId",employee_id AS "employeeId",
             bank_account_id AS "bankAccountId",fixed_asset_id AS "fixedAssetId",
             factory_supplier_id AS "factorySupplierId", debit_amount::text AS "debitAmount",
             credit_amount::text AS "creditAmount", narration
        FROM voucher_entries WHERE voucher_id=${voucherId} ORDER BY id
    `);
    const mirror = mirroredUsdLines(lines.map(line => ({
      ledgerAccountId: line.ledgerAccountId == null ? null : numberId(line.ledgerAccountId),
      customerId: line.customerId == null ? null : numberId(line.customerId),
      supplierId: line.supplierId == null ? null : numberId(line.supplierId),
      employeeId: line.employeeId == null ? null : numberId(line.employeeId),
      bankAccountId: line.bankAccountId == null ? null : numberId(line.bankAccountId),
      fixedAssetId: line.fixedAssetId == null ? null : numberId(line.fixedAssetId),
      factorySupplierId: line.factorySupplierId == null ? null : numberId(line.factorySupplierId),
      debitAmount: String(line.debitAmount), creditAmount: String(line.creditAmount),
      narration: String(line.narration ?? ""),
    })), "Reversal of dispatch trip voucher " + voucherId);
    const result = await postFactoryVoucherTx(tx, {
      companyId: scope.companyId,
      voucherNumber: `FDTR-REV-${scope.companyId}-${scope.dispatchId}-${financial.postingRevision}-${voucherId}`,
      voucherDate: args.date,
      description: `Reverse Factory dispatch trip ${scope.dispatchId}: ${args.reason.trim()}`,
      sourceModule: "FACTORY",
      source: {
        sourceType: "factory-dispatch-trip-reversal",
        sourceId: `${financial.id}:${financial.postingRevision}:${voucherId}`,
        phase: "reversal",
      },
      lines: mirror, actor: { userId: scope.userId, username: scope.username, reason: args.reason.trim() },
    });
    reversedVoucherIds.push(result.voucher.id);
  }
  await tx.execute(sql`
    INSERT INTO factory_dispatch_trip_postings
      (financial_id,company_id,order_id,dispatch_id,posting_revision,kind,idempotency_key,
       source_fingerprint,amount,voucher_ids,reverses_posting_id,reason,posted_by_user_id)
    VALUES (${financial.id},${scope.companyId},${scope.orderId},${scope.dispatchId},
            ${financial.postingRevision},'REVERSAL',
            ${keyOf(scope.companyId,scope.dispatchId,financial.postingRevision,"reversal")},
            ${String(original.sourceFingerprint)},${financial.customerTotal},
            ${JSON.stringify(reversedVoucherIds)}::jsonb,${numberId(original.id)},${args.reason.trim()},${scope.userId})
  `);
  await tx.execute(sql`
    UPDATE factory_dispatch_trip_financials SET status='REVERSED',updated_at=NOW()
     WHERE id=${financial.id} AND status='POSTED'
  `);
  await writeAudit(tx, scope, financial.id, "TRIP_POSTING_REVERSED", {
    revision: financial.postingRevision, originalVoucherIds: original.voucherIds, reversedVoucherIds,
  }, args.reason.trim());
  return { status: "REVERSED" as const, revision: financial.postingRevision, reversedVoucherIds };
}

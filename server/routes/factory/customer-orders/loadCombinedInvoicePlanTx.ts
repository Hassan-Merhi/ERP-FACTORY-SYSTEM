// Extracted from ./loadingDispatchCombinedInvoiceService.ts to keep that module under the source-size cap.
import { eq, sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";
import { MoneyDecimal, sumMoney } from "../../../lib/money";
import { isPerpetualInventoryActive } from "../../../services/accounting/perpetualInventory/cutover";
import { customerOrderCharges } from "@shared/schema";
import {
  loadOrderDispatchReconciliationTx,
  type OrderReconciliationScope,
} from "./loadingDispatchOrderReconciliationData";
import { OrderReconciliationError } from "./loadingDispatchOrderReconciliationModel";

export const arr = async (tx: DbTransaction, q: ReturnType<typeof sql>) => resultRows(await tx.execute(q));

export const money = (v: unknown) => new MoneyDecimal(String(v ?? "0"));

export const moneyText = (v: unknown) => {
  const text = String(v ?? "");
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,2})?$/.test(text)) {
    raise("COMBINED_INVOICE_INVALID_AMOUNT", "Financial source has an invalid two-decimal amount");
  }
  return money(text).toFixed(2);
};

export const raise = (code: string, message: string, status = 409): never => {
  throw new OrderReconciliationError(code, message, status);
};

export const costText = (v: unknown) => {
  const raw = String(v ?? "");
  // Factory bale costs are NUMERIC(20,7): sum full precision, round once
  // for the final COGS voucher, matching existing Factory inventory accounting.
  if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,7})?$/.test(raw)) {
    raise("COMBINED_INVOICE_COST_INVALID", "A shipped bale has an invalid 7-decimal cost");
  }
  return new MoneyDecimal(raw);
};

export const numberId = (v: unknown) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 1)
    raise("COMBINED_INVOICE_INVALID_ID", "Invoice source has an invalid record ID");
  return n;
};

export interface PostedBale {
  baleId: number;
  articleCode: string;
  productName: string;
  weightKg: string;
  lineTotal: string;
}

interface OriginalCharge {
  id: number;
  name: string;
  chargeType: string;
  amount: string;
  ledgerAccountId: number | null;
  voucherId: number | null;
  alreadyPosted: boolean;
}

export interface CombinedInvoiceScope extends OrderReconciliationScope {
  reason: string;
  postingDate: string;
}

export interface CombinedInvoicePlan {
  fingerprint: string;
  ready: boolean;
  blockingReasons: string[];
  tripCount: number;
  postingIds: string[];
  goodsSubtotal: string;
  tripBillableCharges: string;
  tripDiscounts: string;
  tripCustomerTotal: string;
  originalOrderCharges: string;
  finalInvoiceTotal: string;
  physicalBales: number;
  totalCost: string;
  postCOGS: boolean;
  originalCharges: OriginalCharge[];
  trips: Array<{ dispatchId: string; dispatchNumber: number; customerTotal: string; postedBales: number }>;
}

interface LoadedPlan {
  plan: CombinedInvoicePlan;
  bales: PostedBale[];
  customerId: number;
}

const sameIds = (a: string[], b: string[]) =>
  JSON.stringify(a.map(String).sort()) === JSON.stringify(b.map(String).sort());

async function verifyOriginalChargeTx(
  tx: DbTransaction,
  s: OrderReconciliationScope,
  customerId: number,
  row: {
    id: unknown;
    name: unknown;
    chargeType: unknown;
    amount: unknown;
    ledgerAccountId: unknown;
    voucherId: unknown;
  }
): Promise<OriginalCharge> {
  const charge: OriginalCharge = {
    id: numberId(row.id),
    name: String(row.name ?? "Charge"),
    chargeType: String(row.chargeType ?? "OTHER"),
    amount: moneyText(row.amount),
    ledgerAccountId: row.ledgerAccountId == null ? null : numberId(row.ledgerAccountId),
    voucherId: row.voucherId == null ? null : numberId(row.voucherId),
    alreadyPosted: false,
  };
  if (money(charge.amount).isZero()) return charge;
  if (!charge.ledgerAccountId)
    raise(
      "COMBINED_INVOICE_CHARGE_ACCOUNT_REQUIRED",
      `Original order charge "${charge.name}" needs a ledger account before the final invoice`
    );
  const [account] = await arr(
    tx,
    sql`
    SELECT id,account_type AS "accountType" FROM ledger_accounts
     WHERE id=${charge.ledgerAccountId} AND company_id=${s.companyId}
       AND active=TRUE AND is_hidden=FALSE AND deleted_at IS NULL
  `
  );
  if (!account || !/income|revenue|liability/i.test(String(account.accountType))) {
    raise(
      "COMBINED_INVOICE_CHARGE_ACCOUNT_INVALID",
      `Original order charge "${charge.name}" has no active, company-owned income/payable account`
    );
  }
  if (charge.voucherId) {
    const [existing] = await arr(
      tx,
      sql`
      SELECT v.id,
        COALESCE(SUM(CASE WHEN ve.customer_id=${customerId}
          THEN ve.debit_amount-ve.credit_amount ELSE 0 END),0)::text AS "customerImpact",
        COALESCE(SUM(CASE WHEN ve.ledger_account_id=${charge.ledgerAccountId}
          AND ve.customer_id IS NULL THEN ve.credit_amount-ve.debit_amount
          ELSE 0 END),0)::text AS "chargeCredit"
      FROM vouchers v LEFT JOIN voucher_entries ve ON ve.voucher_id=v.id
       WHERE v.company_id=${s.companyId} AND v.id=${charge.voucherId}
        AND v.deleted_at IS NULL AND COALESCE(v.optional,FALSE)=FALSE
       GROUP BY v.id
    `
    );
    if (
      !existing ||
      !money(existing.customerImpact).eq(money(charge.amount)) ||
      !money(existing.chargeCredit).eq(money(charge.amount))
    ) {
      raise(
        "COMBINED_INVOICE_CHARGE_ALREADY_POSTED_DIFFERENT",
        `Existing voucher for original charge "${charge.name}" does not match its customer amount`
      );
    }
    charge.alreadyPosted = true;
  } else {
    // Older loading workflows may have created a CHARGE-PRE voucher without
    // linking its FK. Refuse rather than double charge the customer.
    const [orphan] = await arr(
      tx,
      sql`
      SELECT id FROM vouchers WHERE company_id=${s.companyId}
       AND voucher_number=${"CHARGE-PRE-" + s.orderId + "-" + charge.id}
       AND deleted_at IS NULL LIMIT 1
    `
    );
    if (orphan)
      raise(
        "COMBINED_INVOICE_PRECHARGE_REVIEW",
        `Original charge "${charge.name}" has an unlinked pre-invoice voucher; reconcile it first`
      );
  }
  return charge;
}

async function signedBalesTx(tx: DbTransaction, s: OrderReconciliationScope): Promise<PostedBale[]> {
  const rows = await arr(
    tx,
    sql`
    SELECT b.bale_id AS "baleId",b.article_code AS "articleCode",
           b.product_name AS "productName",b.weight_kg::text AS "weightKg",
           b.line_total::text AS "lineTotal"
     FROM factory_dispatch_trip_financial_bales b
     JOIN factory_dispatch_trip_financials f
       ON f.id=b.financial_id AND f.company_id=b.company_id
      AND f.order_id=b.order_id AND f.dispatch_id=b.dispatch_id
      AND b.snapshot_revision=f.snapshot_revision
    WHERE f.company_id=${s.companyId} AND f.order_id=${s.orderId}
      AND f.status='POSTED'
    ORDER BY b.bale_id
  `
  );
  return rows.map((r) => ({
    baleId: numberId(r.baleId),
    articleCode: String(r.articleCode),
    productName: String(r.productName),
    weightKg: String(r.weightKg),
    lineTotal: moneyText(r.lineTotal),
  }));
}

/** Caller locks parent order, dispatches and signed consolidation first. */
export async function loadCombinedInvoicePlanTx(tx: DbTransaction, s: OrderReconciliationScope): Promise<LoadedPlan> {
  const signedRows = await arr(
    tx,
    sql`
    SELECT id,status,reconciliation_fingerprint AS "fingerprint",
           included_posting_ids AS "postingIds",reconciled_at AS "reconciledAt",
           goods_subtotal::text AS goods,billable_charges_total::text AS billable,
           discount_total::text AS discounts,customer_total::text AS total
     FROM factory_dispatch_order_consolidations
    WHERE company_id=${s.companyId} AND order_id=${s.orderId} LIMIT 1
  `
  );
  const signed = signedRows[0];
  if (!signed || !signed.reconciledAt || signed.status !== "DRAFT") {
    raise(
      "COMBINED_INVOICE_RECONCILIATION_REQUIRED",
      "Approve the exact all-truck reconciliation before creating the combined invoice"
    );
  }
  const current = (await loadOrderDispatchReconciliationTx(tx, s)).result;
  const issues = [...current.blockingReasons];
  if (!current.ready || current.fingerprint !== signed.fingerprint) {
    issues.push("The approved all-truck fingerprint no longer matches live physical and financial evidence");
  }
  if (!sameIds(current.includedPostingIds, Array.isArray(signed.postingIds) ? signed.postingIds.map(String) : [])) {
    issues.push("Signed financial posting IDs no longer match the approved order");
  }
  for (const [name, a, b] of [
    ["goods", current.summary.goodsSubtotal, signed.goods],
    ["billable charges", current.summary.billableChargesTotal, signed.billable],
    ["discounts", current.summary.discountTotal, signed.discounts],
    ["customer total", current.summary.customerTotal, signed.total],
  ]) {
    if (!money(a).eq(money(b))) issues.push("Signed " + name + " changed");
  }
  const [order] = await arr(
    tx,
    sql`
    SELECT customer_id AS "customerId",status,invoice_number AS "invoiceNumber",
           deleted_at AS "deletedAt" FROM customer_orders
    WHERE id=${s.orderId} AND company_id=${s.companyId}
  `
  );
  if (
    !order ||
    order.deletedAt ||
    order.invoiceNumber ||
    !["LOADING", "PENDING_VERIFICATION"].includes(String(order.status))
  ) {
    issues.push("Original loading is already invoiced, cancelled or inactive");
  }
  const customerId = order ? numberId(order.customerId) : 0;
  const bales = await signedBalesTx(tx, s);
  if (bales.length !== current.summary.physicallyScannedBales) {
    issues.push("Signed financial bale count is not the exact total of shipped barcodes");
  }
  const unique = new Set(bales.map((b) => b.baleId));
  if (unique.size !== bales.length) issues.push("The same physical bale belongs to multiple invoice trips");
  if (!sumMoney(bales.map((b) => b.lineTotal)).eq(money(current.summary.goodsSubtotal))) {
    issues.push("Frozen bale prices no longer match signed invoiced goods");
  }
  const originals = await tx
    .select({
      id: customerOrderCharges.id,
      name: customerOrderCharges.name,
      chargeType: customerOrderCharges.chargeType,
      amount: customerOrderCharges.amount,
      ledgerAccountId: customerOrderCharges.ledgerAccountId,
      voucherId: customerOrderCharges.voucherId,
    })
    .from(customerOrderCharges)
    .where(eq(customerOrderCharges.orderId, s.orderId))
    .orderBy(customerOrderCharges.id);
  const originalCharges: OriginalCharge[] = [];
  for (const row of originals) {
    originalCharges.push(await verifyOriginalChargeTx(tx, s, customerId, row));
  }
  const originalTotal = sumMoney(originalCharges.map((c) => c.amount));
  if (!originalTotal.eq(money(current.summary.existingOrderChargeTotal))) {
    issues.push("Original order charges changed after signed reconciliation");
  }
  const finalTotal = money(current.summary.customerTotal).plus(originalTotal);
  if (finalTotal.lte(0)) issues.push("Final customer invoice must be positive");
  let cost = new MoneyDecimal(0);
  if (bales.length) {
    const ids = bales.map((b) => b.baleId);
    const physical = await arr(
      tx,
      sql`
      SELECT id,status,total_cost::text AS "totalCost"
      FROM factory_bales
      WHERE company_id=${s.companyId} AND id IN (${sql.join(
        ids.map((n) => sql`${n}`),
        sql`,`
      )})
      ORDER BY id
    `
    );
    if (physical.length !== bales.length) {
      issues.push("A signed physical bale is missing from this Factory company");
    } else {
      for (const b of physical) {
        if (["DELETED", "SOLD"].includes(String(b.status))) {
          issues.push("A signed physical bale was already sold or deleted before consolidation");
        }
        const c = String(b.totalCost ?? "");
        if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,7})?$/.test(c)) {
          issues.push("A signed bale has an invalid or missing 7-decimal inventory cost");
        } else cost = cost.plus(c);
      }
    }
  }
  const previewDate =
    "postingDate" in s && typeof s.postingDate === "string" ? s.postingDate : new Date().toISOString().slice(0, 10);
  const postCOGS = await isPerpetualInventoryActive(tx, s.companyId, previewDate);
  return {
    bales,
    customerId,
    plan: {
      fingerprint: String(signed.fingerprint),
      ready: issues.length === 0,
      blockingReasons: issues,
      tripCount: current.trips.length,
      postingIds: current.includedPostingIds,
      goodsSubtotal: current.summary.goodsSubtotal,
      tripBillableCharges: current.summary.billableChargesTotal,
      tripDiscounts: current.summary.discountTotal,
      tripCustomerTotal: current.summary.customerTotal,
      originalOrderCharges: originalTotal.toFixed(2),
      finalInvoiceTotal: finalTotal.toFixed(2),
      physicalBales: bales.length,
      totalCost: cost.toDecimalPlaces(2).toFixed(2),
      postCOGS,
      originalCharges,
      trips: current.trips.map((t) => ({
        dispatchId: t.dispatchId,
        dispatchNumber: t.dispatchNumber,
        postedBales: t.postedBales,
        customerTotal: t.customerTotal,
      })),
    },
  };
}

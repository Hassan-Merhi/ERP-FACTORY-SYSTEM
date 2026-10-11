/**
 * Retail goods received not invoiced, cleared by supplier invoices
 * (accounting audit phase 29, I6).
 *
 * A Retail receipt (and new-item intake) journals its value Dr
 * RETAIL-INVENTORY / Cr RETAIL-GRNI once the Retail inventory opening is
 * applied (retailInventoryJournal.ts), because Retail receipts name no
 * supplier. Nothing ever cleared RETAIL-GRNI, so it grew with every receipt
 * and no supplier payable existed.
 *
 *   GET  /api/retail/financial/grni-aging: the open receipts (journals that
 *        credit RETAIL-GRNI and no supplier invoice cleared yet), aged by
 *        days since their date on the company business date (0–30, 31–60,
 *        61–90, over 90), their total, the RETAIL-GRNI ledger balance and the
 *        difference between the two (what is cleared or posted otherwise).
 *   POST /api/retail/financial/supplier-invoices (Admin/Owner): a supplier
 *        invoice { supplierId, invoiceNumber, invoiceDate, amount,
 *        receiptVoucherIds } clears the named open receipts whole, in one
 *        transaction through the posting engine (balanced, closed-period
 *        checked, one posting identity per supplier and invoice number):
 *          Dr RETAIL-GRNI                    the receipts' received value
 *          Dr/Cr RETAIL-INVENTORY-ADJUSTMENT the price variance (invoice less
 *                                            received value; decided by
 *                                            default: the account that already
 *                                            takes Retail re-costing)
 *             Cr the supplier (supplier line)  the invoice amount
 *        A receipt is cleared once (unique), an invoice number once per
 *        supplier, the supplier must be the company's, the date not in the
 *        future. One audit row in the transaction.
 */
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { HttpError } from "../../lib/httpHandlers";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { postBalancedVoucherTx } from "../accounting/centralPostingEngine";
import { companyBusinessDate } from "../accounting/companyBusinessDate";
import { createDatabasePostingDependencies } from "../accounting/databasePostingDependencies";
import { RETAIL_GRNI_ACCOUNT, RETAIL_INVENTORY_ADJUSTMENT_ACCOUNT } from "./retailInventoryJournal";
import { cents, retailSystemAccountIdsTx } from "./retailLedgerPosting";

const postingDependencies = createDatabasePostingDependencies();

export const RETAIL_SUPPLIER_INVOICE_MESSAGES = {
  SUPPLIER_NOT_FOUND: "The supplier does not belong to this company.",
  RECEIPTS_REQUIRED: "Choose the received-not-invoiced receipts this invoice clears.",
  RECEIPT_NOT_OPEN: "A chosen receipt is not an open received-not-invoiced receipt of this company.",
  DUPLICATE_INVOICE: "This supplier invoice number is already recorded.",
  FUTURE_DATE: "The invoice date cannot be in the future.",
  INVALID_AMOUNT: "The invoice amount must be positive.",
} as const;
export type RetailSupplierInvoiceCode = keyof typeof RETAIL_SUPPLIER_INVOICE_MESSAGES;

export class RetailSupplierInvoiceRefusal extends HttpError {
  constructor(
    readonly code: RetailSupplierInvoiceCode,
    readonly receiptVoucherIds: number[] = []
  ) {
    super(
      code === "DUPLICATE_INVOICE" || code === "RECEIPT_NOT_OPEN" ? 409 : code === "SUPPLIER_NOT_FOUND" ? 404 : 400,
      RETAIL_SUPPLIER_INVOICE_MESSAGES[code]
    );
    this.name = "RetailSupplierInvoiceRefusal";
  }
  get body() {
    return {
      code: this.code,
      message: this.message,
      ...(this.receiptVoucherIds.length ? { receiptVoucherIds: this.receiptVoucherIds } : {}),
    };
  }
}

async function rows<T>(executor: DatabaseOrTransaction, query: ReturnType<typeof sql>): Promise<T[]> {
  return (await executor.execute(query)).rows as unknown as T[];
}

export interface GrniOpenReceipt {
  voucherId: number;
  voucherNumber: string;
  date: string;
  amount: string;
  ageDays: number;
}

async function grniAccountIdTx(executor: DatabaseOrTransaction, companyId: number): Promise<number | null> {
  const [account] = await rows<{ id: number }>(
    executor,
    sql`SELECT id FROM ledger_accounts WHERE company_id = ${companyId} AND code = ${RETAIL_GRNI_ACCOUNT}
           AND deleted_at IS NULL ORDER BY id LIMIT 1`
  );
  return account ? Number(account.id) : null;
}

/** The open received-not-invoiced receipts (see the module comment). */
export async function retailGrniOpenReceipts(
  executor: DatabaseOrTransaction,
  companyId: number,
  onlyIds?: number[]
): Promise<GrniOpenReceipt[]> {
  const accountId = await grniAccountIdTx(executor, companyId);
  if (accountId === null) return [];
  const today = await companyBusinessDate(companyId, executor);
  const filter = onlyIds?.length ? sql`AND v.id = ANY(${`{${onlyIds.map(Number).join(",")}}`}::int[])` : sql``;
  const found = await rows<{ id: number; voucher_number: string; date: string; amount: string; age: number }>(
    executor,
    sql`
      SELECT v.id, v.voucher_number, COALESCE(v.effective_date, v.voucher_date)::text AS date,
             SUM(ve.credit_amount - ve.debit_amount)::text AS amount,
             (${today}::date - COALESCE(v.effective_date, v.voucher_date))::int AS age
        FROM vouchers v
        JOIN voucher_entries ve ON ve.voucher_id = v.id AND ve.ledger_account_id = ${accountId}
       WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
         AND NOT EXISTS (SELECT 1 FROM retail_supplier_invoice_receipts r WHERE r.receipt_voucher_id = v.id)
         AND NOT EXISTS (SELECT 1 FROM retail_supplier_invoices i WHERE i.voucher_id = v.id)
         ${filter}
       GROUP BY v.id
      HAVING SUM(ve.credit_amount - ve.debit_amount) > 0
       ORDER BY 3, v.id
    `
  );
  return found.map((row) => ({
    voucherId: Number(row.id),
    voucherNumber: row.voucher_number,
    date: row.date,
    amount: toMoney(row.amount).toFixed(2),
    ageDays: Number(row.age),
  }));
}

export interface GrniAging {
  companyId: number;
  asOf: string;
  receipts: GrniOpenReceipt[];
  buckets: Array<{ bucket: "0-30" | "31-60" | "61-90" | "over-90"; receipts: number; amount: string }>;
  openTotal: string;
  ledgerBalance: string;
  /** Ledger credit balance less the open receipts: cleared or posted outside the receipts. */
  difference: string;
}

export async function retailGrniAging(companyId: number, executor: DatabaseOrTransaction = db): Promise<GrniAging> {
  const receipts = await retailGrniOpenReceipts(executor, companyId);
  const bucketOf = (age: number) => (age <= 30 ? "0-30" : age <= 60 ? "31-60" : age <= 90 ? "61-90" : "over-90");
  const buckets = (["0-30", "31-60", "61-90", "over-90"] as const).map((bucket) => {
    const inBucket = receipts.filter((receipt) => bucketOf(receipt.ageDays) === bucket);
    return {
      bucket,
      receipts: inBucket.length,
      amount: inBucket.reduce((sum, receipt) => sum.plus(receipt.amount), new MoneyDecimal(0)).toFixed(2),
    };
  });
  const openTotal = receipts.reduce((sum, receipt) => sum.plus(receipt.amount), new MoneyDecimal(0));
  const accountId = await grniAccountIdTx(executor, companyId);
  let ledger: Decimal = new MoneyDecimal(0);
  if (accountId !== null) {
    const [row] = await rows<{ balance: string }>(
      executor,
      sql`SELECT COALESCE(SUM(ve.credit_amount - ve.debit_amount), 0)::text AS balance
            FROM voucher_entries ve JOIN vouchers v ON v.id = ve.voucher_id
           WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND COALESCE(v.optional, false) = false
             AND ve.ledger_account_id = ${accountId}`
    );
    ledger = toMoney(row?.balance ?? 0);
  }
  return {
    companyId,
    asOf: await companyBusinessDate(companyId, executor),
    receipts,
    buckets,
    openTotal: openTotal.toFixed(2),
    ledgerBalance: ledger.toFixed(2),
    difference: ledger.minus(openTotal).toFixed(2),
  };
}

export interface RetailSupplierInvoiceInput {
  supplierId: number;
  invoiceNumber: string;
  invoiceDate: string;
  amount: string;
  receiptVoucherIds: number[];
  actor: { userId: string; username: string };
}

export async function postRetailSupplierInvoice(companyId: number, input: RetailSupplierInvoiceInput) {
  const amount = cents(input.amount);
  if (!amount.gt(0)) throw new RetailSupplierInvoiceRefusal("INVALID_AMOUNT");
  const receiptIds = [...new Set(input.receiptVoucherIds.map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (receiptIds.length === 0) throw new RetailSupplierInvoiceRefusal("RECEIPTS_REQUIRED");
  return db.transaction(async (tx: DbTransaction) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('retail_supplier_invoice'), ${companyId})`);
    if (input.invoiceDate > (await companyBusinessDate(companyId, tx))) {
      throw new RetailSupplierInvoiceRefusal("FUTURE_DATE");
    }
    const [supplier] = await rows<{ id: number; legal_name: string }>(
      tx,
      sql`SELECT id, legal_name FROM suppliers
           WHERE id = ${input.supplierId} AND company_id = ${companyId} AND deleted_at IS NULL`
    );
    if (!supplier) throw new RetailSupplierInvoiceRefusal("SUPPLIER_NOT_FOUND");
    const [duplicate] = await rows<{ id: number }>(
      tx,
      sql`SELECT id FROM retail_supplier_invoices
           WHERE company_id = ${companyId} AND supplier_id = ${input.supplierId} AND invoice_number = ${input.invoiceNumber}`
    );
    if (duplicate) throw new RetailSupplierInvoiceRefusal("DUPLICATE_INVOICE");
    const open = await retailGrniOpenReceipts(tx, companyId, receiptIds);
    const missing = receiptIds.filter((id) => !open.some((receipt) => receipt.voucherId === id));
    if (missing.length > 0) throw new RetailSupplierInvoiceRefusal("RECEIPT_NOT_OPEN", missing);
    const grni = open.reduce((sum, receipt) => sum.plus(receipt.amount), new MoneyDecimal(0));
    const variance = amount.minus(grni);
    const accounts = await retailSystemAccountIdsTx(tx, companyId, [
      RETAIL_GRNI_ACCOUNT,
      RETAIL_INVENTORY_ADJUSTMENT_ACCOUNT,
    ]);
    const [company] = await rows<{ base_currency: string | null }>(
      tx,
      sql`SELECT base_currency FROM companies WHERE id = ${companyId}`
    );
    const currency = String(company?.base_currency || "USD")
      .slice(0, 3)
      .toUpperCase();
    const narration = `Supplier invoice ${input.invoiceNumber} - ${supplier.legal_name}`;
    const entries = [
      {
        ledgerAccountId: accounts.get(RETAIL_GRNI_ACCOUNT)!,
        debitAmount: grni.toFixed(2),
        creditAmount: "0",
        narration: `${narration}: received not invoiced cleared`,
      },
      ...(variance.isZero()
        ? []
        : [
            {
              ledgerAccountId: accounts.get(RETAIL_INVENTORY_ADJUSTMENT_ACCOUNT)!,
              debitAmount: variance.isPositive() ? variance.toFixed(2) : "0",
              creditAmount: variance.isNegative() ? variance.negated().toFixed(2) : "0",
              narration: `${narration}: price variance`,
            },
          ]),
      { supplierId: Number(supplier.id), debitAmount: "0", creditAmount: amount.toFixed(2), narration },
    ];
    const sourceId = `${companyId}:${supplier.id}:${input.invoiceNumber}`;
    const posted = await postBalancedVoucherTx(
      tx,
      {
        voucher: {
          companyId,
          voucherType: "Purchase",
          voucherDate: input.invoiceDate,
          totalAmount: grni.plus(variance.isPositive() ? variance : 0).toFixed(2),
          description: narration,
          currency,
          sourceModule: "Retail",
        },
        entries,
        source: {
          sourceType: "retail-supplier-invoice",
          sourceId,
          idempotencyKey: `retail-supplier-invoice:${sourceId}`,
        },
        actor: { userId: input.actor.userId, username: input.actor.username, reason: "Retail supplier invoice" },
      },
      postingDependencies
    );
    const voucherId = posted.voucher.id;
    const [invoice] = await rows<{ id: number }>(
      tx,
      sql`
        INSERT INTO retail_supplier_invoices
          (company_id, supplier_id, invoice_number, invoice_date, amount, grni_cleared, variance, voucher_id, created_by)
        VALUES (${companyId}, ${supplier.id}, ${input.invoiceNumber}, ${input.invoiceDate}::date, ${amount.toFixed(2)},
                ${grni.toFixed(2)}, ${variance.toFixed(2)}, ${voucherId}, ${input.actor.username})
        RETURNING id
      `
    );
    for (const receipt of open) {
      await tx.execute(sql`
        INSERT INTO retail_supplier_invoice_receipts (company_id, invoice_id, receipt_voucher_id, amount)
        VALUES (${companyId}, ${invoice.id}, ${receipt.voucherId}, ${receipt.amount})
      `);
    }
    await writeAuditEvent(
      {
        userId: input.actor.userId,
        username: input.actor.username,
        companyId,
        action: "create",
        tableName: "retail_supplier_invoices",
        recordId: invoice.id,
        recordIdentifier: `retail-supplier-invoice:${input.invoiceNumber}`,
        changes: {
          invoice: {
            old: null,
            new: {
              supplierId: supplier.id,
              invoiceNumber: input.invoiceNumber,
              invoiceDate: input.invoiceDate,
              amount: amount.toFixed(2),
              grniCleared: grni.toFixed(2),
              variance: variance.toFixed(2),
              voucherId,
              receipts: open.map((receipt) => ({ voucherId: receipt.voucherId, amount: receipt.amount })),
            },
          },
        },
      },
      tx
    );
    return {
      invoiceId: invoice.id,
      voucherId,
      grniCleared: grni.toFixed(2),
      variance: variance.toFixed(2),
      receipts: open,
    };
  });
}

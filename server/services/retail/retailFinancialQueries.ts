import { and, asc, eq, isNull } from "drizzle-orm";
import { bankAccounts, ledgerAccounts, posShifts, retailCashMovements, retailPosPayments } from "@shared/schema";
import { db, pool } from "../../db";

/** Read-only Retail payment, shift and reconciliation queries. */

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function loadRetailSalePayments(companyId: number, saleId: number) {
  const rows = await db
    .select()
    .from(retailPosPayments)
    .where(and(eq(retailPosPayments.companyId, companyId), eq(retailPosPayments.saleId, saleId)))
    .orderBy(asc(retailPosPayments.id));
  return rows.map((row) => ({
    id: row.id,
    method: row.method,
    paymentType: row.paymentType,
    amount: toNumber(row.amount),
    tenderedAmount: row.tenderedAmount == null ? null : toNumber(row.tenderedAmount),
    changeAmount: toNumber(row.changeAmount),
    reference: row.reference,
    shiftId: row.shiftId,
  }));
}

export async function getRetailShiftSummary(companyId: number, shiftId: number) {
  const [shift] = await db
    .select()
    .from(posShifts)
    .where(and(eq(posShifts.id, shiftId), eq(posShifts.companyId, companyId)))
    .limit(1);
  if (!shift) throw new Error("Shift not found");
  const payments = await db
    .select()
    .from(retailPosPayments)
    .where(and(eq(retailPosPayments.companyId, companyId), eq(retailPosPayments.shiftId, shiftId)));
  const movements = await db
    .select()
    .from(retailCashMovements)
    .where(and(eq(retailCashMovements.companyId, companyId), eq(retailCashMovements.shiftId, shiftId)));

  const methods: Record<string, number> = {};
  let cashSales = 0;
  let cashRefunds = 0;
  const saleIds = new Set<number>();
  for (const payment of payments) {
    const signed = payment.paymentType === "refund" ? -toNumber(payment.amount) : toNumber(payment.amount);
    methods[payment.method] = (methods[payment.method] ?? 0) + signed;
    if (payment.paymentType === "payment") saleIds.add(payment.saleId);
    if (payment.method === "cash") {
      if (payment.paymentType === "refund") cashRefunds += toNumber(payment.amount);
      else cashSales += toNumber(payment.amount);
    }
  }
  let cashIn = 0;
  let cashOut = 0;
  for (const movement of movements) {
    if (movement.movementType === "cash_in") cashIn += toNumber(movement.amount);
    else cashOut += toNumber(movement.amount);
  }
  const openingCash = toNumber(shift.openingCash);
  const expectedCash = openingCash + cashSales - cashRefunds + cashIn - cashOut;
  return {
    shift,
    salesCount: saleIds.size,
    paymentMethods: methods,
    cashSales,
    cashRefunds,
    cashIn,
    cashOut,
    expectedCash,
  };
}

export async function listRetailFinancialAccounts(companyId: number) {
  const [ledgers, banks] = await Promise.all([
    db
      .select({
        id: ledgerAccounts.id,
        code: ledgerAccounts.code,
        name: ledgerAccounts.name,
        accountType: ledgerAccounts.accountType,
      })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt)))
      .orderBy(ledgerAccounts.name),
    db
      .select({ id: bankAccounts.id, code: bankAccounts.code, name: bankAccounts.name })
      .from(bankAccounts)
      .where(and(eq(bankAccounts.companyId, companyId), isNull(bankAccounts.deletedAt)))
      .orderBy(bankAccounts.name),
  ]);
  return { ledgers, banks };
}

export async function getRetailFinancialReconciliation(
  companyId: number,
  input: { locationId?: number | null; from?: Date | null; to?: Date | null }
) {
  const params: unknown[] = [companyId];
  const clauses = ["s.company_id = $1"];
  if (input.locationId) {
    params.push(input.locationId);
    clauses.push(`s.location_id = $${params.length}`);
  }
  if (input.from) {
    params.push(input.from);
    clauses.push(`s.created_at >= $${params.length}`);
  }
  if (input.to) {
    params.push(input.to);
    clauses.push(`s.created_at < $${params.length}`);
  }

  const result = await pool.query<Record<string, unknown>>(
    `SELECT
       s.id AS sale_id,
       s.location_id,
       s.status,
       s.total_amount,
       s.accounting_voucher_id,
       s.created_at,
       COALESCE((
         SELECT SUM(p.amount)
         FROM retail_pos_payments p
         WHERE p.company_id = s.company_id
           AND p.sale_id = s.id
           AND p.payment_type = 'payment'
       ), 0) AS payments,
       COALESCE((
         SELECT SUM(p.amount)
         FROM retail_pos_payments p
         WHERE p.company_id = s.company_id
           AND p.sale_id = s.id
           AND p.payment_type = 'refund'
       ), 0) AS refunds
     FROM retail_pos_sales s
     WHERE ${clauses.join(" AND ")}
     ORDER BY s.created_at DESC
     LIMIT 500`,
    params
  );

  const mapped = result.rows.map((row) => {
    const total = toNumber(row.total_amount);
    const paid = toNumber(row.payments);
    const refunded = toNumber(row.refunds);
    const expectedNet = row.status === "canceled" ? 0 : total - refunded;
    const actualNet = paid - refunded;
    const paymentMismatch = Math.abs(actualNet - expectedNet) > 0.000001;
    const accountingMissing = Number(row.accounting_voucher_id ?? 0) <= 0 && total !== 0;
    return {
      ...row,
      totalAmount: total,
      payments: paid,
      refunds: refunded,
      paymentMismatch,
      accountingMissing,
    };
  });
  return {
    rows: mapped,
    summary: {
      sales: mapped.length,
      paymentMismatches: mapped.filter((row) => row.paymentMismatch).length,
      missingAccounting: mapped.filter((row) => row.accountingMissing).length,
    },
  };
}

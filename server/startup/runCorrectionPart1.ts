// Extracted from ./runApprovedHadiPrepaidRepair.ts
import { sql } from "drizzle-orm";
import { type DbTransaction } from "../db";
import { toMoney } from "../lib/money";
import { companyBusinessDate } from "../services/accounting/companyBusinessDate";

export const COMPANY = 12;

export const CONTRACT = 34;

export const EXPENSE_ACCOUNT = 868;

export const VOUCHER_NUMBER = "FACTORY-RENT-PREPAID-HADI34-20261103";

export type Row = Record<string, unknown>;

export const num = (value: unknown) => Number(value);

export const money = (value: unknown) => toMoney(String(value ?? 0)).toFixed(2);

export function requireMatch(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error("HADI_PREPAID_REPAIR_" + code);
}

export async function runCorrectionPart1(tx: DbTransaction) {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('hmd12-hadi34-prepaid-20261103'))`);
  const asOf = await companyBusinessDate(COMPANY, tx);
  const company = (
    await tx.execute(sql`
    SELECT id, name, active FROM companies WHERE id = ${COMPANY}
  `)
  ).rows as Row[];
  requireMatch(
    company.length === 1 && company[0].name === "HMD INT GROUP - BEIRUT" && company[0].active === true,
    "COMPANY_CHANGED"
  );

  const original = (
    await tx.execute(sql`
    SELECT v.id, v.voucher_number, v.voucher_type, v.voucher_date::text AS voucher_date,
      v.deleted_at, v.optional, v.currency, e.ledger_account_id, e.debit_amount, e.credit_amount
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
    WHERE v.company_id = ${COMPANY} AND v.id = 10550
    ORDER BY e.id FOR SHARE OF v, e
  `)
  ).rows as Row[];
  requireMatch(
    original.length === 2 &&
      original.every(
        (r) =>
          r.deleted_at == null &&
          r.optional === false &&
          r.voucher_type === "Payment" &&
          r.currency === "USD" &&
          String(r.voucher_date).slice(0, 10) === "2026-07-13"
      ) &&
      original.some(
        (r) =>
          num(r.ledger_account_id) === EXPENSE_ACCOUNT &&
          money(r.debit_amount) === "15000.00" &&
          money(r.credit_amount) === "0.00"
      ) &&
      original.some(
        (r) =>
          num(r.ledger_account_id) === 707 && money(r.debit_amount) === "0.00" && money(r.credit_amount) === "15000.00"
      ),
    "ORIGINAL_RECEIPT_CHANGED"
  );

  const contract = (
    await tx.execute(sql`
    SELECT c.id, c.status, c.tenant_name, c.rental_amount, c.currency, c.start_date::text AS start_date,
      u.id AS unit_id, u.unit_number, u.unit_type, u.active, u.module
    FROM property_contracts c JOIN property_units u ON u.id = c.unit_id
    WHERE c.company_id = ${COMPANY} AND c.id = ${CONTRACT} FOR SHARE OF c, u
  `)
  ).rows as Row[];
  requireMatch(
    contract.length === 1 &&
      contract[0].status === "ACTIVE" &&
      contract[0].tenant_name === "HADI DAKIK" &&
      contract[0].unit_number === "FAMILY APPARMENT" &&
      num(contract[0].unit_id) === 55 &&
      contract[0].unit_type === "SHOP" &&
      contract[0].module === "FACTORY" &&
      contract[0].active === true &&
      contract[0].currency === "USD" &&
      money(contract[0].rental_amount) === "2500.00" &&
      String(contract[0].start_date).slice(0, 10) === "2026-07-15",
    "CONTRACT_CHANGED"
  );

  const payments = (
    await tx.execute(sql`
    SELECT p.id, p.contract_id, p.voucher_id, p.ledger_row_id, p.payment_date::text AS payment_date,
      p.posting_status, p.amount, p.for_year, p.for_month
    FROM property_payments p WHERE p.company_id = ${COMPANY} AND p.contract_id = ${CONTRACT}
    ORDER BY p.for_year, p.for_month, p.id FOR SHARE OF p
  `)
  ).rows as Row[];
  requireMatch(
    payments.length === 6 &&
      payments.every(
        (p, i) =>
          num(p.id) === 297 + i &&
          num(p.voucher_id) === 10550 &&
          num(p.contract_id) === CONTRACT &&
          num(p.for_year) === 2026 &&
          num(p.for_month) === 7 + i &&
          num(p.ledger_row_id) === 695942 + i &&
          String(p.payment_date).slice(0, 10) === "2026-07-13" &&
          p.posting_status === "POSTED" &&
          money(p.amount) === "2500.00"
      ),
    "SOURCE_PAYMENTS_CHANGED"
  );

  const months = (
    await tx.execute(sql`
    SELECT id, contract_id, year, month, expected_amount, paid_amount,
      used_prepaid_account, used_advance_account, accrual_voucher_id
    FROM property_monthly_ledger
    WHERE company_id = ${COMPANY} AND contract_id = ${CONTRACT}
      AND year = 2026 AND month IN (11, 12)
    ORDER BY month FOR UPDATE
  `)
  ).rows as Row[];
  requireMatch(
    months.length === 2 &&
      months.every(
        (m, i) =>
          num(m.id) === 695946 + i &&
          num(m.contract_id) === CONTRACT &&
          num(m.year) === 2026 &&
          num(m.month) === 11 + i &&
          money(m.expected_amount) === "2500.00" &&
          money(m.paid_amount) === "2500.00" &&
          m.used_advance_account === false
      ),
    "MONTH_ROWS_CHANGED"
  );

  const priorRepair = (
    await tx.execute(sql`
    SELECT v.id, v.deleted_at, v.optional, v.voucher_type, v.currency,
      e.ledger_account_id, e.debit_amount, e.credit_amount
    FROM vouchers v JOIN voucher_entries e ON e.voucher_id = v.id
    WHERE v.company_id = ${COMPANY} AND v.voucher_number = ${VOUCHER_NUMBER}
    ORDER BY e.id FOR SHARE OF v, e
  `)
  ).rows as Row[];
  return { asOf, months, priorRepair };
}

import { sql } from "drizzle-orm";
import type { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { classifyVoucherLedgerExpectation } from "./voucherLedgerExpectation";
import {
  auditPhase3Accounting,
  Phase3AccountingAuditError,
  type DuplicateEntryGroup,
  type PaymentAuditSnapshot,
  type Phase3AccountingAuditInput,
  type Phase3AccountingAuditReport,
  type PayrollAuditSnapshot,
  type SaleAuditSnapshot,
  type StockAccountingAuditSnapshot,
  type VoucherAuditSnapshot,
} from "./phase3AccountingAudit";

type DrizzleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type CompanyRow = { company_type: string | null };
type VoucherRow = {
  voucher_id: number;
  voucher_type: string;
  currency: string | null;
  total_amount: string;
  deleted_at: Date | string | null;
  base_debit: string;
  base_credit: string;
  tx_debit: string;
  tx_credit: string;
  cash_tx_debit: string;
  cash_tx_credit: string;
};
type SaleRow = {
  voucher_id: number;
  total_amount: string;
  deleted_at: Date | string | null;
  revenue_credit: string;
  sold_quantity: string;
  cogs_value: string;
  movement_quantity: string;
  movement_value: string;
};
type PayrollRow = {
  payroll_id: number;
  status: string;
  net_salary: string;
  cash_account_id: number | null;
  payment_voucher_count: number;
  payment_voucher_total: string;
  payment_debit: string;
  payment_credit: string;
  payment_cash_credit: string;
  daybook_count: number;
  daybook_amount: string;
};
type StockRow = {
  operational_value: string;
  accounting_value: string;
  inventory_account_count: number;
};
type DuplicateRow = {
  voucher_id: number;
  signature: string;
  occurrences: number;
};

function asPositiveInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Phase3AccountingAuditError("PHASE3_DATABASE_ROW_INVALID", `${field} must be a positive integer`);
  }
  return parsed;
}

function asNonNegativeInteger(value: unknown, field: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Phase3AccountingAuditError("PHASE3_DATABASE_ROW_INVALID", `${field} must be a non-negative integer`);
  }
  return parsed;
}

function asDecimal(value: unknown, field: string): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new Phase3AccountingAuditError("PHASE3_DATABASE_ROW_INVALID", `${field} is required`);
  }
  return normalized;
}

/**
 * Load every Phase 3 reconciliation surface from one company-scoped database snapshot.
 * The caller is expected to run this inside the same repeatable-read company transaction
 * used by scheduled convergence reconciliation.
 */
export async function loadDatabasePhase3AccountingAudit(input: {
  tx: DrizzleTransaction;
  companyId: number;
}): Promise<Phase3AccountingAuditInput> {
  const { tx, companyId } = input;
  asPositiveInteger(companyId, "companyId");

  const companyResult = await tx.execute(sql`
    SELECT company_type
    FROM companies
    WHERE id = ${companyId}
    LIMIT 1
  `);
  const company = resultRows<CompanyRow>(companyResult)[0];
  if (!company) {
    throw new Phase3AccountingAuditError("PHASE3_COMPANY_MISSING", `Company ${companyId} was not found`);
  }
  const isSupplierPartner = String(company.company_type ?? "").toLowerCase() === "supplier_partner";

  const voucherResult = await tx.execute(sql`
    SELECT
      v.id AS voucher_id,
      v.voucher_type,
      v.currency,
      v.total_amount,
      v.deleted_at,
      COALESCE(SUM(COALESCE(ve.base_debit_amount, ve.debit_amount, 0)), 0)::text AS base_debit,
      COALESCE(SUM(COALESCE(ve.base_credit_amount, ve.credit_amount, 0)), 0)::text AS base_credit,
      COALESCE(SUM(COALESCE(ve.transaction_debit_amount, ve.base_debit_amount, ve.debit_amount, 0)), 0)::text AS tx_debit,
      COALESCE(SUM(COALESCE(ve.transaction_credit_amount, ve.base_credit_amount, ve.credit_amount, 0)), 0)::text AS tx_credit,
      COALESCE(SUM(
        CASE
          WHEN ve.bank_account_id IS NOT NULL
            OR lower(COALESCE(la.account_type, '')) IN ('cash', 'bank')
          THEN COALESCE(ve.transaction_debit_amount, ve.base_debit_amount, ve.debit_amount, 0)
          ELSE 0
        END
      ), 0)::text AS cash_tx_debit,
      COALESCE(SUM(
        CASE
          WHEN ve.bank_account_id IS NOT NULL
            OR lower(COALESCE(la.account_type, '')) IN ('cash', 'bank')
          THEN COALESCE(ve.transaction_credit_amount, ve.base_credit_amount, ve.credit_amount, 0)
          ELSE 0
        END
      ), 0)::text AS cash_tx_credit
    FROM vouchers v
    LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
    LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
    WHERE v.company_id = ${companyId}
    GROUP BY v.id, v.voucher_type, v.currency, v.total_amount, v.deleted_at
    ORDER BY v.id
  `);
  const voucherRows = resultRows<VoucherRow>(voucherResult);

  const vouchers: VoucherAuditSnapshot[] = [];
  const payments: PaymentAuditSnapshot[] = [];
  for (const row of voucherRows) {
    const voucherId = asPositiveInteger(row.voucher_id, "voucher.voucherId");
    const voucherType = String(row.voucher_type ?? "").trim();
    const totalAmount = asDecimal(row.total_amount, `voucher:${voucherId}.totalAmount`);
    const baseDebit = asDecimal(row.base_debit, `voucher:${voucherId}.baseDebit`);
    const baseCredit = asDecimal(row.base_credit, `voucher:${voucherId}.baseCredit`);
    const txDebit = asDecimal(row.tx_debit, `voucher:${voucherId}.txDebit`);
    const txCredit = asDecimal(row.tx_credit, `voucher:${voucherId}.txCredit`);
    const isErpPosSale = voucherType === "Sales";

    vouchers.push({
      voucherId,
      voucherType,
      totalAmount,
      ledgerDebit: baseDebit,
      ledgerCredit: baseCredit,
      // Generic ERP POS stores its voucher header in USD even when its display
      // currency is CFA/EUR; other non-USD vouchers store the transaction amount.
      documentDebit: isErpPosSale ? baseDebit : txDebit,
      documentCredit: isErpPosSale ? baseCredit : txCredit,
      ledgerExpectation: classifyVoucherLedgerExpectation(voucherType),
      cancelled: row.deleted_at != null,
    });

    if (voucherType === "Payment" || voucherType === "Receipt") {
      payments.push({
        voucherId,
        voucherType,
        totalAmount,
        ledgerDebit: baseDebit,
        ledgerCredit: baseCredit,
        cashDebit: asDecimal(row.cash_tx_debit, `payment:${voucherId}.cashDebit`),
        cashCredit: asDecimal(row.cash_tx_credit, `payment:${voucherId}.cashCredit`),
        cancelled: row.deleted_at != null,
      });
    }
  }

  const salesResult = await tx.execute(sql`
    WITH sale_items AS (
      SELECT
        si.voucher_id,
        COALESCE(SUM(si.quantity), 0) AS sold_quantity,
        COALESCE(SUM(si.total_cost), 0) AS cogs_value
      FROM sales_items si
      JOIN vouchers v ON v.id = si.voucher_id
      WHERE v.company_id = ${companyId}
      GROUP BY si.voucher_id
    ), movements AS (
      SELECT
        csm.source_id,
        COALESCE(SUM(csm.quantity_delta), 0) AS movement_quantity,
        COALESCE(SUM(csm.quantity_delta * csm.unit_cost), 0) AS movement_value
      FROM canonical_stock_movements csm
      WHERE csm.company_id = ${companyId}
        AND csm.source_type = 'pos-sale'
      GROUP BY csm.source_id
    ), revenue AS (
      SELECT
        ve.voucher_id,
        COALESCE(SUM(
          CASE
            WHEN lower(COALESCE(la.account_type, '')) = 'income'
              OR upper(COALESCE(la.code, '')) IN ('SALES', 'SALES_REV')
            THEN COALESCE(ve.base_credit_amount, ve.credit_amount, 0)
            ELSE 0
          END
        ), 0) AS revenue_credit
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
      LEFT JOIN ledger_accounts la ON la.id = ve.ledger_account_id
      WHERE v.company_id = ${companyId}
      GROUP BY ve.voucher_id
    )
    SELECT
      v.id AS voucher_id,
      v.total_amount::text AS total_amount,
      v.deleted_at,
      COALESCE(r.revenue_credit, 0)::text AS revenue_credit,
      COALESCE(si.sold_quantity, 0)::text AS sold_quantity,
      COALESCE(si.cogs_value, 0)::text AS cogs_value,
      m.movement_quantity::text AS movement_quantity,
      m.movement_value::text AS movement_value
    FROM vouchers v
    JOIN movements m ON m.source_id = v.id::text
    LEFT JOIN sale_items si ON si.voucher_id = v.id
    LEFT JOIN revenue r ON r.voucher_id = v.id
    WHERE v.company_id = ${companyId}
      AND v.voucher_type = 'Sales'
    ORDER BY v.id
  `);
  const sales: SaleAuditSnapshot[] = resultRows<SaleRow>(salesResult).map((row) => {
    const voucherId = asPositiveInteger(row.voucher_id, "sale.voucherId");
    return {
      voucherId,
      totalAmount: asDecimal(row.total_amount, `sale:${voucherId}.totalAmount`),
      revenueCredit: asDecimal(row.revenue_credit, `sale:${voucherId}.revenueCredit`),
      revenueRequired: !isSupplierPartner,
      soldQuantity: asDecimal(row.sold_quantity, `sale:${voucherId}.soldQuantity`),
      recordedCogsValue: asDecimal(row.cogs_value, `sale:${voucherId}.cogsValue`),
      inventoryMovementQuantity: asDecimal(row.movement_quantity, `sale:${voucherId}.movementQuantity`),
      inventoryMovementValue: asDecimal(row.movement_value, `sale:${voucherId}.movementValue`),
      cancelled: row.deleted_at != null,
    };
  });

  const payrollResult = await tx.execute(sql`
    SELECT
      p.id AS payroll_id,
      p.status,
      p.net_salary::text AS net_salary,
      p.cash_account_id,
      (
        SELECT COUNT(*)::int
        FROM vouchers pv
        WHERE pv.company_id = p.company_id
          AND pv.deleted_at IS NULL
          AND pv.voucher_type = 'Payment'
          AND pv.voucher_number LIKE ('PAYMENT-PAY-' || p.id::text || '-%')
      ) AS payment_voucher_count,
      COALESCE((
        SELECT SUM(pv.total_amount)
        FROM vouchers pv
        WHERE pv.company_id = p.company_id
          AND pv.deleted_at IS NULL
          AND pv.voucher_type = 'Payment'
          AND pv.voucher_number LIKE ('PAYMENT-PAY-' || p.id::text || '-%')
      ), 0)::text AS payment_voucher_total,
      COALESCE((
        SELECT SUM(COALESCE(ve.base_debit_amount, ve.debit_amount, 0))
        FROM voucher_entries ve
        JOIN vouchers pv ON pv.id = ve.voucher_id
        WHERE pv.company_id = p.company_id
          AND pv.deleted_at IS NULL
          AND pv.voucher_type = 'Payment'
          AND pv.voucher_number LIKE ('PAYMENT-PAY-' || p.id::text || '-%')
      ), 0)::text AS payment_debit,
      COALESCE((
        SELECT SUM(COALESCE(ve.base_credit_amount, ve.credit_amount, 0))
        FROM voucher_entries ve
        JOIN vouchers pv ON pv.id = ve.voucher_id
        WHERE pv.company_id = p.company_id
          AND pv.deleted_at IS NULL
          AND pv.voucher_type = 'Payment'
          AND pv.voucher_number LIKE ('PAYMENT-PAY-' || p.id::text || '-%')
      ), 0)::text AS payment_credit,
      COALESCE((
        SELECT SUM(COALESCE(ve.base_credit_amount, ve.credit_amount, 0))
        FROM voucher_entries ve
        JOIN vouchers pv ON pv.id = ve.voucher_id
        WHERE pv.company_id = p.company_id
          AND pv.deleted_at IS NULL
          AND pv.voucher_type = 'Payment'
          AND pv.voucher_number LIKE ('PAYMENT-PAY-' || p.id::text || '-%')
          AND ve.ledger_account_id = p.cash_account_id
      ), 0)::text AS payment_cash_credit,
      (
        SELECT COUNT(*)::int
        FROM factory_daybook_entries d
        WHERE d.company_id = p.company_id
          AND d.reference_table = 'factory_payrolls'
          AND d.reference_id = p.id
          AND d.tx_type = 'PAYROLL_PAYMENT'
      ) AS daybook_count,
      COALESCE((
        SELECT SUM(d.amount_usd)
        FROM factory_daybook_entries d
        WHERE d.company_id = p.company_id
          AND d.reference_table = 'factory_payrolls'
          AND d.reference_id = p.id
          AND d.tx_type = 'PAYROLL_PAYMENT'
      ), 0)::text AS daybook_amount
    FROM factory_payrolls p
    WHERE p.company_id = ${companyId}
      AND (
        upper(COALESCE(p.status, '')) = 'PAID'
        OR EXISTS (
          SELECT 1
          FROM vouchers pv
          WHERE pv.company_id = p.company_id
            AND pv.deleted_at IS NULL
            AND pv.voucher_type = 'Payment'
            AND pv.voucher_number LIKE ('PAYMENT-PAY-' || p.id::text || '-%')
        )
        OR EXISTS (
          SELECT 1
          FROM factory_daybook_entries d
          WHERE d.company_id = p.company_id
            AND d.reference_table = 'factory_payrolls'
            AND d.reference_id = p.id
            AND d.tx_type = 'PAYROLL_PAYMENT'
        )
      )
    ORDER BY p.id
  `);
  const payrolls: PayrollAuditSnapshot[] = resultRows<PayrollRow>(payrollResult).map((row) => {
    const payrollId = asPositiveInteger(row.payroll_id, "payroll.payrollId");
    return {
      payrollId,
      status: String(row.status ?? ""),
      netSalary: asDecimal(row.net_salary, `payroll:${payrollId}.netSalary`),
      cashAccountId: row.cash_account_id == null ? null : asPositiveInteger(row.cash_account_id, `payroll:${payrollId}.cashAccountId`),
      paymentVoucherCount: asNonNegativeInteger(row.payment_voucher_count, `payroll:${payrollId}.paymentVoucherCount`),
      paymentVoucherTotal: asDecimal(row.payment_voucher_total, `payroll:${payrollId}.paymentVoucherTotal`),
      paymentLedgerDebit: asDecimal(row.payment_debit, `payroll:${payrollId}.paymentDebit`),
      paymentLedgerCredit: asDecimal(row.payment_credit, `payroll:${payrollId}.paymentCredit`),
      paymentCashCredit: asDecimal(row.payment_cash_credit, `payroll:${payrollId}.paymentCashCredit`),
      daybookCount: asNonNegativeInteger(row.daybook_count, `payroll:${payrollId}.daybookCount`),
      daybookAmount: asDecimal(row.daybook_amount, `payroll:${payrollId}.daybookAmount`),
    };
  });

  const stockResult = await tx.execute(sql`
    WITH inventory_accounts AS (
      SELECT id, opening_balance, opening_balance_side
      FROM ledger_accounts
      WHERE company_id = ${companyId}
        AND deleted_at IS NULL
        AND lower(COALESCE(account_type, '')) = 'asset'
        AND (
          lower(COALESCE(code, '')) IN ('inventory', 'stock', 'stock_in_hand', 'stock-on-hand')
          OR lower(COALESCE(name, '')) LIKE '%inventory%'
          OR lower(COALESCE(name, '')) LIKE '%stock in hand%'
          OR lower(COALESCE(name, '')) LIKE '%stock on hand%'
          OR lower(COALESCE(name, '')) LIKE '%stock on floor%'
          OR lower(COALESCE(sub_type, '')) LIKE '%inventory%'
        )
    ), account_opening AS (
      SELECT COALESCE(SUM(
        CASE
          WHEN lower(COALESCE(opening_balance_side, 'dr')) = 'cr' THEN -COALESCE(opening_balance, 0)
          ELSE COALESCE(opening_balance, 0)
        END
      ), 0) AS opening_value
      FROM inventory_accounts
    ), account_flow AS (
      SELECT COALESCE(SUM(
        COALESCE(ve.base_debit_amount, ve.debit_amount, 0)
        - COALESCE(ve.base_credit_amount, ve.credit_amount, 0)
      ), 0) AS movement_value
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
      WHERE v.company_id = ${companyId}
        AND v.deleted_at IS NULL
        AND ve.ledger_account_id IN (SELECT id FROM inventory_accounts)
    )
    SELECT
      COALESCE((SELECT SUM(i.total_value) FROM inventory i WHERE i.company_id = ${companyId}), 0)::text AS operational_value,
      (COALESCE((SELECT opening_value FROM account_opening), 0) + COALESCE((SELECT movement_value FROM account_flow), 0))::text AS accounting_value,
      (SELECT COUNT(*)::int FROM inventory_accounts) AS inventory_account_count
  `);
  const stockRow = resultRows<StockRow>(stockResult)[0];
  if (!stockRow) {
    throw new Phase3AccountingAuditError("PHASE3_DATABASE_ROW_INVALID", `Company ${companyId} stock snapshot is missing`);
  }
  const stock: StockAccountingAuditSnapshot = {
    companyId,
    operationalInventoryValue: asDecimal(stockRow.operational_value, "stock.operationalInventoryValue"),
    accountingInventoryValue: asDecimal(stockRow.accounting_value, "stock.accountingInventoryValue"),
    accountingInventoryAccountCount: asNonNegativeInteger(stockRow.inventory_account_count, "stock.inventoryAccountCount"),
  };

  // Exact duplicate-looking expense lines can be valid (for example two workers
  // or two charges with the same amount). Only surface duplicates when the parent
  // voucher is itself over-posted/unbalanced, which is the high-confidence retry
  // signature seen in historical corruption.
  const duplicateResult = await tx.execute(sql`
    WITH voucher_totals AS (
      SELECT
        v.id,
        v.currency,
        v.total_amount,
        COALESCE(SUM(COALESCE(ve.base_debit_amount, ve.debit_amount, 0)), 0) AS debit,
        COALESCE(SUM(COALESCE(ve.base_credit_amount, ve.credit_amount, 0)), 0) AS credit
      FROM vouchers v
      LEFT JOIN voucher_entries ve ON ve.voucher_id = v.id
      WHERE v.company_id = ${companyId}
        AND v.deleted_at IS NULL
      GROUP BY v.id, v.currency, v.total_amount
    ), duplicate_groups AS (
      SELECT
        ve.voucher_id,
        concat_ws('|',
          'ledger=' || COALESCE(ve.ledger_account_id::text, ''),
          'bank=' || COALESCE(ve.bank_account_id::text, ''),
          'dr=' || COALESCE(ve.base_debit_amount, ve.debit_amount, 0)::text,
          'cr=' || COALESCE(ve.base_credit_amount, ve.credit_amount, 0)::text,
          'narration=' || COALESCE(ve.narration, '')
        ) AS signature,
        COUNT(*)::int AS occurrences
      FROM voucher_entries ve
      JOIN vouchers v ON v.id = ve.voucher_id
      WHERE v.company_id = ${companyId}
        AND v.deleted_at IS NULL
      GROUP BY
        ve.voucher_id,
        ve.ledger_account_id,
        ve.bank_account_id,
        COALESCE(ve.base_debit_amount, ve.debit_amount, 0),
        COALESCE(ve.base_credit_amount, ve.credit_amount, 0),
        COALESCE(ve.narration, '')
      HAVING COUNT(*) > 1
    )
    SELECT d.voucher_id, d.signature, d.occurrences
    FROM duplicate_groups d
    JOIN voucher_totals vt ON vt.id = d.voucher_id
    WHERE vt.debit <> vt.credit
       OR (
         upper(COALESCE(vt.currency, 'USD')) = 'USD'
         AND (
           abs(vt.debit - vt.total_amount) >= 0.01
           OR abs(vt.credit - vt.total_amount) >= 0.01
         )
       )
    ORDER BY d.voucher_id, d.signature
  `);
  const duplicateEntries: DuplicateEntryGroup[] = resultRows<DuplicateRow>(duplicateResult).map((row) => ({
    voucherId: asPositiveInteger(row.voucher_id, "duplicateEntry.voucherId"),
    signature: String(row.signature ?? ""),
    occurrences: asNonNegativeInteger(row.occurrences, "duplicateEntry.occurrences"),
  }));

  return {
    companyId,
    payments,
    vouchers,
    sales,
    payrolls,
    stock,
    duplicateEntries,
  };
}

export async function runDatabasePhase3AccountingAudit(input: {
  tx: DrizzleTransaction;
  companyId: number;
}): Promise<Phase3AccountingAuditReport> {
  return auditPhase3Accounting(await loadDatabasePhase3AccountingAudit(input));
}

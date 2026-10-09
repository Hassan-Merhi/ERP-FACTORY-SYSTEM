import type { PostingSourceIdentity } from "../../services/accounting/centralPostingEngine";
import { insertInfrastructureVoucher } from "../../services/accounting/infrastructureVoucherIdentity";
import { eq, and, isNull, asc, sql } from "drizzle-orm";
import { db, pool } from "../../db";
import * as schema from "@shared/schema";
import type { Voucher, InsertVoucher } from "@shared/schema";
import { higherPriorityTargetsAbsent } from "../../services/accounting/balances/partyLineRules";

/**
 * One statement line: a voucher's postings against a single account, already
 * summed and cast to text by the query. Amount columns are numeric-as-text; the
 * base columns are null when the voucher predates dual-currency capture.
 */
export type AccountStatementEntryRow = {
  voucherId: number;
  entryId: number;
  debitAmount: string;
  creditAmount: string;
  transactionDebitAmount: string;
  transactionCreditAmount: string;
  baseDebitAmount: string | null;
  baseCreditAmount: string | null;
  transactionCurrency: string | null;
  historicalExchangeRate: string | null;
  rateConvention: string | null;
  narration: string | null;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  voucherDescription: string | null;
  currency: string | null;
  companyId: number;
};

/** Positional parameters bound into the statement queries below. */
type StatementQueryParams = (string | number)[];

export async function getAllVouchers(companyId: number): Promise<Voucher[]> {
  return await db
    .select()
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.companyId, companyId),
        isNull(schema.vouchers.deletedAt),
        sql`${schema.vouchers.voucherNumber} NOT LIKE 'SP-OTW-REV-%'`,
        sql`${schema.vouchers.voucherNumber} NOT LIKE 'SP-STOCK-%'`,
        sql`${schema.vouchers.voucherNumber} NOT LIKE 'SP-OPNSTK-%'`
      )
    )
    .orderBy(asc(schema.vouchers.voucherNumber));
}

export async function getVoucherById(id: number): Promise<Voucher | undefined> {
  const [voucher] = await db.select().from(schema.vouchers).where(eq(schema.vouchers.id, id));
  return voucher;
}

export async function getVouchersByDateRange(
  companyId: number,
  startDate: string,
  endDate: string
): Promise<Voucher[]> {
  const vouchers = await db
    .select()
    .from(schema.vouchers)
    .where(
      and(
        eq(schema.vouchers.companyId, companyId),
        sql`${schema.vouchers.voucherDate} >= ${startDate}`,
        sql`${schema.vouchers.voucherDate} <= ${endDate}`,
        isNull(schema.vouchers.deletedAt),
        sql`${schema.vouchers.voucherNumber} NOT LIKE 'SP-OTW-REV-%'`,
        sql`${schema.vouchers.voucherNumber} NOT LIKE 'SP-STOCK-%'`,
        sql`${schema.vouchers.voucherNumber} NOT LIKE 'SP-OPNSTK-%'`
      )
    );
  return vouchers;
}

export async function getVoucherEntriesByLedger(
  ledgerAccountId: number,
  startDate?: string,
  endDate?: string,
  companyId?: number
): Promise<AccountStatementEntryRow[]> {
  const params: StatementQueryParams = [ledgerAccountId];
  let dateFilters = "";
  if (startDate) {
    params.push(startDate);
    dateFilters += " AND COALESCE(v.effective_date::date, v.voucher_date::date) >= $" + params.length + "::date";
  }
  if (endDate) {
    params.push(endDate);
    dateFilters += " AND COALESCE(v.effective_date::date, v.voucher_date::date) <= $" + params.length + "::date";
  }
  // Scope to a specific company when provided. Without this, cross-company
  // vouchers (e.g. ERP-side intercompany entries that post to a factory
  // ledger account) would appear in the account statement, causing a
  // discrepancy against Net Position which only looks at the owner company.
  let companyFilter = "";
  if (companyId) {
    params.push(companyId);
    companyFilter = " AND v.company_id = $" + params.length;
  }

  // GROUP BY voucher so that a single voucher with multiple lines all posting
  // to the same ledger account appears as ONE row (with summed debit/credit),
  // not as one row per entry line.
  const result = await pool.query<AccountStatementEntryRow>(
    `SELECT
       v.id                                                        AS "voucherId",
       MIN(ve.id)                                                  AS "entryId",
       COALESCE(SUM(ve.debit_amount::numeric),  0)::text           AS "debitAmount",
       COALESCE(SUM(ve.credit_amount::numeric), 0)::text           AS "creditAmount",
       COALESCE(SUM(ve.transaction_debit_amount::numeric), 0)::text AS "transactionDebitAmount",
       COALESCE(SUM(ve.transaction_credit_amount::numeric), 0)::text AS "transactionCreditAmount",
       CASE WHEN COUNT(ve.base_debit_amount) = COUNT(ve.id)
         THEN COALESCE(SUM(ve.base_debit_amount::numeric), 0)::text END AS "baseDebitAmount",
       CASE WHEN COUNT(ve.base_credit_amount) = COUNT(ve.id)
         THEN COALESCE(SUM(ve.base_credit_amount::numeric), 0)::text END AS "baseCreditAmount",
       MAX(ve.transaction_currency)                                AS "transactionCurrency",
       MAX(ve.historical_exchange_rate)                            AS "historicalExchangeRate",
       MAX(ve.rate_convention)                                     AS "rateConvention",
       STRING_AGG(DISTINCT NULLIF(TRIM(ve.narration), ''), ' | ') AS narration,
       v.voucher_number                                            AS "voucherNumber",
       v.voucher_type                                              AS "voucherType",
       COALESCE(v.effective_date::date, v.voucher_date::date)      AS "voucherDate",
       v.description                                               AS "voucherDescription",
       v.currency,
       v.company_id AS "companyId"
     FROM voucher_entries ve
     JOIN vouchers v ON ve.voucher_id = v.id
     WHERE ve.ledger_account_id = $1
       AND v.optional = false
       AND v.deleted_at IS NULL
       ${companyFilter}
       ${dateFilters}
     GROUP BY v.id, v.voucher_number, v.voucher_type, v.voucher_date, v.effective_date, v.description, v.currency, v.company_id
     ORDER BY COALESCE(v.effective_date::date, v.voucher_date::date), v.id`,
    params
  );

  return result.rows;
}

export async function getVoucherEntriesByCustomer(
  customerId: number,
  startDate?: string,
  endDate?: string,
  companyId?: number
): Promise<AccountStatementEntryRow[]> {
  const params: StatementQueryParams = [customerId];
  let dateFilters = "";
  let companyFilter = "";
  if (startDate) {
    params.push(startDate);
    dateFilters += " AND COALESCE(v.effective_date::date, v.voucher_date::date) >= $" + params.length + "::date";
  }
  if (endDate) {
    params.push(endDate);
    dateFilters += " AND COALESCE(v.effective_date::date, v.voucher_date::date) <= $" + params.length + "::date";
  }
  if (companyId) {
    params.push(companyId);
    companyFilter = " AND v.company_id = $" + params.length;
  }
  const result = await pool.query<AccountStatementEntryRow>(
    `SELECT
       ve.id                                                        AS "entryId",
       ve.voucher_id                                                AS "voucherId",
       ve.debit_amount                                              AS "debitAmount",
       ve.credit_amount                                             AS "creditAmount",
       ve.transaction_currency                                      AS "transactionCurrency",
       ve.transaction_debit_amount                                  AS "transactionDebitAmount",
       ve.transaction_credit_amount                                 AS "transactionCreditAmount",
       ve.base_debit_amount                                         AS "baseDebitAmount",
       ve.base_credit_amount                                        AS "baseCreditAmount",
       ve.historical_exchange_rate                                  AS "historicalExchangeRate",
       ve.rate_convention                                           AS "rateConvention",
       ve.narration,
       v.voucher_number                                             AS "voucherNumber",
       v.voucher_type                                               AS "voucherType",
       COALESCE(v.effective_date::date, v.voucher_date::date)       AS "voucherDate",
       v.description                                                AS "voucherDescription",
       v.currency,
       v.company_id                                                 AS "companyId"
     FROM voucher_entries ve
     JOIN vouchers v ON ve.voucher_id = v.id
     WHERE ve.customer_id = $1
       AND v.optional = false
       AND v.deleted_at IS NULL
       ${companyFilter}
       ${dateFilters}
     ORDER BY COALESCE(v.effective_date::date, v.voucher_date::date), v.id`,
    params
  );
  return result.rows;
}

export async function getVoucherEntriesByBankAccount(
  bankAccountId: number,
  startDate?: string,
  endDate?: string,
  companyId?: number
): Promise<AccountStatementEntryRow[]> {
  const params: StatementQueryParams = [bankAccountId];
  let dateFilters = "";
  let companyFilter = "";
  if (startDate) {
    params.push(startDate);
    dateFilters += " AND COALESCE(v.effective_date::date, v.voucher_date::date) >= $" + params.length + "::date";
  }
  if (endDate) {
    params.push(endDate);
    dateFilters += " AND COALESCE(v.effective_date::date, v.voucher_date::date) <= $" + params.length + "::date";
  }
  if (companyId) {
    params.push(companyId);
    companyFilter = " AND v.company_id = $" + params.length;
  }
  const result = await pool.query<AccountStatementEntryRow>(
    `SELECT
       ve.id                                                        AS "entryId",
       ve.voucher_id                                                AS "voucherId",
       ve.debit_amount                                              AS "debitAmount",
       ve.credit_amount                                             AS "creditAmount",
       ve.transaction_currency                                      AS "transactionCurrency",
       ve.transaction_debit_amount                                  AS "transactionDebitAmount",
       ve.transaction_credit_amount                                 AS "transactionCreditAmount",
       ve.base_debit_amount                                         AS "baseDebitAmount",
       ve.base_credit_amount                                        AS "baseCreditAmount",
       ve.historical_exchange_rate                                  AS "historicalExchangeRate",
       ve.rate_convention                                           AS "rateConvention",
       ve.narration,
       v.voucher_number                                             AS "voucherNumber",
       v.voucher_type                                               AS "voucherType",
       COALESCE(v.effective_date::date, v.voucher_date::date)       AS "voucherDate",
       v.description                                                AS "voucherDescription",
       v.currency,
       v.company_id                                                 AS "companyId"
     FROM voucher_entries ve
     JOIN vouchers v ON ve.voucher_id = v.id
     WHERE ve.bank_account_id = $1
       AND v.optional = false
       AND v.deleted_at IS NULL
       ${companyFilter}
       ${dateFilters}
     ORDER BY COALESCE(v.effective_date::date, v.voucher_date::date), v.id`,
    params
  );
  return result.rows;
}

export async function getVoucherEntriesByFixedAsset(
  fixedAssetId: number,
  startDate?: string,
  endDate?: string,
  companyId?: number
): Promise<AccountStatementEntryRow[]> {
  const params: StatementQueryParams = [fixedAssetId];
  let dateFilters = "";
  let companyFilter = "";
  if (startDate) {
    params.push(startDate);
    dateFilters += " AND COALESCE(v.effective_date::date, v.voucher_date::date) >= $" + params.length + "::date";
  }
  if (endDate) {
    params.push(endDate);
    dateFilters += " AND COALESCE(v.effective_date::date, v.voucher_date::date) <= $" + params.length + "::date";
  }
  if (companyId) {
    params.push(companyId);
    companyFilter = " AND v.company_id = $" + params.length;
  }
  const result = await pool.query<AccountStatementEntryRow>(
    `SELECT
       ve.id                                                        AS "entryId",
       ve.voucher_id                                                AS "voucherId",
       ve.debit_amount                                              AS "debitAmount",
       ve.credit_amount                                             AS "creditAmount",
       ve.transaction_currency                                      AS "transactionCurrency",
       ve.transaction_debit_amount                                  AS "transactionDebitAmount",
       ve.transaction_credit_amount                                 AS "transactionCreditAmount",
       ve.base_debit_amount                                         AS "baseDebitAmount",
       ve.base_credit_amount                                        AS "baseCreditAmount",
       ve.historical_exchange_rate                                  AS "historicalExchangeRate",
       ve.rate_convention                                           AS "rateConvention",
       ve.narration,
       v.voucher_number                                             AS "voucherNumber",
       v.voucher_type                                               AS "voucherType",
       COALESCE(v.effective_date::date, v.voucher_date::date)       AS "voucherDate",
       v.description                                                AS "voucherDescription",
       v.currency,
       v.company_id                                                 AS "companyId"
     FROM voucher_entries ve
     JOIN vouchers v ON ve.voucher_id = v.id
     WHERE ve.fixed_asset_id = $1
       AND v.optional = false
       AND v.deleted_at IS NULL
       ${companyFilter}
       ${dateFilters}
     ORDER BY COALESCE(v.effective_date::date, v.voucher_date::date), v.id`,
    params
  );
  return result.rows;
}

/**
 * The supplier's own lines, on the balance engine's attribution (wave 13): a
 * supplier-tagged line on a ledger account, bank or fixed asset belongs to
 * that account, so an account statement (`ownedOnly`) never lists a line the
 * account also counts. Without it every supplier-tagged line is returned: the
 * unified supplier ledger and the supplier-partner reconciliation read
 * supplier-tagged payable evidence on the SP payable accounts by design.
 */
const SUPPLIER_OWNED_LINE = higherPriorityTargetsAbsent("ve", "supplier_id");

export async function getVoucherEntriesBySupplier(
  supplierId: number,
  companyId?: number,
  startDate?: string,
  endDate?: string,
  options: { ownedOnly?: boolean } = {}
): Promise<AccountStatementEntryRow[]> {
  const params: StatementQueryParams = [supplierId];
  let dateFilters = "";
  let companyFilter = "";
  if (companyId) {
    params.push(companyId);
    companyFilter = " AND v.company_id = $" + params.length;
  }
  if (startDate) {
    params.push(startDate);
    dateFilters += " AND COALESCE(v.effective_date::date, v.voucher_date::date) >= $" + params.length + "::date";
  }
  if (endDate) {
    params.push(endDate);
    dateFilters += " AND COALESCE(v.effective_date::date, v.voucher_date::date) <= $" + params.length + "::date";
  }
  const result = await pool.query<AccountStatementEntryRow>(
    `SELECT
       ve.id                                                        AS "entryId",
       ve.voucher_id                                                AS "voucherId",
       ve.debit_amount                                              AS "debitAmount",
       ve.credit_amount                                             AS "creditAmount",
       ve.narration,
       ve.transaction_currency                                      AS "transactionCurrency",
       ve.transaction_debit_amount                                  AS "transactionDebitAmount",
       ve.transaction_credit_amount                                 AS "transactionCreditAmount",
       ve.base_debit_amount                                         AS "baseDebitAmount",
       ve.base_credit_amount                                        AS "baseCreditAmount",
       ve.historical_exchange_rate                                  AS "historicalExchangeRate",
       ve.rate_convention                                           AS "rateConvention",
       v.voucher_number                                             AS "voucherNumber",
       v.voucher_type                                               AS "voucherType",
       COALESCE(v.effective_date::date, v.voucher_date::date)       AS "voucherDate",
       v.description                                                AS "voucherDescription",
       v.company_id                                                 AS "companyId",
       v.currency
     FROM voucher_entries ve
     JOIN vouchers v ON ve.voucher_id = v.id
     WHERE ve.supplier_id = $1
       AND ${options.ownedOnly ? SUPPLIER_OWNED_LINE : "TRUE"}
       AND v.optional = false
       AND v.deleted_at IS NULL
       ${companyFilter}
       ${dateFilters}
     ORDER BY COALESCE(v.effective_date::date, v.voucher_date::date) DESC, v.id DESC`,
    params
  );
  return result.rows;
}

export async function getVoucherEntriesByEmployee(
  employeeId: number,
  companyId?: number,
  startDate?: string,
  endDate?: string
): Promise<AccountStatementEntryRow[]> {
  const params: StatementQueryParams = [employeeId];
  let dateFilters = "";
  let companyFilter = "";
  if (companyId) {
    params.push(companyId);
    companyFilter = " AND v.company_id = $" + params.length;
  }
  if (startDate) {
    params.push(startDate);
    dateFilters += " AND COALESCE(v.effective_date::date, v.voucher_date::date) >= $" + params.length + "::date";
  }
  if (endDate) {
    params.push(endDate);
    dateFilters += " AND COALESCE(v.effective_date::date, v.voucher_date::date) <= $" + params.length + "::date";
  }
  const result = await pool.query<AccountStatementEntryRow>(
    `SELECT
       ve.id                                                        AS "entryId",
       ve.voucher_id                                                AS "voucherId",
       ve.debit_amount                                              AS "debitAmount",
       ve.credit_amount                                             AS "creditAmount",
       ve.transaction_currency                                      AS "transactionCurrency",
       ve.transaction_debit_amount                                  AS "transactionDebitAmount",
       ve.transaction_credit_amount                                 AS "transactionCreditAmount",
       ve.base_debit_amount                                         AS "baseDebitAmount",
       ve.base_credit_amount                                        AS "baseCreditAmount",
       ve.historical_exchange_rate                                  AS "historicalExchangeRate",
       ve.rate_convention                                           AS "rateConvention",
       ve.narration,
       v.voucher_number                                             AS "voucherNumber",
       v.voucher_type                                               AS "voucherType",
       COALESCE(v.effective_date::date, v.voucher_date::date)       AS "voucherDate",
       v.description                                                AS "voucherDescription",
       v.company_id                                                 AS "companyId",
       v.currency
     FROM voucher_entries ve
     JOIN vouchers v ON ve.voucher_id = v.id
     WHERE ve.employee_id = $1
       AND v.optional = false
       AND v.deleted_at IS NULL
       ${companyFilter}
       ${dateFilters}
     ORDER BY COALESCE(v.effective_date::date, v.voucher_date::date) DESC, v.id DESC`,
    params
  );
  return result.rows;
}

export async function createVoucher(
  voucher: InsertVoucher & { postingSource: PostingSourceIdentity }
): Promise<Voucher> {
  const { postingSource, ...voucherFields } = voucher;
  const { voucher: created } = await insertInfrastructureVoucher(db, voucherFields, postingSource, voucherFields);
  return created;
}

export async function updateVoucher(id: number, updates: Partial<InsertVoucher>): Promise<Voucher> {
  const [updated] = await db.update(schema.vouchers).set(updates).where(eq(schema.vouchers.id, id)).returning();
  return updated;
}

export async function getVoucherEntriesByVoucher(voucherId: number) {
  const entries = await db
    .select({
      id: schema.voucherEntries.id,
      voucherId: schema.voucherEntries.voucherId,
      ledgerAccountId: schema.voucherEntries.ledgerAccountId,
      bankAccountId: schema.voucherEntries.bankAccountId,
      fixedAssetId: schema.voucherEntries.fixedAssetId,
      supplierId: schema.voucherEntries.supplierId,
      employeeId: schema.voucherEntries.employeeId,
      factorySupplierId: schema.voucherEntries.factorySupplierId,
      debitAmount: schema.voucherEntries.debitAmount,
      creditAmount: schema.voucherEntries.creditAmount,
      narration: schema.voucherEntries.narration,
      createdAt: schema.voucherEntries.createdAt,
      // Dual-currency fields (nullable for pre-backfill rows)
      transactionCurrency: schema.voucherEntries.transactionCurrency,
      transactionDebitAmount: schema.voucherEntries.transactionDebitAmount,
      transactionCreditAmount: schema.voucherEntries.transactionCreditAmount,
      baseDebitAmount: schema.voucherEntries.baseDebitAmount,
      baseCreditAmount: schema.voucherEntries.baseCreditAmount,
      historicalExchangeRate: schema.voucherEntries.historicalExchangeRate,
      rateConvention: schema.voucherEntries.rateConvention,
      accountName: schema.ledgerAccounts.name,
      accountCode: schema.ledgerAccounts.code,
      bankAccountName: schema.bankAccounts.name,
      bankAccountCode: schema.bankAccounts.code,
      fixedAssetName: schema.fixedAssets.name,
      fixedAssetCode: schema.fixedAssets.code,
      supplierName: schema.suppliers.legalName,
      supplierCode: schema.suppliers.code,
      employeeFirstName: schema.employees.firstName,
      employeeLastName: schema.employees.lastName,
      employeeCode: schema.employees.code,
      factorySupplierName: schema.factorySuppliers.name,
      customerName: schema.customers.legalName,
      customerId: schema.voucherEntries.customerId,
    })
    .from(schema.voucherEntries)
    .leftJoin(schema.ledgerAccounts, eq(schema.voucherEntries.ledgerAccountId, schema.ledgerAccounts.id))
    .leftJoin(schema.bankAccounts, eq(schema.voucherEntries.bankAccountId, schema.bankAccounts.id))
    .leftJoin(schema.fixedAssets, eq(schema.voucherEntries.fixedAssetId, schema.fixedAssets.id))
    .leftJoin(schema.suppliers, eq(schema.voucherEntries.supplierId, schema.suppliers.id))
    .leftJoin(schema.employees, eq(schema.voucherEntries.employeeId, schema.employees.id))
    .leftJoin(schema.factorySuppliers, eq(schema.voucherEntries.factorySupplierId, schema.factorySuppliers.id))
    .leftJoin(schema.customers, eq(schema.voucherEntries.customerId, schema.customers.id))
    .where(eq(schema.voucherEntries.voucherId, voucherId));

  return entries.map((entry) => {
    const employeeName =
      entry.employeeFirstName && entry.employeeLastName ? `${entry.employeeFirstName} ${entry.employeeLastName}` : null;
    return {
      ...entry,
      accountName:
        entry.accountName ||
        entry.bankAccountName ||
        entry.fixedAssetName ||
        entry.supplierName ||
        entry.factorySupplierName ||
        employeeName ||
        entry.customerName ||
        "Unknown Account",
      accountCode:
        entry.accountCode ||
        entry.bankAccountCode ||
        entry.fixedAssetCode ||
        entry.supplierCode ||
        entry.employeeCode ||
        "-",
    };
  });
}

/**
 * Zambia Phase 5: read-only, company-scoped Sales Report ↔ Net Position bridge.
 * No report, voucher, inventory row, exchange rate, or ledger account is
 * edited. The bridge is diagnostic and cannot repair historical cost values.
 */
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { companyStockValuation } from "../inventory/stockValuation";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { companyBusinessDate } from "./companyBusinessDate";
import { bridgeSalesToNetPosition } from "./salesNetPositionBridge";

type CompanyRow = { code: string; base_currency: string | null } & Record<string, unknown>;
type SaleRow = {
  id: number;
  voucher_number: string;
  recorded_sales: string;
  recorded_cost: string;
  moved_cost: string;
  missing_moved: number;
  line_count: number;
} & Record<string, unknown>;
type LedgerRow = {
  code: string;
  account_type: string;
  opening_balance: string;
  signed_book: string;
} & Record<string, unknown>;

const ZERO = new Decimal(0);
const amount = (value: string | number | null) => new Decimal(value ?? "0");
const fixed = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export async function getZambiaSalesNetPositionReconciliation(companyId: number) {
  if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new RangeError();
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
    await assertTransactionCompanyScope(tx, companyId);
    const company = resultRows<CompanyRow>(
      await tx.execute(sql`SELECT code, base_currency FROM companies WHERE id = ${companyId}`)
    )[0];
    if (!company) throw new RangeError();
    const businessDate = await companyBusinessDate(companyId, tx);
    const sales = resultRows<SaleRow>(
      await tx.execute(sql`
        SELECT v.id, v.voucher_number::text,
               COALESCE(SUM(si.total_sales),0)::text AS recorded_sales,
               COALESCE(SUM(si.total_cost),0)::text AS recorded_cost,
               COALESCE(SUM(si.value_moved),0)::text AS moved_cost,
               COUNT(*) FILTER (WHERE si.value_moved IS NULL)::int AS missing_moved,
               COUNT(*)::int AS line_count
        FROM sales_items si
        JOIN vouchers v ON v.id = si.voucher_id
        WHERE v.company_id = ${companyId}
          AND v.deleted_at IS NULL AND v.optional = FALSE
          AND v.voucher_date <= ${businessDate}::date
        GROUP BY v.id, v.voucher_number
        ORDER BY v.id
      `)
    );
    const ledger = resultRows<LedgerRow>(
      await tx.execute(sql`
        SELECT l.code, l.account_type,
               COALESCE(l.opening_balance,0)::text AS opening_balance,
               COALESCE(SUM(
                 CASE WHEN v.deleted_at IS NULL AND v.optional = FALSE
                       AND v.voucher_date <= ${businessDate}::date
                      THEN e.debit_amount - e.credit_amount ELSE 0 END
               ),0)::text AS signed_book
        FROM ledger_accounts l
        LEFT JOIN voucher_entries e ON e.company_id=l.company_id AND e.ledger_account_id=l.id
        LEFT JOIN vouchers v ON v.company_id=l.company_id AND v.id=e.voucher_id
        WHERE l.company_id=${companyId}
        GROUP BY l.id, l.code, l.account_type, l.opening_balance
        ORDER BY l.id
      `)
    );
    const otw = resultRows<{ total: string } & Record<string, unknown>>(
      await tx.execute(sql`
        SELECT COALESCE(SUM(
          CASE WHEN COALESCE(c.grand_total,0)=0 THEN c.items_total ELSE c.grand_total END
        ),0)::text AS total
        FROM containers c
        WHERE c.company_id=${companyId} AND c.status='OTW'
      `)
    )[0];
    const stock = await companyStockValuation(tx, companyId);
    const supportedCodes = new Set([
      "SALES",
      "PURCHASES",
      "DUTIES",
      "TRANSPORT",
      "HADCRD",
      "ZAMDUT",
      "ZAMTRA",
      "FXREVGAI",
      "FX-REVALUATION",
      "KITCAS",
      "LUSCAS",
      "INVENTORY",
      "GOODS_IN_TRANSIT",
      "COGS",
      "IMPORT_CHARGES",
      "ROUNDING",
      "OPENING_BALANCE_EQUITY",
      "RETAINED_EARNINGS",
    ]);
    const sumCodes = (codes: readonly string[]) =>
      ledger.reduce(
        (sum, row) => (codes.includes(row.code) ? sum.plus(amount(row.signed_book)) : sum),
        ZERO
      );
    const sumTypes = (types: readonly string[]) =>
      ledger.reduce(
        (sum, row) => (types.includes(row.account_type.toLowerCase()) ? sum.plus(amount(row.signed_book)) : sum),
        ZERO
      );
    const aggregate = sales.reduce(
      (out, row) => ({
        sales: out.sales.plus(amount(row.recorded_sales)),
        cost: out.cost.plus(amount(row.recorded_cost)),
        relieved: out.relieved.plus(amount(row.moved_cost)),
        missing: out.missing + Number(row.missing_moved),
        lines: out.lines + Number(row.line_count),
      }),
      { sales: ZERO, cost: ZERO, relieved: ZERO, missing: 0, lines: 0 }
    );
    const fxAccounts = ledger.filter(
      (row) => (row.code === "FXREVGAI" || row.code === "FX-REVALUATION") && !amount(row.signed_book).isZero()
    );
    const mismatchAccounts = ledger.filter(
      (row) => !supportedCodes.has(row.code) && !amount(row.signed_book).isZero()
    );
    const openingAccounts = ledger.filter((row) => !amount(row.opening_balance).isZero());
    const bridge = bridgeSalesToNetPosition({
      salesItemsUsd: fixed(aggregate.sales),
      salesReportCostUsd: fixed(aggregate.cost),
      postedSalesLedgerUsd: fixed(sumCodes(["SALES"]).neg()),
      actualInventoryReliefUsd: aggregate.missing ? null : fixed(aggregate.relieved),
      stockOnHandUsd: stock.total,
      stockOtwUsd: fixed(amount(otw?.total ?? "0")),
      purchaseAndLandedCostsUsd: fixed(sumCodes(["PURCHASES", "DUTIES", "TRANSPORT"])),
      cashBookUsd: fixed(sumTypes(["cash", "bank"])),
      recordedLiabilitiesUsd: fixed(sumTypes(["liability", "loan", "loans"]).neg()),
      fxCounterBookDebitUsd: fixed(sumCodes(["FXREVGAI", "FX-REVALUATION"])),
      fxCounterAccountType: fxAccounts.length === 1 ? fxAccounts[0].account_type : null,
      missingCostEvidenceCount: aggregate.missing,
      // One net FX counter and a normal valued stock subledger are required
      // before treating a matching bridge as complete. The underlying
      // account-classification/posting workflow is reviewed separately.
      unsupportedAccountCount:
        mismatchAccounts.length +
        (company.code !== "ZM" || company.base_currency !== "USD" ? 1 : 0) +
        (fxAccounts.length > 1 ? 1 : 0) +
        (stock.excluded.anomalousRows > 0 || new Decimal(stock.excluded.shortageValue).abs().gt(0) ? 1 : 0),
      balanceOpeningCount: openingAccounts.length,
    });
    return {
      companyId,
      companyCode: company.code,
      businessDate,
      valuationMode: "LIVE",
      sourceScope: "ZAMBIA_PRE_PERPETUAL_ERP",
      salesLineCount: aggregate.lines,
      salesCostByVoucher: sales.map((row) => ({
        voucherId: Number(row.id),
        voucherNumber: row.voucher_number,
        recordedSalesUsd: fixed(amount(row.recorded_sales)),
        recordedCostUsd: fixed(amount(row.recorded_cost)),
        actualValueRelievedUsd: Number(row.missing_moved) ? null : fixed(amount(row.moved_cost)),
        costDifferenceUsd: Number(row.missing_moved)
          ? null
          : fixed(amount(row.recorded_cost).minus(amount(row.moved_cost))),
      })),
      ...bridge,
      findings: {
        unmatchedLedgerCodes: mismatchAccounts.map((row) => row.code),
        openingBalanceAccountCount: openingAccounts.length,
        excludedStock: stock.excluded,
        fxAccountCount: fxAccounts.length,
      },
    };
  });
}

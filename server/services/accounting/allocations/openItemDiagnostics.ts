/**
 * Phase 25 diagnostics (read-only; warn, never repair):
 *
 *   - AR-6 `customerBalancesMemo`: the `customer_balances` cache is a
 *     read-only operational memo, not a balance (owner decision, decided by
 *     default). Per customer, the cache's net (Σ debit − credit of its rows)
 *     against the engine's movements (closing − master opening): a
 *     difference is listed for review, never corrected.
 *   - AR-1 `employeeBalanceCache`: `employees.current_balance` (owed to the
 *     employee, positive) against the engine's employee closing (Cr
 *     positive). The pages read the engine; the cache is listed.
 *   - AR-3 `bookAmountColumn`: the book amount is debit_amount /
 *     credit_amount (owner decision, decided by default). Lines whose
 *     base_debit_amount / base_credit_amount differ from it by more than half
 *     a cent are listed: a reader summing the base columns gets another
 *     figure (the wave 6 legacy base repair is the production step).
 *   - AR-4 `allocations`: per party kind, the parties whose live allocation
 *     rows no longer fit their items (source changed) and the rows the next
 *     FIFO run would write; and the aging's tie-out to the engine.
 */
import { sql } from "drizzle-orm";

import type { DatabaseOrTransaction } from "../../../db";
import { MoneyDecimal, toMoney } from "../../../lib/money";
import { getPartyBalances } from "../balances/ledgerBalanceEngine";
import { getAgingReport } from "../../reports/agingReport";
import { OPEN_ITEM_PARTY_KINDS } from "./openItems";

export type DiagnosticStatus = "ok" | "warn";

export interface OpenItemDiagnostics {
  companyId: number;
  customerBalancesMemo: {
    status: DiagnosticStatus;
    label: string;
    customers: Array<{
      customerId: number;
      name: string;
      cacheNet: string;
      engineMovements: string;
      engineClosing: string;
      difference: string;
    }>;
  };
  employeeBalanceCache: {
    status: DiagnosticStatus;
    employees: Array<{
      employeeId: number;
      name: string;
      cacheBalance: string;
      engineOwed: string;
      difference: string;
    }>;
  };
  bookAmountColumn: {
    status: DiagnosticStatus;
    bookColumns: "debit_amount/credit_amount";
    differingLines: number;
    differenceTotal: string;
    sample: Array<{ entryId: number; voucherId: number; voucherNumber: string; book: string; base: string }>;
  };
  allocations: Array<{
    kind: string;
    status: DiagnosticStatus;
    partiesNeedingRun: number;
    pendingRows: number;
    tieOut: { engineTotal: string; agingTotal: string; difference: string; tied: boolean };
  }>;
}

export const CUSTOMER_BALANCES_MEMO_LABEL =
  "customer_balances is an operational memo (not authoritative): balances and statements come from the ledger";

export async function getOpenItemDiagnostics(
  executor: DatabaseOrTransaction,
  companyId: number
): Promise<OpenItemDiagnostics> {
  const [customers, employees, cache, empCache, differing, agingRows] = await Promise.all([
    getPartyBalances(executor, { companyId, kind: "customer" }),
    getPartyBalances(executor, { companyId, kind: "employee" }),
    executor.execute<{ customer_id: number; net: string } & Record<string, unknown>>(sql`
      SELECT customer_id, SUM(COALESCE(debit_amount, 0) - COALESCE(credit_amount, 0))::text AS net
        FROM customer_balances WHERE company_id = ${companyId} GROUP BY customer_id
    `),
    executor.execute<{ id: number; current_balance: string } & Record<string, unknown>>(sql`
      SELECT id, COALESCE(current_balance, 0)::text AS current_balance
        FROM employees WHERE company_id = ${companyId} AND deleted_at IS NULL
    `),
    executor.execute<
      {
        entry_id: number;
        voucher_id: number;
        voucher_number: string;
        book: string;
        base: string;
        lines: string;
        total: string;
      } & Record<string, unknown>
    >(sql`
      WITH d AS (
        SELECT ve.id AS entry_id, v.id AS voucher_id, v.voucher_number,
               COALESCE(ve.debit_amount, 0) - COALESCE(ve.credit_amount, 0) AS book,
               COALESCE(ve.base_debit_amount, 0) - COALESCE(ve.base_credit_amount, 0) AS base
          FROM voucher_entries ve
          JOIN vouchers v ON v.id = ve.voucher_id
         WHERE v.company_id = ${companyId} AND v.deleted_at IS NULL AND v.optional = false
           AND (ve.base_debit_amount IS NOT NULL OR ve.base_credit_amount IS NOT NULL)
           AND ABS((COALESCE(ve.debit_amount, 0) - COALESCE(ve.credit_amount, 0))
                 - (COALESCE(ve.base_debit_amount, 0) - COALESCE(ve.base_credit_amount, 0))) > 0.005
      )
      SELECT entry_id, voucher_id, voucher_number, book::text AS book, base::text AS base,
             (SELECT COUNT(*) FROM d)::text AS lines, (SELECT COALESCE(SUM(book - base), 0) FROM d)::text AS total
        FROM d ORDER BY entry_id LIMIT 50
    `),
    Promise.all(OPEN_ITEM_PARTY_KINDS.map((kind) => getAgingReport(companyId, kind, null, executor))),
  ]);

  const cacheNet = new Map(cache.rows.map((row) => [Number(row.customer_id), toMoney(row.net)]));
  const customerRows: OpenItemDiagnostics["customerBalancesMemo"]["customers"] = [];
  for (const party of customers.parties) {
    if (party.id === null) continue;
    const net = cacheNet.get(party.id);
    if (net === undefined) continue;
    const movements = toMoney(party.closing).minus(party.masterOpening);
    const difference = net.minus(movements);
    if (difference.isZero()) continue;
    customerRows.push({
      customerId: party.id,
      name: party.name,
      cacheNet: net.toFixed(2),
      engineMovements: movements.toFixed(2),
      engineClosing: party.closing,
      difference: difference.toFixed(2),
    });
  }

  const engineEmployees = new Map(
    employees.parties.filter((party) => party.id !== null).map((party) => [party.id as number, party])
  );
  const employeeRows: OpenItemDiagnostics["employeeBalanceCache"]["employees"] = [];
  for (const row of empCache.rows) {
    const party = engineEmployees.get(Number(row.id));
    const owed = party ? toMoney(party.closing).negated() : new MoneyDecimal(0);
    const difference = toMoney(row.current_balance).minus(owed);
    if (difference.isZero()) continue;
    employeeRows.push({
      employeeId: Number(row.id),
      name: party?.name ?? `employee #${row.id}`,
      cacheBalance: toMoney(row.current_balance).toFixed(2),
      engineOwed: owed.toFixed(2),
      difference: difference.toFixed(2),
    });
  }

  const differingLines = Number(differing.rows[0]?.lines ?? 0);
  return {
    companyId,
    customerBalancesMemo: {
      status: customerRows.length ? "warn" : "ok",
      label: CUSTOMER_BALANCES_MEMO_LABEL,
      customers: customerRows,
    },
    employeeBalanceCache: { status: employeeRows.length ? "warn" : "ok", employees: employeeRows },
    bookAmountColumn: {
      status: differingLines > 0 ? "warn" : "ok",
      bookColumns: "debit_amount/credit_amount",
      differingLines,
      differenceTotal: toMoney(differing.rows[0]?.total ?? 0).toFixed(2),
      sample: differing.rows.map((row) => ({
        entryId: Number(row.entry_id),
        voucherId: Number(row.voucher_id),
        voucherNumber: row.voucher_number,
        book: toMoney(row.book).toFixed(2),
        base: toMoney(row.base).toFixed(6),
      })),
    },
    allocations: agingRows.map((report) => {
      const needing = report.parties.filter((party) => party.pendingAllocations > 0);
      return {
        kind: report.kind,
        status: needing.length > 0 || !report.controlTieOut.tied ? ("warn" as const) : ("ok" as const),
        partiesNeedingRun: needing.length,
        pendingRows: needing.reduce((sum, party) => sum + party.pendingAllocations, 0),
        tieOut: report.controlTieOut,
      };
    }),
  };
}

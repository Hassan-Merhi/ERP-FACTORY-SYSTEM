/**
 * Wave 17 D (2026-10-09): Retail cash and inventory in the ledger. Listed,
 * never back-filled.
 *
 *   retail_cash_movements_without_journal — a cash in/out movement with no
 *     live voucher (recorded before movements were journalled).
 *   retail_shift_variance_without_journal — a closed Retail shift whose counted
 *     cash differed from the expected cash with no live RETAIL-OVERSHORT-{shift}
 *     journal (closed before the close journalled it).
 *   retail_inventory_ledger_vs_stock — the Retail inventory account(s) against
 *     the Retail stock sub-ledger (Σ quantity × average cost), with whether the
 *     Retail inventory opening is applied.
 */
import { sql } from "drizzle-orm";

import { db } from "../../../db";
import { sumMoney, toMoney } from "../../../lib/money";
import { retailInventoryReconciliationTx } from "../../retail/retailInventoryJournal";
import type { IntegrityCheck } from "./accountingIntegrityDiagnostic";

const SAMPLE_LIMIT = 20;
type Row = Record<string, unknown>;

async function rows<T extends Row>(query: ReturnType<typeof sql>): Promise<T[]> {
  return (await db.execute<T>(query)).rows as unknown as T[];
}

async function tableExists(name: string): Promise<boolean> {
  const [row] = await rows<{ present: boolean }>(sql`SELECT to_regclass(${name}) IS NOT NULL AS present`);
  return Boolean(row?.present);
}

function warnCheck(key: string, explanation: string, samples: Row[], amount: string | null): IntegrityCheck {
  return {
    key,
    status: samples.length ? "warn" : "pass",
    count: samples.length,
    amount: samples.length ? amount : null,
    explanation,
    samples: samples.slice(0, SAMPLE_LIMIT),
  };
}

export async function retailLedgerChecks(companyId: number): Promise<IntegrityCheck[]> {
  if (!(await tableExists("retail_cash_movements"))) return [];
  const checks: IntegrityCheck[] = [];

  const movements = await rows<{
    id: number;
    shift_id: number;
    movement_type: string;
    amount: string;
    reason: string;
    created_at: string;
  }>(sql`
    SELECT m.id, m.shift_id, m.movement_type, m.amount::text AS amount, m.reason, m.created_at::text AS created_at
      FROM retail_cash_movements m
     WHERE m.company_id = ${companyId}
       AND NOT EXISTS (SELECT 1 FROM vouchers v
                        WHERE v.id = m.voucher_id AND v.company_id = m.company_id AND v.deleted_at IS NULL)
     ORDER BY m.id
  `);
  checks.push(
    warnCheck(
      "retail_cash_movements_without_journal",
      "Retail cash in/out movements with no journal (recorded before wave 17 D journalled them): the drawer and its cash account differ by them. Listed, not back-filled.",
      movements,
      sumMoney(
        movements.map((row) => (row.movement_type === "cash_in" ? row.amount : toMoney(row.amount).negated()))
      ).toFixed(2)
    )
  );

  const variances = await rows<{ id: number; variance: string; closed_at: string | null }>(sql`
    SELECT s.id, s.variance::text AS variance, s.closed_at::text AS closed_at
      FROM pos_shifts s
      JOIN companies c ON c.id = s.company_id AND c.company_type = 'retail'
     WHERE s.company_id = ${companyId} AND s.status = 'closed' AND COALESCE(s.variance, 0) <> 0
       AND NOT EXISTS (SELECT 1 FROM vouchers v
                        WHERE v.company_id = s.company_id AND v.deleted_at IS NULL
                          AND v.voucher_number = 'RETAIL-OVERSHORT-' || s.id::text)
     ORDER BY s.id
  `);
  checks.push(
    warnCheck(
      "retail_shift_variance_without_journal",
      "Closed Retail shifts whose counted cash differed from the expected cash with no Cash Over/Short journal (closed before wave 17 D). Listed, not back-filled.",
      variances,
      sumMoney(variances.map((row) => row.variance)).toFixed(2)
    )
  );

  if (await tableExists("retail_inventory_openings")) {
    const reconciliation = await retailInventoryReconciliationTx(db, companyId);
    const differs = reconciliation.applicable && !toMoney(reconciliation.difference).isZero();
    checks.push(
      warnCheck(
        "retail_inventory_ledger_vs_stock",
        reconciliation.opening
          ? "The Retail inventory account(s) differ from the Retail stock sub-ledger (Σ quantity × average cost) after the Retail inventory opening."
          : "The Retail inventory account(s) differ from the Retail stock sub-ledger: the Retail inventory opening (Owner preview/apply) has not been applied, so receipts and adjustments are not journalled yet.",
        differs ? [{ ...reconciliation }] : [],
        reconciliation.difference
      )
    );
  }
  return checks;
}

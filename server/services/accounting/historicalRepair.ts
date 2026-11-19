import type { PoolClient } from "pg";
import { pool } from "../../db";
import { MoneyDecimal } from "../../lib/money";
import { allocatePayrollAccountingAmounts, moneyFromCents } from "./payrollAccountingAmounts";
import {
  RETIRED_POSTING_IDENTITY_MARK,
  retireVouchersWithClient,
  type VoucherRetirementActor,
} from "./voucherRetirement";
import {
  Phase3RepairRefusal,
  assertVoucherBalanced,
  derivePlan,
  ensureLedger,
  insertUsdEntry,
  scopeCompany,
  type Phase3HistoricalRepairPlan,
} from "./historicalRepairDerivePlan";
export { Phase3RepairRefusal } from "./historicalRepairDerivePlan";
export type { Phase3HistoricalRepairPlan, Phase3RepairVoucherRef } from "./historicalRepairDerivePlan";

function hasWork(plan: Phase3HistoricalRepairPlan): boolean {
  return (
    plan.purchaseDebits.length > 0 ||
    plan.duplicatePosEntries !== null ||
    plan.noteInventoryLegs.length > 0 ||
    plan.payrollPeriods.length > 0 ||
    plan.legacyMarker !== null
  );
}

async function voucherLines(client: PoolClient, voucherIds: number[]): Promise<Record<string, unknown>[]> {
  if (voucherIds.length === 0) return [];
  const result = await client.query(
    `SELECT id, voucher_id, ledger_account_id, debit_amount::text AS debit, credit_amount::text AS credit, narration
       FROM voucher_entries WHERE voucher_id = ANY($1::int[]) ORDER BY voucher_id, id`,
    [voucherIds]
  );
  return result.rows;
}

async function ensurePayrollLedgers(client: PoolClient, companyId: number, workerId: number, workerName: string) {
  const salaryGroup = await ensureLedger(client, companyId, "Salary Expense - Workers", "PH3-SAL-GRP", "Expense", {
    subType: "Group",
  });
  const bonusGroup = await ensureLedger(client, companyId, "Bonus Expense - Workers", "PH3-BON-GRP", "Expense", {
    subType: "Group",
  });
  const salaryId = await ensureLedger(
    client,
    companyId,
    `Salary Expense - ${workerName}`,
    `PH3-SAL-${workerId}`,
    "Expense",
    { parentId: salaryGroup }
  );
  const bonusId = await ensureLedger(
    client,
    companyId,
    `Bonus Expense - ${workerName}`,
    `PH3-BON-${workerId}`,
    "Expense",
    { parentId: bonusGroup }
  );
  return { salaryId, bonusId };
}

async function rebuildPayrollPeriod(
  client: PoolClient,
  companyId: number,
  period: Phase3HistoricalRepairPlan["payrollPeriods"][number],
  actor: VoucherRetirementActor
): Promise<void> {
  const { periodStart, periodEnd, survivorId: voucherId, duplicateIds } = period;
  const payrolls = await client.query<{
    worker_id: number;
    full_name: string | null;
    net_salary: string;
    advances: string;
    bonuses: string;
  }>(
    `SELECT p.worker_id,w.full_name,p.net_salary::text,p.advances::text,p.bonuses::text
       FROM factory_payrolls p
       LEFT JOIN factory_workers w ON w.id=p.worker_id
      WHERE p.company_id=$1 AND p.period_start=$2::date AND p.period_end=$3::date
      ORDER BY p.id`,
    [companyId, periodStart, periodEnd]
  );
  if (payrolls.rows.length === 0) {
    throw new Phase3RepairRefusal(
      "REPAIR_REFUSED",
      `Phase 3 payroll repair found no source payrolls for ${periodStart}..${periodEnd}`
    );
  }

  let totalNetCents = 0;
  let totalAdvanceCents = 0;
  const workerRows: Array<{ workerName: string; salary: string; bonus: string; salaryId: number; bonusId: number }> =
    [];
  for (const row of payrolls.rows) {
    const accounting = allocatePayrollAccountingAmounts({
      netSalary: row.net_salary ?? "0",
      advances: row.advances ?? "0",
      bonus: row.bonuses ?? "0",
    });
    const workerName = row.full_name || `Worker #${row.worker_id}`;
    const ledgers = await ensurePayrollLedgers(client, companyId, row.worker_id, workerName);
    workerRows.push({ workerName, salary: accounting.salaryExpense, bonus: accounting.bonusExpense, ...ledgers });
    totalNetCents += accounting.netCents;
    totalAdvanceCents += accounting.advanceCents;
  }

  const payableId = await ensureLedger(client, companyId, "Payroll Payable", "PH3-PAYROLL-PAYABLE", "Liability");
  const advancesId = await ensureLedger(client, companyId, "Factory Worker Advances", "PH3-WORKER-ADV", "Asset");

  // Duplicates are retired (soft delete with their lines, audited), not hard-deleted.
  await retireVouchersWithClient(client, {
    voucherIds: duplicateIds,
    reason: "phase3-payroll-duplicate",
    actor,
  });
  // The survivor's posting identity is released, not deleted, before its payload changes.
  await client.query(
    `UPDATE accounting_posting_requests
        SET idempotency_key = idempotency_key || $3 || voucher_id::text
      WHERE company_id=$1 AND voucher_id=$2 AND position($3 in idempotency_key) = 0`,
    [companyId, voucherId, RETIRED_POSTING_IDENTITY_MARK]
  );

  const totalGrossCents = totalNetCents + totalAdvanceCents;
  const description = `Payroll expense: ${payrolls.rows.length} worker${payrolls.rows.length === 1 ? "" : "s"} (${periodStart} – ${periodEnd})`;
  await client.query(
    `UPDATE vouchers
        SET voucher_type='Journal', voucher_date=$3::date, description=$4, total_amount=$5,
            currency='USD', source_module='FACTORY', optional=false
      WHERE company_id=$1 AND id=$2 AND deleted_at IS NULL`,
    [companyId, voucherId, periodStart, description, moneyFromCents(totalGrossCents)]
  );
  await client.query(`DELETE FROM voucher_entries WHERE voucher_id=$1`, [voucherId]);

  for (const row of workerRows) {
    if (new MoneyDecimal(row.salary).gt(0)) {
      await insertUsdEntry(client, {
        voucherId,
        ledgerAccountId: row.salaryId,
        debit: row.salary,
        narration: `Salary - ${row.workerName} (${periodStart} – ${periodEnd})`,
      });
    }
    if (new MoneyDecimal(row.bonus).gt(0)) {
      await insertUsdEntry(client, {
        voucherId,
        ledgerAccountId: row.bonusId,
        debit: row.bonus,
        narration: `Bonus - ${row.workerName} (${periodStart} – ${periodEnd})`,
      });
    }
  }
  if (totalNetCents > 0) {
    await insertUsdEntry(client, {
      voucherId,
      ledgerAccountId: payableId,
      credit: moneyFromCents(totalNetCents),
      narration: description,
    });
  }
  if (totalAdvanceCents > 0) {
    await insertUsdEntry(client, {
      voucherId,
      ledgerAccountId: advancesId,
      credit: moneyFromCents(totalAdvanceCents),
      narration: `Advance deductions settled - ${payrolls.rows.length} worker${payrolls.rows.length === 1 ? "" : "s"} (${periodStart} – ${periodEnd})`,
    });
  }
  await assertVoucherBalanced(client, companyId, voucherId);
}

async function withCompanyClient<T>(companyId: number, work: (client: PoolClient) => Promise<T>, readOnly: boolean) {
  const client = await pool.connect();
  try {
    await client.query(readOnly ? "BEGIN READ ONLY" : "BEGIN");
    await scopeCompany(client, companyId);
    const result = await work(client);
    await client.query(readOnly ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Read-only: what the repair would change for the company. */
export function planPhase3HistoricalRepair(companyId: number): Promise<Phase3HistoricalRepairPlan> {
  return withCompanyClient(companyId, (client) => derivePlan(client, companyId), true);
}

/**
 * Applies the reviewed plan for the company in one transaction, audited in it.
 * Refused (Phase3RepairRefusal) when the plan changed, there is nothing to
 * apply, or an account code it needs is held by another account.
 */
export function applyPhase3HistoricalRepair(
  companyId: number,
  options: { planHash: string; actor: VoucherRetirementActor }
): Promise<Phase3HistoricalRepairPlan> {
  return withCompanyClient(
    companyId,
    async (client) => {
      const plan = await derivePlan(client, companyId);
      if (plan.planHash !== options.planHash) {
        throw new Phase3RepairRefusal(
          "PLAN_CHANGED",
          "The repair plan changed since it was reviewed; review it again before applying"
        );
      }
      if (!hasWork(plan)) throw new Phase3RepairRefusal("NOTHING_TO_APPLY", "There is nothing to repair");

      const touched = [
        ...plan.purchaseDebits.map((row) => row.voucherId),
        ...(plan.duplicatePosEntries ? [plan.duplicatePosEntries.voucherId] : []),
        ...plan.noteInventoryLegs.map((row) => row.voucherId),
        ...plan.payrollPeriods.map((period) => period.survivorId),
      ];
      const before = await voucherLines(client, touched);

      if (plan.purchaseDebits.length > 0) {
        const purchasesAccountId = await ensureLedger(client, companyId, "Purchases", "PURCHASES", "Expense");
        for (const row of plan.purchaseDebits) {
          await insertUsdEntry(client, {
            voucherId: row.voucherId,
            ledgerAccountId: purchasesAccountId,
            debit: row.amount,
            narration: "Phase 3 repair - missing Purchases debit for legacy PO",
          });
        }
      }
      if (plan.duplicatePosEntries) {
        await client.query(`DELETE FROM voucher_entries WHERE voucher_id = $1 AND id = ANY($2::int[])`, [
          plan.duplicatePosEntries.voucherId,
          plan.duplicatePosEntries.entryIds,
        ]);
      }
      if (plan.noteInventoryLegs.length > 0) {
        const inventoryAccountId = await ensureLedger(client, companyId, "Inventory", "INVENTORY", "Asset", {
          subType: "Current Asset",
        });
        for (const row of plan.noteInventoryLegs) {
          await insertUsdEntry(client, {
            voucherId: row.voucherId,
            ledgerAccountId: inventoryAccountId,
            debit: row.side === "debit" ? row.amount : "0.00",
            credit: row.side === "credit" ? row.amount : "0.00",
            narration: `Phase 3 repair - ${row.voucherType} inventory control leg`,
          });
        }
      }
      for (const period of plan.payrollPeriods) {
        await rebuildPayrollPeriod(client, companyId, period, options.actor);
      }
      if (plan.legacyMarker) {
        await retireVouchersWithClient(client, {
          voucherIds: [plan.legacyMarker.voucherId],
          reason: "phase3-legacy-header-only-marker",
          actor: options.actor,
        });
      }
      for (const voucherId of new Set(touched)) await assertVoucherBalanced(client, companyId, voucherId);

      const after = await voucherLines(client, touched);
      await client.query(
        `INSERT INTO audit_log (user_id, username, company_id, action, table_name, record_identifier, changes)
         VALUES ($1, $2, $3, 'update', 'voucher_entries', 'phase3-historical-repair', $4::jsonb)`,
        [
          String(options.actor.userId),
          options.actor.username,
          companyId,
          JSON.stringify({
            lines: { old: before, new: after },
            plan: { new: { ...plan, skipped: plan.skipped } },
          }),
        ]
      );
      return plan;
    },
    false
  );
}

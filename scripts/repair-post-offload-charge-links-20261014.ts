/**
 * Non-financial historical repair for 139 active factory post-offload charges
 * in company 12. Links existing, balanced voucher/daybook evidence only;
 * never creates/retires vouchers, revalues stock, or changes supplier balances.
 *
 * Preview and apply are deliberately separate. The exact historical snapshot
 * is checked before each run, with per-charge row locking and amount validation.
 */
import { sql } from "drizzle-orm";
import { db, pool } from "../server/db";
import { toMoney } from "../server/lib/money";
import {
  createTenantDatabaseScope,
  runWithDatabaseScopeRuntimeContext,
} from "../server/services/security/databaseScopeRuntimeContext";

const COMPANY = 12;
const OLD_DAYBOOK = new Map([
  [15, 6869],
  [16, 8181],
  [17, 8742],
  [18, 9921],
  [21, 10160],
  [22, 10164],
]);

type ChargeRow = {
  id: number;
  container_id: number;
  amount: string;
  currency_code: string | null;
  ledger_account_id: number | null;
  supplier_id: number | null;
  voucher_id: number | null;
  daybook_entry_id: number | null;
};

async function reconcile(apply: boolean): Promise<void> {
  const all = await db.execute(sql`
    SELECT id, container_id, amount::text, currency_code,
           ledger_account_id, supplier_id, voucher_id, daybook_entry_id
      FROM factory_offload_additional_charges
     WHERE company_id = ${COMPANY} AND deleted_at IS NULL
     ORDER BY id
  `);
  const charges = all.rows as unknown as ChargeRow[];
  const total = charges.reduce((s, c) => s.plus(toMoney(c.amount)), toMoney(0));
  if (charges.length !== 139 || !total.eq("187629.28") ||
      charges.some((c) => (c.currency_code || "USD").toUpperCase() !== "USD")) {
    throw new Error("Historical charge set differs from verified 139 USD charges: stop and re-audit");
  }
  let foundVoucher = 0;
  let foundDaybook = 0;
  for (const original of charges) {
    await db.transaction(async (tx) => {
      const locked = await tx.execute(sql`
        SELECT id,container_id,amount::text,currency_code,ledger_account_id,
               supplier_id,voucher_id,daybook_entry_id
          FROM factory_offload_additional_charges
         WHERE company_id=${COMPANY} AND id=${original.id} AND deleted_at IS NULL
         FOR UPDATE
      `);
      const ch = locked.rows[0] as unknown as ChargeRow | undefined;
      if (!ch || ch.container_id !== original.container_id ||
          !toMoney(ch.amount).eq(original.amount) ||
          ch.ledger_account_id !== original.ledger_account_id ||
          ch.supplier_id !== original.supplier_id ||
          (ch.voucher_id !== original.voucher_id && ch.voucher_id !== null) ||
          (ch.daybook_entry_id !== original.daybook_entry_id && ch.daybook_entry_id !== null)) {
        throw new Error(`Charge #${original.id} changed during audit`);
      }
      let voucherId = ch.voucher_id;
      if (!voucherId) {
        const v = await tx.execute(sql`
          SELECT v.id
            FROM vouchers v
           WHERE v.company_id=${COMPANY} AND v.deleted_at IS NULL
             AND v.optional=false
             AND (
               v.voucher_number LIKE ${`FACTORY-POC-${ch.container_id}-${ch.id}-%`}
               OR v.voucher_number = ${`FACTORY-POC-BACKFILL-${ch.container_id}-${ch.id}`}
               OR v.voucher_number LIKE ${`FACTORY-OC-${ch.container_id}-${ch.id}-%`}
             )
             AND abs(v.total_amount - ${ch.amount}) < 0.02
             AND (SELECT count(*) FROM voucher_entries e WHERE e.voucher_id=v.id)=2
             AND abs((SELECT coalesce(sum(e.debit_amount-e.credit_amount),0)
                      FROM voucher_entries e WHERE e.voucher_id=v.id))<0.005
             AND abs((SELECT coalesce(sum(e.debit_amount),0)
                      FROM voucher_entries e WHERE e.voucher_id=v.id
                        AND e.ledger_account_id=812) - ${ch.amount})<0.02
             AND abs((SELECT coalesce(sum(e.credit_amount),0)
                      FROM voucher_entries e WHERE e.voucher_id=v.id
                        AND (e.ledger_account_id=${ch.ledger_account_id}
                          OR e.factory_supplier_id=${ch.supplier_id})) - ${ch.amount})<0.02
           ORDER BY v.id FOR UPDATE
        `);
        if (v.rows.length !== 1) {
          throw new Error(`Charge #${ch.id}: ${v.rows.length} validated vouchers, expected exactly one`);
        }
        voucherId = Number(v.rows[0].id);
        foundVoucher++;
      }
      let daybookId = ch.daybook_entry_id;
      if (!daybookId) {
        const sourceMeta = await tx.execute(sql`
          SELECT id
            FROM factory_daybook_entries
           WHERE company_id=${COMPANY} AND tx_type='OTHER_CHARGE'
             AND reference_id=${ch.container_id}
             AND meta_json IS NOT NULL AND meta_json LIKE '{%'
             AND meta_json::jsonb ->> 'chargeId' = ${String(ch.id)}
             AND abs(coalesce(amount_currency,0)-${ch.amount})<0.03
           ORDER BY id FOR UPDATE
        `);
        const legacyId = OLD_DAYBOOK.get(ch.id);
        const matching = sourceMeta.rows.length > 0
          ? sourceMeta.rows
          : legacyId
            ? (await tx.execute(sql`
                SELECT id FROM factory_daybook_entries
                 WHERE company_id=${COMPANY} AND id=${legacyId}
                   AND reference_id=${ch.container_id}
                   AND tx_type='OTHER_CHARGE' AND meta_json IS NULL
                   AND upper(coalesce(currency_code,'USD'))='USD'
                   AND abs(coalesce(amount_currency,0)-${ch.amount})<0.03
                 FOR UPDATE
              `)).rows
            : [];
        if (matching.length !== 1) {
          throw new Error(`Charge #${ch.id}: ${matching.length} verified daybooks, expected exactly one`);
        }
        daybookId = Number(matching[0].id);
        foundDaybook++;
      }
      if (apply && (voucherId !== ch.voucher_id || daybookId !== ch.daybook_entry_id)) {
        await tx.execute(sql`
          UPDATE factory_offload_additional_charges
             SET voucher_id=${voucherId},daybook_entry_id=${daybookId}
           WHERE company_id=${COMPANY} AND id=${ch.id}
             AND deleted_at IS NULL
             AND voucher_id IS NOT DISTINCT FROM ${ch.voucher_id}
             AND daybook_entry_id IS NOT DISTINCT FROM ${ch.daybook_entry_id}
        `);
      }
    });
  }
  console.log(`[ContainerChargeLinks] ${apply ? "APPLY" : "DRY RUN"} 139 charges; vouchers linked=${foundVoucher}, daybooks linked=${foundDaybook}`);
  if (apply) {
    const check = await db.execute(sql`
      SELECT count(*)::int AS missing FROM factory_offload_additional_charges
       WHERE company_id=${COMPANY} AND deleted_at IS NULL
         AND (voucher_id IS NULL OR daybook_entry_id IS NULL)
    `);
    if (Number(check.rows[0]?.missing) !== 0) {
      throw new Error("Some active post-offload charge references remain missing");
    }
    console.log("[ContainerChargeLinks] DONE: 139/139 active historical charges linked to existing accounting and daybook records");
  }
}

export function reconcileContainerChargeLinks20261014(apply: boolean) {
  return runWithDatabaseScopeRuntimeContext(createTenantDatabaseScope(COMPANY), () => reconcile(apply));
}

if (process.argv[1]?.includes("repair-post-offload-charge-links-20261014")) {
  void reconcileContainerChargeLinks20261014(process.argv.includes("--apply"))
    .catch((e) => { console.error(e); process.exitCode = 1; })
    .finally(() => pool.end());
}

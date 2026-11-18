import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { logAudit } from "../../routes/helpers/auditHelpers";
import {
  isSupplierPartnerCompany,
  postLinkedJournalTx,
  systemAccountIdsTx,
} from "../accounting/perpetualInventory/linkedJournal";
import {
  BaleRecostRefusal,
  FACTORY_BALE_RECOST_NOTHING_MESSAGE,
  FACTORY_BALE_RECOST_PLAN_CHANGED_MESSAGE,
  factoryRecostVoucherNumber,
  rows,
  todayUtc,
  type BaleRecostPlan,
} from "./baleRecostTypes";
import { planBaleRecostTx } from "./planBaleRecostTx";
export {
  BaleRecostRefusal,
  FACTORY_BALE_RECOST_MOVED_MESSAGE,
  FACTORY_BALE_RECOST_NOTHING_MESSAGE,
  FACTORY_BALE_RECOST_PLAN_CHANGED_MESSAGE,
  FACTORY_RAW_COST_UPDATE_RETIRED_MESSAGE,
  factoryRecostVoucherNumber,
} from "./baleRecostTypes";
export type { BaleRecostPlan, RecostBaleLine, RecostMixLine, RecostUnvalued } from "./baleRecostTypes";
export { planBaleRecostTx } from "./planBaleRecostTx";

export function planBaleRecost(companyId: number): Promise<BaleRecostPlan> {
  return db.transaction((tx) => planBaleRecostTx(tx, companyId));
}

export interface BaleRecostResult {
  runId: number;
  voucherId: number | null;
  plan: BaleRecostPlan;
}

/**
 * Applies the reviewed plan (see the module comment). Throws BaleRecostRefusal
 * when the plan changed or is empty, and the closed-period error when today is
 * in a closed accounting period.
 */
export async function applyBaleRecost(
  companyId: number,
  params: {
    planHash: string;
    confirmVerifiedSoldBales?: boolean;
    actor: { userId: string; username: string };
  }
): Promise<BaleRecostResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory_bale_recost'), ${companyId})`);
    // The order-finalize path locks each customer order before marking its
    // bales SOLD. Lock VERIFIED orders first so a verified order cannot be
    // invoiced between building the plan and applying its bale-cost changes.
    await tx.execute(sql`
      SELECT id FROM customer_orders
       WHERE company_id = ${companyId} AND deleted_at IS NULL AND status = 'VERIFIED'
       ORDER BY id FOR UPDATE
    `);
    const date = todayUtc();
    // The revaluation is dated today: refused in a closed period, journal or not.
    await tx.execute(sql`SELECT erp_assert_accounting_date_open(${companyId}, ${date}::date)`);
    const plan = await planBaleRecostTx(tx, companyId);
    if (plan.planHash !== params.planHash) {
      throw new BaleRecostRefusal("PLAN_CHANGED", FACTORY_BALE_RECOST_PLAN_CHANGED_MESSAGE);
    }
    if (plan.mixes.length === 0 && plan.bales.length === 0) {
      throw new BaleRecostRefusal("NOTHING_TO_APPLY", FACTORY_BALE_RECOST_NOTHING_MESSAGE);
    }
    if (
      plan.bales.some((b) => b.eligibility === "sold-on-uninvoiced-verified-order") &&
      params.confirmVerifiedSoldBales !== true
    ) {
      throw new BaleRecostRefusal(
        "VERIFIED_SOLD_CONFIRM_REQUIRED",
        "The plan contains bales marked SOLD on uninvoiced VERIFIED orders. Review their current-catalogue cost basis and explicitly confirm these bales before applying."
      );
    }

    const now = new Date();
    for (const mix of plan.mixes) {
      for (const source of mix.sources) {
        await tx.execute(sql`
          UPDATE factory_mix_batch_sources SET cost_per_kg = ${source.newCostPerKg}, total_cost = ${source.newTotalCost}
           WHERE id = ${source.id} AND mix_batch_id = ${mix.id}
        `);
      }
      await tx.execute(sql`
        UPDATE factory_mix_batches SET cost_per_kg = ${mix.newCostPerKg}, total_cost = ${mix.newTotalCost},
               updated_at = ${now}
         WHERE id = ${mix.id} AND company_id = ${companyId}
      `);
    }
    for (const bale of plan.bales) {
      await tx.execute(sql`
        UPDATE factory_bales SET cost_per_kg = ${bale.newCostPerKg}, total_cost = ${bale.newTotalCost},
               updated_at = ${now}
         WHERE id = ${bale.id} AND company_id = ${companyId}
      `);
    }

    const [run] = await rows<{ id: number }>(
      tx,
      sql`
        INSERT INTO factory_bale_recost_runs (company_id, plan_hash, plan, applied_by)
        VALUES (${companyId}, ${plan.planHash}, ${JSON.stringify(plan)}::jsonb, ${params.actor.username})
        RETURNING id
      `
    );

    let voucherId: number | null = null;
    if (plan.perpetual && !(await isSupplierPartnerCompany(tx, companyId))) {
      const wip = toMoney(plan.totals.wipChange);
      const finished = toMoney(plan.totals.finishedChange);
      const total = wip.plus(finished);
      const zero = new MoneyDecimal(0);
      const accounts = await systemAccountIdsTx(tx, companyId, [
        "FACTORY_WIP",
        "FACTORY_FINISHED_GOODS",
        "FACTORY_REVALUATION",
      ]);
      const side = (amount: Decimal) => ({
        debit: amount.isPositive() ? amount : zero,
        credit: amount.isNegative() ? amount.negated() : zero,
      });
      const number = factoryRecostVoucherNumber(companyId, run.id);
      voucherId = await postLinkedJournalTx(tx, {
        companyId,
        voucherNumber: number,
        voucherDate: date,
        description: ["Factory bale re-cost", number].join(" - "),
        identity: { sourceType: "factory-bale-recost", sourceId: run.id },
        lines: [
          { ledgerAccountId: accounts.get("FACTORY_WIP")!, ...side(wip), narration: "Open mixes re-costed in USD" },
          {
            ledgerAccountId: accounts.get("FACTORY_FINISHED_GOODS")!,
            ...side(finished),
            narration: "Unsold bales re-costed in USD",
          },
          {
            ledgerAccountId: accounts.get("FACTORY_REVALUATION")!,
            ...side(total.negated()),
            narration: "Factory stock revaluation: reviewed bale re-cost",
          },
        ],
      });
      if (voucherId !== null) {
        await tx.execute(sql`UPDATE factory_bale_recost_runs SET voucher_id = ${voucherId} WHERE id = ${run.id}`);
      }
    }

    await logAudit(
      {
        userId: params.actor.userId,
        username: params.actor.username,
        companyId,
        action: "update",
        tableName: "factory_bales",
        recordId: run.id,
        recordIdentifier: "factory bale re-cost",
        changes: {
          recost: {
            new: {
              runId: run.id,
              planHash: plan.planHash,
              voucherId,
              totals: plan.totals,
              mixes: plan.mixes.map((mix) => ({ id: mix.id, old: mix.oldCostPerKg, new: mix.newCostPerKg })),
              bales: plan.bales.map((bale) => ({ id: bale.id, old: bale.oldTotalCost, new: bale.newTotalCost })),
            },
          },
        },
      },
      tx
    );
    return { runId: run.id, voucherId, plan };
  });
}

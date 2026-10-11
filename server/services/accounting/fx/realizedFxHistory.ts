/**
 * Realized FX of allocations the automatic listener does not post (phases
 * 23–29 integration review of phase 24 M6 with phase 25 AR-4).
 *
 * The allocation-event listener posts realized FX automatically only for a
 * company whose Owner enabled the allocation run, and only for settlements
 * dated on or after that enablement (allocations/allocationEnablement.ts).
 * Everything else — the history allocated by the first run, allocations
 * written before the enablement (notes, manual re-allocations) — is posted
 * only here, reviewed:
 *
 *   plan  (Admin/Owner, read only): every live allocation of the company
 *         between two vouchers whose realized FX has no live journal and is
 *         not zero, with the difference, the date it would be posted on and a
 *         plan hash;
 *   apply (Owner, `{ confirm: true, planHash }`): one transaction holding the
 *         allocation runs' locks, the plan re-derived (409 on a change), each
 *         difference posted through the engine (identity
 *         `fx-realized-allocation:{allocationId}`, as the listener would),
 *         one audit row with the plan.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import { db, type DbTransaction } from "../../../db";
import { HttpError } from "../../../lib/httpError";
import { writeAuditEvent } from "../../audit/auditService";
import type { AllocationPartyKind } from "../allocations/allocationEvents";
import { lockAllOpenItemKindsTx } from "../allocations/allocationService";
import { postRealizedFxForAllocationTx, REALIZED_FX_SOURCE_TYPE } from "./realizedFx";

/** A refusal with a code and details (the route answers with `body`). */
export class RealizedFxHistoryRefusal extends HttpError {
  constructor(
    statusCode: number,
    message: string,
    public readonly body: Record<string, unknown>
  ) {
    super(statusCode, message);
  }
}

export interface RealizedFxHistoryItem {
  allocationId: number;
  partyKind: AllocationPartyKind;
  partyId: number;
  invoiceVoucherId: number;
  paymentVoucherId: number;
  amount: string;
  currency: string;
  difference: string;
  nativeSettled: string;
  settledOn: string;
  voucherDate: string;
}

export interface RealizedFxHistoryPlan {
  companyId: number;
  items: RealizedFxHistoryItem[];
  planHash: string;
}

interface CandidateRow extends Record<string, unknown> {
  id: number;
  party_kind: AllocationPartyKind;
  party_id: number;
  invoice_voucher_id: number;
  payment_voucher_id: number;
  amount: string;
}

const PLAN_CHANGED_MESSAGE = "The realized exchange difference plan changed. Review it again.";
const NOTHING_MESSAGE = "There is no realized exchange difference to post.";

async function derivePlanTx(tx: DbTransaction, companyId: number): Promise<RealizedFxHistoryPlan> {
  // Live allocations between two vouchers whose invoice carries a foreign-currency
  // line and whose realized FX has no live journal yet.
  const candidates = await tx.execute<CandidateRow>(sql`
    SELECT a.id, a.party_kind, a.party_id, a.invoice_voucher_id, a.payment_voucher_id, a.amount::text AS amount
      FROM party_open_item_allocations a
     WHERE a.company_id = ${companyId}
       AND a.released_at IS NULL
       AND a.invoice_voucher_id IS NOT NULL
       AND a.payment_voucher_id IS NOT NULL
       AND EXISTS (
         SELECT 1 FROM voucher_entries e
          WHERE e.voucher_id = a.invoice_voucher_id
            AND e.transaction_currency IS NOT NULL
            AND upper(e.transaction_currency) <> 'USD'
       )
       AND NOT EXISTS (
         SELECT 1 FROM accounting_posting_requests r
           JOIN vouchers v ON v.id = r.voucher_id AND v.deleted_at IS NULL
          WHERE r.company_id = a.company_id
            AND r.source_type = ${REALIZED_FX_SOURCE_TYPE}
            AND r.source_id = a.id::text
       )
     ORDER BY a.id
  `);
  const items: RealizedFxHistoryItem[] = [];
  for (const row of candidates.rows) {
    const result = await postRealizedFxForAllocationTx(
      tx,
      {
        companyId,
        allocationId: Number(row.id),
        partyKind: row.party_kind,
        partyId: Number(row.party_id),
        invoiceVoucherId: Number(row.invoice_voucher_id),
        paymentVoucherId: Number(row.payment_voucher_id),
        amount: row.amount,
      },
      "dryRun"
    );
    if (result.reason || !result.difference || !result.voucherDate || !result.settledOn) continue;
    items.push({
      allocationId: Number(row.id),
      partyKind: row.party_kind,
      partyId: Number(row.party_id),
      invoiceVoucherId: Number(row.invoice_voucher_id),
      paymentVoucherId: Number(row.payment_voucher_id),
      amount: row.amount,
      currency: result.currency ?? "",
      difference: result.difference,
      nativeSettled: result.nativeSettled ?? "",
      settledOn: result.settledOn,
      voucherDate: result.voucherDate,
    });
  }
  const planHash = createHash("sha256")
    .update(
      JSON.stringify({
        companyId,
        items: items.map((item) => [item.allocationId, item.difference, item.voucherDate, item.currency]),
      })
    )
    .digest("hex");
  return { companyId, items, planHash };
}

export async function previewRealizedFxHistory(companyId: number): Promise<RealizedFxHistoryPlan> {
  return db.transaction((tx) => derivePlanTx(tx, companyId));
}

export interface RealizedFxHistoryApplyResult {
  plan: RealizedFxHistoryPlan;
  posted: { allocationId: number; voucherId: number; difference: string }[];
}

export async function applyRealizedFxHistory(
  companyId: number,
  input: { planHash: string; actor: { userId: string; username: string } }
): Promise<RealizedFxHistoryApplyResult> {
  return db.transaction(async (tx) => {
    // The allocation runs' locks: no allocation of the company is written or released meanwhile.
    await lockAllOpenItemKindsTx(tx, companyId);
    const plan = await derivePlanTx(tx, companyId);
    if (plan.planHash !== input.planHash) {
      throw new RealizedFxHistoryRefusal(409, PLAN_CHANGED_MESSAGE, {
        code: "REALIZED_FX_HISTORY_PLAN_CHANGED",
        message: PLAN_CHANGED_MESSAGE,
        planHash: plan.planHash,
      });
    }
    if (plan.items.length === 0) {
      throw new RealizedFxHistoryRefusal(400, NOTHING_MESSAGE, {
        code: "REALIZED_FX_HISTORY_NOTHING_TO_APPLY",
        message: NOTHING_MESSAGE,
      });
    }
    const posted: RealizedFxHistoryApplyResult["posted"] = [];
    for (const item of plan.items) {
      const result = await postRealizedFxForAllocationTx(tx, {
        companyId,
        allocationId: item.allocationId,
        partyKind: item.partyKind,
        partyId: item.partyId,
        invoiceVoucherId: item.invoiceVoucherId,
        paymentVoucherId: item.paymentVoucherId,
        amount: item.amount,
      });
      if (!result.posted || result.voucherId == null) {
        throw new RealizedFxHistoryRefusal(409, PLAN_CHANGED_MESSAGE, {
          code: "REALIZED_FX_HISTORY_PLAN_CHANGED",
          message: PLAN_CHANGED_MESSAGE,
          allocationId: item.allocationId,
        });
      }
      posted.push({ allocationId: item.allocationId, voucherId: result.voucherId, difference: item.difference });
    }
    await writeAuditEvent(
      {
        userId: input.actor.userId,
        username: input.actor.username,
        companyId,
        action: "create",
        tableName: "vouchers",
        recordIdentifier: `fx-realized-history:${plan.planHash.slice(0, 16)}`,
        changes: { realizedFxHistory: { new: { planHash: plan.planHash, items: plan.items, posted } } },
        reason: "Realized exchange differences of allocations settled before the automatic run was enabled",
      },
      tx
    );
    return { plan, posted };
  });
}

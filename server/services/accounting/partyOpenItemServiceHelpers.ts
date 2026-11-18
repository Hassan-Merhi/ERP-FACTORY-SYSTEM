// Extracted from ./partyOpenItemService.ts
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";
import { writeAuditEvent } from "../audit";
import {
  OpenItemError,
  money,
  positiveId,
  type EntryRow,
  type OpenItemDomain,
  type PartyOpenItemTarget,
} from "./partyOpenItemServiceValidateOpenItemTarget";

export function rowValue(row: EntryRow): { debit: Decimal; credit: Decimal; currency: string; verified: boolean } {
  const code = String(row.currency ?? "")
    .trim()
    .toUpperCase();
  const header = String(row.voucher_currency ?? "USD")
    .trim()
    .toUpperCase();
  const nativeAvailable = !!code && row.native_debit !== null && row.native_credit !== null;
  if (nativeAvailable) {
    return { debit: money(row.native_debit), credit: money(row.native_credit), currency: code, verified: true };
  }
  // A legacy non-USD line with no native amounts must never be matched based
  // on a guessed FX rate. Its base amount is displayed but marked unverified.
  return { debit: money(row.base_debit), credit: money(row.base_credit), currency: "USD", verified: header === "USD" };
}

export interface ApplyOpenItemMatch extends PartyOpenItemTarget {
  chargeEntryId: number;
  settlementEntryId: number;
  amount: string;
  idempotencyKey: string;
  actor: { userId: string; username: string };
  reason?: string | null;
}

export async function voidPartyOpenItemMatchTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    matchId: number;
    actor: { userId: string; username: string };
    reason: string;
  }
) {
  positiveId(input.companyId, "companyId");
  positiveId(input.matchId, "matchId");
  if (!input.reason.trim()) throw new OpenItemError("OPEN_ITEM_REASON_REQUIRED", "Reason is required", 400);
  await assertTransactionCompanyScope(tx, input.companyId);
  const record = resultRows<{
    id: number;
    domain: OpenItemDomain;
    party_id: number;
    voided_at: string | null;
    applied_on: string;
  }>(
    await tx.execute(sql`SELECT id,domain,party_id,voided_at::text,applied_on::text FROM accounting_open_item_matches
      WHERE id=${input.matchId} AND company_id=${input.companyId} FOR UPDATE`)
  )[0];
  if (!record) throw new OpenItemError("OPEN_ITEM_MATCH_NOT_FOUND", "Match not found", 404);
  if (record.voided_at) throw new OpenItemError("OPEN_ITEM_MATCH_VOIDED", "Match is already voided");
  // A realized FX voucher changes the GL party balance. Its linked
  // allocation cannot be silently cancelled while that journal is active.
  // First reverse the FX journal through the audited voucher reversal flow.
  const recognized = resultRows<{ voucher_id: number; reversed_id: number | null } & Record<string, unknown>>(
    await tx.execute(sql`
      SELECT r.voucher_id,reversal.id AS reversed_id
        FROM accounting_fx_realizations r
        JOIN vouchers v ON v.id=r.voucher_id AND v.company_id=r.company_id
        LEFT JOIN vouchers reversal ON reversal.reversal_of_voucher_id=v.id
          AND reversal.company_id=r.company_id AND reversal.deleted_at IS NULL
       WHERE r.company_id=${input.companyId} AND r.match_id=${input.matchId}
         AND v.deleted_at IS NULL LIMIT 1
    `)
  )[0];
  if (recognized && !recognized.reversed_id)
    throw new OpenItemError(
      "OPEN_ITEM_REALIZED_FX_POSTED",
      `Reverse the realized FX journal #${recognized.voucher_id} before cancelling this match`
    );

  await tx.execute(sql`SELECT erp_assert_accounting_date_open(${input.companyId},${record.applied_on}::date)`);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`open-item:${input.companyId}:${record.domain}:${record.party_id}`}))`
  );
  await tx.execute(sql`UPDATE accounting_open_item_matches SET
    voided_at=NOW(),voided_by=${input.actor.userId},void_reason=${input.reason}
    WHERE id=${input.matchId} AND company_id=${input.companyId} AND voided_at IS NULL`);
  await writeAuditEvent(
    {
      companyId: input.companyId,
      userId: input.actor.userId,
      username: input.actor.username,
      action: "update",
      tableName: "accounting_open_item_matches",
      recordId: input.matchId,
      recordIdentifier: `open-item:${input.matchId}`,
      changes: { voided: { old: false, new: true }, reason: { new: input.reason } },
    },
    tx
  );
  return { id: input.matchId, voided: true };
}

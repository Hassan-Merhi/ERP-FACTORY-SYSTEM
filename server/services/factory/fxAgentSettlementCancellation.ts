/**
 * Atomically cancel an FX agent EUR payout together with its posted USD voucher.
 * Only this path may detach the linked wallet operation; generic voucher
 * retirement is intentionally blocked while the operation is still present.
 *
 * The voucher and its GL lines remain in the audit trail, but no longer count
 * toward posted balances. The wallet payout is copied to the durable audit log
 * before it is removed from the active native EUR statement/replay.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../db";
import { writeAuditEvent } from "../audit";
import { retireVouchersTx, type VoucherRetirementActor } from "../accounting/voucherRetirement";
import { removeFactoryDaybookMirrorTx } from "../accounting/factoryDaybookMirrorRemoval";
import { fxAgentTablesExist, getFxAgentWalletSnapshot, loadFxAgentWallets } from "./fxAgentWalletDb";

type CancelOptions = {
  tx: DbTransaction;
  companyId: number;
  voucherId: number;
  actor: VoucherRetirementActor;
  asOfDate: string;
};

/**
 * Returns false if the voucher is not an FX wallet settlement.
 * Returns true only after both native EUR and the USD voucher are cancelled.
 * Every step is inside the caller's database transaction.
 */
export async function cancelFxAgentSettlementVoucherTx({
  tx, companyId, voucherId, actor, asOfDate,
}: CancelOptions): Promise<boolean> {
  if (!(await fxAgentTablesExist(tx))) return false;

  // Discover the wallet before locking it. All wallet writes take this same
  // row lock, so conversion, payment and cancellation cannot interleave.
  const found = await tx.execute(sql`
    SELECT wallet_id AS "walletId"
    FROM factory_fx_agent_wallet_operations
    WHERE company_id = ${companyId} AND voucher_id = ${voucherId}
  `);
  if (!found.rows.length) return false;
  if (found.rows.length !== 1) throw new Error("Multiple FX wallet operations linked to this voucher");
  const walletId = Number(found.rows[0].walletId);
  const locked = await tx.execute(sql`
    SELECT id FROM factory_fx_agent_wallets
    WHERE id = ${walletId} AND company_id = ${companyId} FOR UPDATE
  `);
  if (!locked.rows.length) throw new Error("Linked FX wallet is missing");

  const operations = await tx.execute(sql`
    SELECT id, kind, wallet_id AS "walletId", voucher_id AS "voucherId",
      effective_date::text AS date, source_currency AS "sourceCurrency",
      source_amount::text AS "sourceAmount", target_currency AS "targetCurrency",
      target_amount::text AS "targetAmount", rate_usd_per_eur::text AS rate,
      source_book_usd::text AS "sourceBookUsd", fx_gain_usd::text AS "fxGainUsd",
      target_kind AS "targetKind", target_id AS "targetId",
      request_key AS "requestKey", narration, created_by AS "createdBy"
    FROM factory_fx_agent_wallet_operations
    WHERE company_id = ${companyId} AND wallet_id = ${walletId}
      AND voucher_id = ${voucherId}
    FOR UPDATE
  `);
  if (operations.rows.length !== 1 || operations.rows[0].kind !== "EUR_SETTLEMENT") {
    throw new Error("FX payment link changed. Reload before cancelling");
  }
  const movement = operations.rows[0];
  const voucherRows = await tx.execute(sql`
    SELECT id, voucher_type AS "voucherType", deleted_at AS "deletedAt"
    FROM vouchers WHERE company_id = ${companyId} AND id = ${voucherId}
    FOR UPDATE
  `);
  if (voucherRows.rows.length !== 1 || voucherRows.rows[0].deletedAt) {
    throw new Error("FX payment was already cancelled or is missing");
  }
  if (!["Payment", "Journal"].includes(String(voucherRows.rows[0].voucherType))) {
    throw new Error("Linked FX settlement has an unexpected voucher type");
  }

  // Record the full native movement before removing the active financial row.
  // If audit, retirement, or reconciliation fails, the transaction rolls back.
  await writeAuditEvent({
    userId: actor.userId,
    username: actor.username,
    companyId,
    action: "delete",
    tableName: "factory_fx_agent_wallet_operations",
    recordId: Number(movement.id),
    recordIdentifier: String(movement.requestKey),
    changes: {
      nativeSettlement: { old: {
        id: Number(movement.id),
        walletId,
        voucherId,
        date: String(movement.date).slice(0, 10),
        eurPaid: String(movement.sourceAmount),
        usdPaid: String(movement.targetAmount),
        rateUsdPerEur: String(movement.rate),
        historicalUsdBasis: String(movement.sourceBookUsd),
        fxGainUsd: String(movement.fxGainUsd),
        beneficiaryKind: movement.targetKind,
        beneficiaryId: movement.targetId,
        narration: movement.narration,
        createdBy: movement.createdBy,
      } },
      reason: { new: "fx-agent-payment-cancel" },
    },
  }, tx);

  // Retire the posted voucher instead of hard-deleting GL entries. Remove the
  // wallet link first because the generic retirement service rightly refuses
  // any voucher with an active EUR settlement.
  const removed = await tx.execute(sql`
    DELETE FROM factory_fx_agent_wallet_operations
    WHERE company_id = ${companyId} AND wallet_id = ${walletId}
      AND voucher_id = ${voucherId} AND id = ${Number(movement.id)}
    RETURNING id
  `);
  if (removed.rows.length !== 1) throw new Error("Could not detach FX payment from native EUR wallet");
  const retired = await retireVouchersTx(tx, {
    companyId, voucherIds: [voucherId], reason: "fx-agent-payment-cancel", actor,
    metadata: { fxWalletId: walletId, fxWalletOperationId: Number(movement.id) },
  });
  if (retired.length !== 1 || retired[0].alreadyDeleted) {
    throw new Error("FX voucher could not be cancelled");
  }

  await removeFactoryDaybookMirrorTx({ tx, companyId, voucherId });
  const wallet = (await loadFxAgentWallets(companyId, undefined, tx)).find(w => w.id === walletId);
  if (!wallet) throw new Error("FX wallet no longer belongs to this account");
  const snapshot = await getFxAgentWalletSnapshot(wallet, asOfDate, tx);
  if (!snapshot.synchronized) {
    throw new Error("FX cancellation would leave native EUR and historical USD ledger out of sync");
  }
  return true;
}

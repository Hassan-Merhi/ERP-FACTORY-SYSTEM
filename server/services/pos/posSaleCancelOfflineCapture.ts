import { randomUUID } from "node:crypto";
import type { Request } from "express";
import type { DbTransaction } from "../../db";
import { capturePhase9PosSaleCancelTx } from "../../edge/phase9PosOutbox";

/**
 * Records a POS sale cancelled (voucher deleted) on the factory LAN server,
 * in the delete's transaction, for replay on the sale's "pos" stream. Owner
 * decision 2026-11-02.
 */
export async function capturePosSaleCancelOfflineTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    voucher: { id: number; voucherDate: string; clientSaleId?: string | null };
    req: Pick<Request, "session">;
  }
): Promise<void> {
  await capturePhase9PosSaleCancelTx(tx, {
    companyId: input.companyId,
    localVoucherId: input.voucher.id,
    actorUserId: String(input.req.session.userId),
    actorUsername: input.req.session.username || "unknown",
    requestId: randomUUID(),
    businessDate: String(input.voucher.voucherDate).slice(0, 10),
    voucherRef: { clientSaleId: input.voucher.clientSaleId ?? null, voucherId: input.voucher.id },
  });
}

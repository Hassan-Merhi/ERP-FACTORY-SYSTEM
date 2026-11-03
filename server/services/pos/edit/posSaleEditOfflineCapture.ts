import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { vouchers } from "@shared/schema";
import type { DbTransaction } from "../../../db";
import { capturePhase9PosSaleEditTx } from "../../../edge/phase9PosOutbox";
import { inventoryMoney, inventoryQuantity } from "../../../lib/inventoryMath";
import type { UpdatePosSaleParams } from "./posEditSaleTypes";

const ref = (value: unknown): number | null => {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
const day = (value: unknown): string | null => (value ? String(value).slice(0, 10) : null);

/**
 * Records a committed POS sale edit (a return or correction) made on the
 * factory LAN server, in the edit's transaction, for replay in the cloud on
 * the same "pos" stream as the sale. Owner decision 2026-11-02.
 */
export async function capturePosSaleEditOfflineTx(tx: DbTransaction, params: UpdatePosSaleParams): Promise<void> {
  const [voucher] = await tx
    .select({ clientSaleId: vouchers.clientSaleId, voucherDate: vouchers.voucherDate })
    .from(vouchers)
    .where(eq(vouchers.id, params.voucherId))
    .limit(1);
  const body = params.body;
  const paymentAccountType = String(body.paymentAccountType ?? "");
  await capturePhase9PosSaleEditTx(tx, {
    companyId: params.currentCompanyId,
    localVoucherId: params.voucherId,
    actorUserId: String(params.userId),
    actorUsername: params.username,
    requestId: randomUUID(),
    businessDate: day(body.voucherDate) ?? day(voucher?.voucherDate) ?? new Date().toISOString().slice(0, 10),
    voucherRef: { clientSaleId: voucher?.clientSaleId ?? null, voucherId: params.voucherId },
    edit: {
      description: typeof body.description === "string" && body.description ? body.description : null,
      isCreditSale: body.isCreditSale === true,
      locationId: ref(body.locationId),
      paymentAccountId: ref(body.paymentAccountId),
      paymentAccountType:
        paymentAccountType === "cash" || paymentAccountType === "bank" || paymentAccountType === "credit"
          ? paymentAccountType
          : null,
      voucherDate: day(body.voucherDate),
      items: (body.items as Array<Record<string, unknown>>).map((item) => ({
        existing: ref(item.id) !== null,
        stockItemId: Number(item.stockItemId),
        quantity: inventoryQuantity(item.quantity as string),
        sellingPrice: inventoryMoney(item.sellingPrice as string),
      })),
    },
  });
}

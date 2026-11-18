import { and, eq } from "drizzle-orm";
import { posShifts } from "@shared/schema";
import type { DbTransaction } from "../../../db";
import { posDaybookEditEligibility, posDaybookEditMessages } from "@shared/posDaybookEditPolicy";
import type { HandlerErrorResult, UpdatePosSaleParams, VoucherRow } from "./posEditSaleTypes";

/** Recheck the locked sale before inventory or accounting mutations. */
export async function validateLockedPosDaybookEdit(
  tx: DbTransaction,
  voucher: VoucherRow,
  params: UpdatePosSaleParams
): Promise<HandlerErrorResult | null> {
  const auth = params.posDaybookEditAuthorization;
  if (params.userRole !== "POS" || !auth) return null;

  const [shift] = voucher.shiftId
    ? await tx
        .select({ userId: posShifts.userId })
        .from(posShifts)
        .where(and(eq(posShifts.id, voucher.shiftId), eq(posShifts.companyId, params.currentCompanyId)))
        .limit(1)
    : [];

  const eligibility = posDaybookEditEligibility({
    originalDate: String(voucher.voucherDate),
    businessDate: auth.businessDate,
    editDays: auth.editDays,
    isOwnSale: shift?.userId === params.userId,
  });
  if (!eligibility.allowed) {
    return {
      status: 403,
      body: {
        code: "POS_SALE_EDIT_WINDOW_DENIED",
        message: eligibility.reason === "not-owner" ? posDaybookEditMessages.ownership : posDaybookEditMessages.date,
      },
    };
  }

  const body = params.body;
  if (body.voucherDate !== undefined && body.voucherDate !== voucher.voucherDate) {
    return { status: 403, body: { code: "POS_SALE_EDIT_DATE_LOCKED", message: posDaybookEditMessages.noRedate } };
  }
  if (
    (body.isCreditSale !== undefined && body.isCreditSale !== voucher.isCreditSale) ||
    body.paymentAccountType != null ||
    body.paymentAccountId != null
  ) {
    return { status: 403, body: { code: "POS_SALE_EDIT_PAYMENT_LOCKED", message: posDaybookEditMessages.noPaymentChange } };
  }
  if (body.locationId != null && Number(body.locationId) !== voucher.locationId) {
    return { status: 403, body: { code: "POS_SALE_EDIT_LOCATION_LOCKED", message: "POS cashiers cannot change the sale location." } };
  }
  return null;
}

import { and, eq } from "drizzle-orm";
import { posShifts, userCompanyRoles, userLocations } from "@shared/schema";
import { companyBusinessDate } from "../../accounting/companyBusinessDate";
import type { DbTransaction } from "../../../db";
import { posDaybookEditEligibility, posDaybookEditMessages } from "@shared/posDaybookEditPolicy";
import type { HandlerErrorResult, UpdatePosSaleParams, VoucherRow } from "./posEditSaleTypes";

/** Recheck the locked sale before inventory or accounting mutations. */
export async function validateLockedPosDaybookEdit(
  tx: DbTransaction,
  voucher: VoucherRow,
  params: UpdatePosSaleParams
): Promise<HandlerErrorResult | null> {
  if (params.userRole !== "POS") return null;
  if (!params.posDaybookEditAuthorization) {
    return {
      status: 403,
      body: { code: "POS_SALE_EDIT_AUTH_REQUIRED", message: posDaybookEditMessages.disabled },
    };
  }

  const [role] = await tx
    .select({
      role: userCompanyRoles.role,
      editDays: userCompanyRoles.daybookEditDays,
      viewOnly: userCompanyRoles.posViewOnly,
      assignedLocationId: userCompanyRoles.assignedLocationId,
    })
    .from(userCompanyRoles)
    .where(and(
      eq(userCompanyRoles.companyId, params.currentCompanyId),
      eq(userCompanyRoles.userId, params.userId)
    ))
    .limit(1);
  if (!role || role.role !== "POS" || role.viewOnly) {
    return {
      status: 403,
      body: { code: "POS_SALE_EDIT_ROLE_REVOKED", message: posDaybookEditMessages.viewOnly },
    };
  }

  const [location] = await tx
    .select({ id: userLocations.id })
    .from(userLocations)
    .where(and(
      eq(userLocations.userId, params.userId),
      eq(userLocations.companyId, params.currentCompanyId),
      eq(userLocations.locationId, Number(voucher.locationId))
    ))
    .limit(1);
  if (!voucher.locationId || (!location && role.assignedLocationId !== voucher.locationId)) {
    return {
      status: 403,
      body: { code: "POS_SALE_EDIT_LOCATION_REVOKED", message: posDaybookEditMessages.ownership },
    };
  }
  const businessDate = await companyBusinessDate(params.currentCompanyId, tx);

  const [shift] = voucher.shiftId
    ? await tx
        .select({ userId: posShifts.userId })
        .from(posShifts)
        .where(and(eq(posShifts.id, voucher.shiftId), eq(posShifts.companyId, params.currentCompanyId)))
        .limit(1)
    : [];

  const eligibility = posDaybookEditEligibility({
    originalDate: String(voucher.voucherDate),
    businessDate,
    editDays: role.editDays ?? 0,
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

  if (voucher.optional) {
    return { status: 403, body: { code: "POS_SALE_OPTIONAL", message: posDaybookEditMessages.optionalSale } };
  }

  const body = params.body;
  if (body.voucherDate !== undefined && body.voucherDate !== voucher.voucherDate) {
    return { status: 403, body: { code: "POS_SALE_EDIT_DATE_LOCKED", message: posDaybookEditMessages.noRedate } };
  }
  if (
    (body.isCreditSale !== undefined && Boolean(body.isCreditSale) !== Boolean(voucher.isCreditSale)) ||
    body.paymentAccountType != null ||
    body.paymentAccountId != null
  ) {
    return { status: 403, body: { code: "POS_SALE_EDIT_PAYMENT_LOCKED", message: posDaybookEditMessages.noPaymentChange } };
  }
  if (body.locationId != null && Number(body.locationId) !== voucher.locationId) {
    return { status: 403, body: { code: "POS_SALE_EDIT_LOCATION_LOCKED", message: posDaybookEditMessages.locationLocked } };
  }
  return null;
}

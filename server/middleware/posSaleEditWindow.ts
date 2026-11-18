import type { NextFunction, Request, Response } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { posShifts, userLocations, vouchers } from "@shared/schema";
import { db } from "../db";
import { canModifyDate } from "../auth";
import { companyBusinessDate } from "../services/accounting/companyBusinessDate";
import {
  ActiveCompanyPermissionContextError,
  getActiveCompanyPermissionContext,
} from "../services/security/activeCompanyPermissionContext";
import { posDaybookEditEligibility, posDaybookEditMessages } from "@shared/posDaybookEditPolicy";

declare global {
  namespace Express {
    interface Request {
      posDaybookEditAuthorization?: { editDays: number; businessDate: string };
    }
  }
}

/** Applies to both PUT and the legacy PATCH sale-edit route. No client clock/header trust. */
export async function requirePosSaleEditWindow(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const context = await getActiveCompanyPermissionContext(req);
    if (req.user) {
      req.user.role = context.role;
      req.user.canSellNegativeStock = context.canSellNegativeStock;
      req.user.posViewOnly = context.posViewOnly;
    }
    if (context.role !== "POS") {
      canModifyDate("voucherDate")(req, res, next);
      return;
    }

    if (context.posViewOnly) {
      res.status(403).json({ code: "POS_SALE_EDIT_VIEW_ONLY", message: posDaybookEditMessages.viewOnly });
      return;
    }

    const voucherId = Number(req.params.id);
    if (!Number.isSafeInteger(voucherId) || voucherId <= 0) {
      res.status(400).json({ code: "POS_SALE_ID_INVALID", message: "Invalid sale ID" });
      return;
    }

    const [sale] = await db
      .select({
        id: vouchers.id,
        locationId: vouchers.locationId,
        voucherDate: vouchers.voucherDate,
        isCreditSale: vouchers.isCreditSale,
        shiftId: vouchers.shiftId,
        shiftUserId: posShifts.userId,
      })
      .from(vouchers)
      .leftJoin(
        posShifts,
        and(
          eq(posShifts.id, vouchers.shiftId),
          eq(posShifts.companyId, context.companyId)
        )
      )
      .where(
        and(
          eq(vouchers.id, voucherId),
          eq(vouchers.companyId, context.companyId),
          eq(vouchers.voucherType, "Sales"),
          isNull(vouchers.deletedAt)
        )
      )
      .limit(1);

    if (!sale) {
      res.status(404).json({ code: "POS_SALE_NOT_FOUND", message: "Sale not found" });
      return;
    }

    const [locationAccess] = await db
      .select({ id: userLocations.id })
      .from(userLocations)
      .where(
        and(
          eq(userLocations.userId, context.userId),
          eq(userLocations.companyId, context.companyId),
          eq(userLocations.locationId, Number(sale.locationId))
        )
      )
      .limit(1);
    if (!sale.locationId || (!locationAccess && context.assignedLocationId !== sale.locationId)) {
      res.status(403).json({ code: "POS_SALE_LOCATION_DENIED", message: "Sale location is not assigned to this cashier." });
      return;
    }

    const businessDate = await companyBusinessDate(context.companyId);
    const eligibility = posDaybookEditEligibility({
      originalDate: String(sale.voucherDate),
      businessDate,
      editDays: context.daybookEditDays,
      isOwnSale: sale.shiftId != null && sale.shiftUserId === context.userId,
      viewOnly: context.posViewOnly,
    });
    if (!eligibility.allowed) {
      res.status(403).json({
        code: `POS_SALE_EDIT_${eligibility.reason.toUpperCase().replace(/-/g, "_")}`,
        message:
          eligibility.reason === "not-owner"
            ? posDaybookEditMessages.ownership
            : eligibility.reason === "disabled"
              ? posDaybookEditMessages.disabled
              : posDaybookEditMessages.date,
      });
      return;
    }

    if (req.body?.voucherDate !== undefined && req.body.voucherDate !== sale.voucherDate) {
      res.status(403).json({ code: "POS_SALE_EDIT_DATE_LOCKED", message: posDaybookEditMessages.noRedate });
      return;
    }

    if (
      typeof req.body?.isCreditSale !== "boolean" ||
      req.body.isCreditSale !== Boolean(sale.isCreditSale) ||
      req.body?.paymentAccountType != null ||
      req.body?.paymentAccountId != null
    ) {
      res.status(403).json({ code: "POS_SALE_EDIT_PAYMENT_LOCKED", message: posDaybookEditMessages.noPaymentChange });
      return;
    }

    if (req.body?.locationId !== undefined && Number(req.body.locationId) !== sale.locationId) {
      res.status(403).json({ code: "POS_SALE_EDIT_LOCATION_LOCKED", message: "POS cashiers cannot change the sale location." });
      return;
    }

    req.posDaybookEditAuthorization = { editDays: context.daybookEditDays, businessDate };
    next();
  } catch (error) {
    if (error instanceof ActiveCompanyPermissionContextError) {
      res.status(error.status).json({ code: error.code, message: error.message });
      return;
    }
    next(error);
  }
}

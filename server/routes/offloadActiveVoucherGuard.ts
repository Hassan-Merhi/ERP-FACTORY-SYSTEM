import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, isNull, like, or } from "drizzle-orm";
import { containerOffloads, containers, vouchers } from "@shared/schema";
import { requireAuth } from "../auth";
import { db } from "../db";
import { logger } from "../lib/logger";
import { getErrorMessage } from "../lib/httpHandlers";

type OffloadDetailResponse = {
  liveCharges?: unknown;
  poCharges?: { total?: number | string | null };
};

/**
 * Keep the offload-detail response's live charge totals limited to active
 * vouchers. The legacy detail handler matches voucher-number history, which can
 * include soft-deleted DUTY/TRANS/etc. rows after a reverse/re-offload. Those
 * retired rows must not be counted a second time.
 *
 * This guard runs before the existing detail route and replaces only the
 * liveCharges portion of its JSON response. The underlying route remains the
 * source of truth for the rest of the payload.
 */
export function registerOffloadActiveVoucherGuard(app: Express) {
  app.use(
    "/api/offloads/:id",
    requireAuth,
    async (req: Request, res: Response, next: NextFunction) => {
      if (req.method !== "GET") return next();

      const offloadId = Number.parseInt(req.params.id, 10);
      if (!Number.isInteger(offloadId) || offloadId <= 0) return next();

      try {
        const [offload] = await db
          .select({
            id: containerOffloads.id,
            companyId: containers.companyId,
            containerNumber: containers.containerNumber,
            totalBales: containerOffloads.totalBales,
          })
          .from(containerOffloads)
          .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
          .where(eq(containerOffloads.id, offloadId))
          .limit(1);

        if (!offload) return next();

        const cn = offload.containerNumber;
        const activeVouchers = await db
          .select({ voucherNumber: vouchers.voucherNumber, totalAmount: vouchers.totalAmount })
          .from(vouchers)
          .where(
            and(
              eq(vouchers.companyId, offload.companyId),
              isNull(vouchers.deletedAt),
              or(
                like(vouchers.voucherNumber, `DUTY-${cn}-%`),
                like(vouchers.voucherNumber, `OFFICE-${cn}-%`),
                like(vouchers.voucherNumber, `TRANS-${cn}-%`),
                like(vouchers.voucherNumber, `XFER-${cn}-%`),
                like(vouchers.voucherNumber, `CHG-${cn}-%`)
              )
            )
          );

        const sumByPrefix = (prefix: string) =>
          activeVouchers
            .filter((voucher) => voucher.voucherNumber.startsWith(`${prefix}-${cn}-`))
            .reduce((sum, voucher) => sum + Number(voucher.totalAmount || 0), 0);

        const duties = sumByPrefix("DUTY");
        const officeCharges = sumByPrefix("OFFICE");
        const transportFees = sumByPrefix("TRANS");
        const transferCharges = sumByPrefix("XFER");
        const additionalCharges = sumByPrefix("CHG");
        const totalOffloadCharges =
          duties + officeCharges + transportFees + transferCharges + additionalCharges;
        const totalBales = Number(offload.totalBales || 0);

        const originalJson = res.json.bind(res);
        res.json = ((body: unknown) => {
          if (body && typeof body === "object" && "liveCharges" in body) {
            const responseBody = body as OffloadDetailResponse;
            const poTotal = Number(responseBody.poCharges?.total || 0);
            const totalAllCharges = totalOffloadCharges + poTotal;
            responseBody.liveCharges = {
              duties,
              officeCharges,
              transportFees,
              transferCharges,
              additionalCharges,
              totalOffloadCharges,
              totalAllCharges,
              additionalCostPerBale:
                totalBales > 0 ? Math.round((totalAllCharges / totalBales) * 100) / 100 : 0,
              hasVouchers: activeVouchers.length > 0,
            };
          }
          return originalJson(body);
        }) as Response["json"];

        return next();
      } catch (error: unknown) {
        logger.warn("[offload-active-voucher-guard] Falling back to legacy live charge totals", {
          error: getErrorMessage(error),
          offloadId,
        });
        return next();
      }
    }
  );
}

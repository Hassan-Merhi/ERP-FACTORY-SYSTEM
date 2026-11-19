// Extracted from ./registerOffloadRoutesPart1.ts
import type { Express } from "express";
import { sortOffloadItemsByName } from "@shared/offloadItemSort";
import { and, eq, like, or, sql } from "drizzle-orm";
import { db } from "../db";
import { requireAuth } from "../auth";
import { sumMoney, toMoney } from "../lib/money";
import { assertActiveCompanyAccess, sendCompanyAccessError } from "../security/companyAccessBoundary";
import {
  containerCharges,
  containerOffloadItems,
  containerOffloads,
  containers,
  locations,
  purchaseOrders,
  stockItems,
  vouchers,
} from "@shared/schema";
import { resultRows } from "../lib/queryResult";

export function registerOffloadRoutesPart3(app: Express) {
  // Get full offload detail with items for daybook view
  app.get("/api/offloads/:id", requireAuth, async (req, res) => {
    try {
      const access = await assertActiveCompanyAccess(req);
      const offloadId = parseInt(req.params.id);
      if (isNaN(offloadId)) return res.status(400).json({ message: "Invalid offload ID" });

      const [offload] = await db
        .select({
          id: containerOffloads.id,
          containerId: containerOffloads.containerId,
          containerNumber: containers.containerNumber,
          locationId: containerOffloads.locationId,
          locationName: locations.name,
          duties: containerOffloads.duties,
          officeCharges: containerOffloads.officeCharges,
          transferCharges: containerOffloads.transferCharges,
          transportFees: containerOffloads.transportFees,
          totalCharges: containerOffloads.totalCharges,
          totalBales: containerOffloads.totalBales,
          additionalCostPerBale: containerOffloads.additionalCostPerBale,
          offloadedAt: containerOffloads.offloadedAt,
          containerChargesTotal: containers.chargesTotal,
          optional: containerOffloads.optional,
          companyId: containers.companyId,
        })
        .from(containerOffloads)
        .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
        .leftJoin(locations, eq(containerOffloads.locationId, locations.id))
        .where(eq(containerOffloads.id, offloadId))
        .execute();

      if (!offload) return res.status(404).json({ message: "Offload not found" });
      if (offload.companyId !== access.activeCompanyId) {
        return res.status(403).json({ message: "No access to this company", code: "COMPANY_ACCESS_DENIED" });
      }

      const items = await db
        .select({
          id: containerOffloadItems.id,
          stockItemId: containerOffloadItems.stockItemId,
          stockItemName: stockItems.name,
          stockItemCode: stockItems.code,
          quantity: containerOffloadItems.quantity,
          rate: containerOffloadItems.rate,
          totalValue: containerOffloadItems.totalValue,
        })
        .from(containerOffloadItems)
        .leftJoin(stockItems, eq(containerOffloadItems.stockItemId, stockItems.id))
        .where(eq(containerOffloadItems.offloadId, offloadId))
        .execute();

      // Return correction is a separate, immutable debit-note/stock-issue event.
      // Keep original offload lines for accounting provenance, expose net quantities
      // for the offload invoice display instead of rewriting a posted receipt.
      // A deployment without the controlled migration must not break existing
      // offload invoice reads. The supplier return writer still requires it.
      let returnQuantities: Array<{ offload_item_id: number; returned_qty: string }> = [];
      try {
        returnQuantities = resultRows<{ offload_item_id: number; returned_qty: string }>(
          await db.execute(sql`
            SELECT l.offload_item_id, SUM(l.quantity)::text AS returned_qty
              FROM erp_supplier_return_lines l
             WHERE l.company_id=${access.activeCompanyId} AND l.offload_id=${offloadId}
             GROUP BY l.offload_item_id
          `)
        );
      } catch (error) {
        const dbError = error as { code?: string; cause?: { code?: string } };
        if (dbError.code !== "42P01" && dbError.cause?.code !== "42P01") throw error;
      }
      const returnedByItem = new Map(returnQuantities.map((r) => [Number(r.offload_item_id), toMoney(r.returned_qty)]));
      const itemsWithReturns = items.map((item) => {
        const returned = returnedByItem.get(item.id) ?? toMoney(0);
        const net = toMoney(item.quantity).minus(returned);
        return { ...item, returnedQty: returned.toFixed(3), netQty: net.toFixed(3) };
      });
      const netTotalBales = itemsWithReturns
        .reduce((sum, item) => sum.plus(toMoney(item.netQty)), toMoney(0))
        .toFixed(3);

      // Fetch PO-level charges for the container (freight, fumigation, surcharge, documentCharges, discount, otherCharges)
      const pos = await db
        .select({
          id: purchaseOrders.id,
          poNumber: purchaseOrders.poNumber,
          freight: purchaseOrders.freight,
          surcharge: purchaseOrders.surcharge,
          fumigation: purchaseOrders.fumigation,
          documentCharges: purchaseOrders.documentCharges,
          discount: purchaseOrders.discount,
          otherCharges: purchaseOrders.otherCharges,
        })
        .from(purchaseOrders)
        .where(eq(purchaseOrders.containerId, offload.containerId))
        .execute();

      // Aggregate PO charges for display
      const poFreight = sumMoney(pos.map((p) => p.freight)).toNumber();
      const poSurcharge = sumMoney(pos.map((p) => p.surcharge)).toNumber();
      const poFumigation = sumMoney(pos.map((p) => p.fumigation)).toNumber();
      const poDocumentCharges = sumMoney(pos.map((p) => p.documentCharges)).toNumber();
      const poDiscount = sumMoney(pos.map((p) => p.discount)).toNumber();
      const poOtherCharges = sumMoney(pos.map((p) => p.otherCharges)).toNumber();

      // Fetch additional charges (fumigation, misc charges attached to the container)
      const additionalCharges = await db
        .select({
          id: containerCharges.id,
          chargeType: containerCharges.chargeType,
          amount: containerCharges.amount,
        })
        .from(containerCharges)
        .where(eq(containerCharges.containerId, offload.containerId))
        .execute();

      const poCharges = {
        freight: poFreight,
        surcharge: poSurcharge,
        fumigation: poFumigation,
        documentCharges: poDocumentCharges,
        discount: poDiscount,
        otherCharges: poOtherCharges,
        total: toMoney(offload.containerChargesTotal).toNumber(),
      };

      // Fetch LIVE voucher totals for this container so external edits are reflected immediately
      // Pattern: DUTY-{containerNumber}-*, OFFICE-{containerNumber}-*, TRANS-{containerNumber}-*, XFER-{containerNumber}-*, CHG-{containerNumber}-*
      const cn = offload.containerNumber;
      const liveVouchers = await db
        .select({ voucherNumber: vouchers.voucherNumber, totalAmount: vouchers.totalAmount })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, offload.companyId),
            or(
              like(vouchers.voucherNumber, `DUTY-${cn}-%`),
              like(vouchers.voucherNumber, `OFFICE-${cn}-%`),
              like(vouchers.voucherNumber, `TRANS-${cn}-%`),
              like(vouchers.voucherNumber, `XFER-${cn}-%`),
              like(vouchers.voucherNumber, `CHG-${cn}-%`)
            )
          )
        )
        .execute();

      const sumByPrefix = (prefix: string) =>
        sumMoney(liveVouchers.filter((v) => v.voucherNumber.startsWith(`${prefix}-${cn}-`)).map((v) => v.totalAmount));

      const liveDuties = sumByPrefix("DUTY");
      const liveOfficeCharges = sumByPrefix("OFFICE");
      const liveTransportFees = sumByPrefix("TRANS");
      const liveTransferCharges = sumByPrefix("XFER");
      const liveAddlCharges = sumByPrefix("CHG");

      const liveTotalOffloadCharges = sumMoney([
        liveDuties,
        liveOfficeCharges,
        liveTransportFees,
        liveTransferCharges,
        liveAddlCharges,
      ]);
      const liveTotalAllCharges = liveTotalOffloadCharges.plus(toMoney(offload.containerChargesTotal));
      const totalBales = toMoney(offload.totalBales);
      // Exact, then rounded half up to cents; the float division could land a
      // half cent below its true value and round down.
      const liveAdditionalCostPerBale = totalBales.greaterThan(0)
        ? liveTotalAllCharges.dividedBy(totalBales).toDecimalPlaces(2).toNumber()
        : 0;

      const liveCharges = {
        duties: liveDuties.toNumber(),
        officeCharges: liveOfficeCharges.toNumber(),
        transportFees: liveTransportFees.toNumber(),
        transferCharges: liveTransferCharges.toNumber(),
        additionalCharges: liveAddlCharges.toNumber(),
        totalOffloadCharges: liveTotalOffloadCharges.toNumber(),
        totalAllCharges: liveTotalAllCharges.toNumber(),
        additionalCostPerBale: liveAdditionalCostPerBale,
        hasVouchers: liveVouchers.length > 0,
      };

      res.json({
        ...offload,
        items: sortOffloadItemsByName(itemsWithReturns),
        netTotalBales,
        poCharges,
        additionalCharges,
        liveCharges,
      });
    } catch (error: unknown) {
      return sendCompanyAccessError(res, error);
    }
  });
}

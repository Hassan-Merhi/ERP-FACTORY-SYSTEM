// Extracted from ./registerOrderPricingRoutes.ts
import { getErrorMessage } from "../../../lib/httpHandlers";
import type { Express, Request, Response } from "express";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { recalculateOrderTotals } from "../_helpers";
import { customerOrderBales, customerOrders, customerProformaLines, customerProformas } from "@shared/schema";
import { and, eq, sql } from "drizzle-orm";
import { moneyString, parseMoneyInput, toMoney } from "../../../lib/money";
import { lockCustomerOrderTx, syncOrderTotalsTx } from "./orderChargeLedger";
import {
  PricingHttpError,
  changedPrice,
  notCancelled,
  orderIdOf,
  orderWithDetails,
  pricingErrorResponse,
  repriceOrderTx,
  type PriceUpdate,
} from "./repriceOrderTx";

export function registerOrderPricingRoutesPart1(app: Express) {
  // Apply a specific proforma's prices to all bales in an order (by articleCode match)
  app.post(
    "/api/factory/customer-orders/:id/apply-proforma-prices",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const ids = orderIdOf(req, res);
        if (!ids) return;
        const { companyId, orderId } = ids;
        const { proformaId } = req.body;
        if (!proformaId) return res.status(400).json({ message: "proformaId is required" });

        const [orderPreview] = await db
          .select({ status: customerOrders.status })
          .from(customerOrders)
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
        if (!orderPreview) return res.status(404).json({ message: "Order not found" });
        if (orderPreview.status === "CANCELLED")
          return res.status(400).json({ message: "Cannot reprice a cancelled order" });

        // Validate proforma belongs to this company
        const [proforma] = await db
          .select()
          .from(customerProformas)
          .where(and(eq(customerProformas.id, proformaId), eq(customerProformas.companyId, companyId)));
        if (!proforma) return res.status(404).json({ message: "Proforma not found" });

        const proformaLines = await db
          .select()
          .from(customerProformaLines)
          .where(eq(customerProformaLines.proformaId, proformaId));

        if (proformaLines.length === 0)
          return res.status(400).json({ message: "Selected proforma has no price lines" });

        // Build articleCode → price map from proforma
        const priceMap = new Map<string, string>();
        for (const pl of proformaLines) {
          if (pl.articleCode && pl.pricePerBale != null) {
            priceMap.set(pl.articleCode.toLowerCase().trim(), pl.pricePerBale);
          }
        }

        const repriced = await db.transaction((tx) =>
          repriceOrderTx(
            tx,
            companyId,
            orderId,
            notCancelled,
            async (_order, orderBales) => {
              const updates: PriceUpdate[] = [];
              for (const bale of orderBales) {
                const key = bale.articleCode?.toLowerCase().trim();
                if (!key) continue;
                const price = changedPrice(priceMap.get(key) || null, bale.priceUsed);
                if (price) updates.push({ baleRowId: bale.id, price });
              }
              return updates;
            },
            "Order has no bales"
          )
        );

        res.json(await orderWithDetails(orderId, repriced));
      } catch (error: unknown) {
        pricingErrorResponse(res, error, "Error applying proforma prices:");
      }
    }
  );

  app.patch(
    "/api/factory/customer-orders/:id/bales/reprice-article",
    requireAuth,
    async (req: Request, res: Response) => {
      try {
        const ids = orderIdOf(req, res);
        if (!ids) return;
        const { companyId, orderId } = ids;
        const { articleCode, pricePerBale } = req.body;

        if (!articleCode || pricePerBale === undefined || pricePerBale === null) {
          return res.status(400).json({ message: "articleCode and pricePerBale are required" });
        }

        const price = parseMoneyInput(pricePerBale);
        if (!price || price.lessThan(0)) {
          return res.status(400).json({ message: "Invalid price value" });
        }

        await db.transaction(async (tx) => {
          const order = await lockCustomerOrderTx(tx, companyId, orderId);
          if (!order) throw new PricingHttpError(404, "Order not found");
          await tx
            .update(customerOrderBales)
            .set({ priceUsed: moneyString(price) })
            .where(and(eq(customerOrderBales.orderId, orderId), eq(customerOrderBales.articleCode, articleCode)));
          await recalculateOrderTotals(tx, orderId);
          await syncOrderTotalsTx(tx, companyId, orderId, { daybook: false });
        });

        const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
        res.json(updatedOrder);
      } catch (error: unknown) {
        pricingErrorResponse(res, error, "Error repricing article:");
      }
    }
  );

  app.post("/api/factory/repair-perkg-prices", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // Find all LOADING / PENDING_VERIFICATION orders that have a proforma
      const ordersToScan = await db
        .select({ id: customerOrders.id, proformaIdUsed: customerOrders.proformaIdUsed })
        .from(customerOrders)
        .where(
          and(
            eq(customerOrders.companyId, companyId),
            sql`${customerOrders.status} IN ('LOADING', 'PENDING_VERIFICATION')`,
            sql`${customerOrders.proformaIdUsed} IS NOT NULL`
          )
        );

      let ordersScanned = 0;
      let balesRepaired = 0;
      const changedOrderIds: number[] = [];
      const errors: string[] = [];

      for (const order of ordersToScan) {
        ordersScanned++;
        try {
          // Fetch all proforma lines for this order's proforma that use per_kg
          const proformaPerKgLines = await db
            .select({
              articleCode: customerProformaLines.articleCode,
              pricingMode: customerProformaLines.pricingMode,
              pricePerKg: customerProformaLines.pricePerKg,
            })
            .from(customerProformaLines)
            .where(
              and(
                eq(customerProformaLines.proformaId, order.proformaIdUsed!),
                sql`${customerProformaLines.pricingMode} = 'per_kg'`,
                sql`${customerProformaLines.pricePerKg} IS NOT NULL AND ${customerProformaLines.pricePerKg}::numeric > 0`
              )
            );

          if (proformaPerKgLines.length === 0) continue;

          const perKgMap = new Map<string, ReturnType<typeof toMoney>>();
          for (const pl of proformaPerKgLines) {
            if (pl.articleCode && pl.pricePerKg) {
              perKgMap.set(pl.articleCode.toLowerCase(), toMoney(String(pl.pricePerKg)));
            }
          }

          // These orders are not finalized (LOADING / PENDING_VERIFICATION): no
          // invoice journal or customer balance moves; the order row is locked.
          const repaired = await db.transaction(async (tx) => {
            const locked = await lockCustomerOrderTx(tx, companyId, order.id);
            if (!locked) return 0;
            // Find all bales in this order that match a per_kg article and have priceUsed = 0
            const bales = await tx
              .select({
                id: customerOrderBales.id,
                articleCode: customerOrderBales.articleCode,
                weight: customerOrderBales.weight,
                priceUsed: customerOrderBales.priceUsed,
              })
              .from(customerOrderBales)
              .where(eq(customerOrderBales.orderId, order.id));

            let count = 0;
            for (const bale of bales) {
              const key = (bale.articleCode || "").toLowerCase();
              const pkgRate = perKgMap.get(key);
              if (!pkgRate || pkgRate.isZero()) continue;
              if (!toMoney(String(bale.priceUsed || "0")).isZero()) continue; // already repaired — skip (idempotent)
              // Exact: 0.5 kg at 4.35 is 2.18; the float product gave 2.17.
              const newPrice = moneyString(toMoney(String(bale.weight || "0")).times(pkgRate));
              await tx
                .update(customerOrderBales)
                .set({ priceUsed: newPrice })
                .where(eq(customerOrderBales.id, bale.id));
              count++;
            }
            if (count > 0) await recalculateOrderTotals(tx, order.id);
            return count;
          });

          if (repaired > 0) {
            balesRepaired += repaired;
            changedOrderIds.push(order.id);
          }
        } catch (err: unknown) {
          errors.push(`Order ${order.id}: ${getErrorMessage(err)}`);
        }
      }

      res.json({ ordersScanned, balesRepaired, changedOrderIds, errors });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

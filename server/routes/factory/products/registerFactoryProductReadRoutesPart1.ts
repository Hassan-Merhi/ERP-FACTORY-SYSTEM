// Extracted from ./productReadRoutes.ts
import type { Express, Request, Response } from "express";
import { parseId } from "../../../lib/parseId";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factoryBaleProducts,
  factoryBales,
  customerOrders,
  customerOrderBales,
  customers,
  locations,
} from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";
import { plusMoney, sumMoney } from "../../../lib/money";

export function registerFactoryProductReadRoutesPart1(app: Express) {
  app.get("/api/factory/bale-product-detail/:productId", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const productId = parseId(req.params.productId);
      if (productId === null) return res.status(400).json({ message: "Invalid id" });
      if (!productId) return res.status(400).json({ message: "Invalid product ID" });

      const [product] = await db
        .select()
        .from(factoryBaleProducts)
        .where(and(eq(factoryBaleProducts.id, productId), eq(factoryBaleProducts.companyId, companyId)));
      if (!product) return res.status(404).json({ message: "Product not found" });

      const articleCode = product.articleCode;

      // 1. Pressed/Printed: bales grouped by entry date
      const allBales = await db
        .select({
          createdAt: factoryBales.createdAt,
          pressedAt: factoryBales.pressedAt,
          weightKg: factoryBales.weightKg,
          totalCost: factoryBales.totalCost,
          status: factoryBales.status,
        })
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            eq(factoryBales.productId, productId),
            inArray(factoryBales.status, ["IN_STOCK", "SOLD", "REMOVED", "DELETED", "DISPATCHED"])
          )
        )
        .orderBy(factoryBales.createdAt);

      const pressedMap = new Map<string, { date: string; qty: number; totalWeight: number; totalCost: number }>();
      for (const bale of allBales) {
        const dateKey = ((bale.pressedAt || bale.createdAt) as Date).toISOString().split("T")[0];
        const existing = pressedMap.get(dateKey) || { date: dateKey, qty: 0, totalWeight: 0, totalCost: 0 };
        existing.qty += 1;
        existing.totalWeight = plusMoney(existing.totalWeight, bale.weightKg);
        existing.totalCost = plusMoney(existing.totalCost, bale.totalCost);
        pressedMap.set(dateKey, existing);
      }
      const pressed = Array.from(pressedMap.values()).sort((a, b) => b.date.localeCompare(a.date));

      // 2. Sales: finalized orders for this article code
      const sales = [];
      // 3. Loaded/OTW: loading-status orders for this article code
      const loaded = [];

      if (articleCode) {
        const orderBalesForProduct = await db
          .select({
            orderId: customerOrderBales.orderId,
            weight: customerOrderBales.weight,
            priceUsed: customerOrderBales.priceUsed,
          })
          .from(customerOrderBales)
          .where(eq(customerOrderBales.articleCode, articleCode));

        if (orderBalesForProduct.length > 0) {
          const orderIds = [...new Set(orderBalesForProduct.map((b) => b.orderId))];

          const allRelevantOrders = await db
            .select({
              id: customerOrders.id,
              invoiceNumber: customerOrders.invoiceNumber,
              orderDate: customerOrders.orderDate,
              customerId: customerOrders.customerId,
              status: customerOrders.status,
              containerNumber: customerOrders.containerNumber,
            })
            .from(customerOrders)
            .where(and(eq(customerOrders.companyId, companyId), inArray(customerOrders.id, orderIds)));

          for (const order of allRelevantOrders) {
            const balesInOrder = orderBalesForProduct.filter((b) => b.orderId === order.id);
            const qty = balesInOrder.length;
            const exactTotal = sumMoney(balesInOrder.map((b) => b.priceUsed));
            const total = exactTotal.toNumber();
            const pricePerBale = qty > 0 ? exactTotal.dividedBy(qty).toNumber() : 0;

            const [customer] = await db
              .select({ legalName: customers.legalName })
              .from(customers)
              .where(eq(customers.id, order.customerId));

            const entry = {
              orderId: order.id,
              invoiceNumber: order.invoiceNumber || `Order #${order.id}`,
              orderDate: order.orderDate,
              containerNumber: order.containerNumber,
              customerName: customer?.legalName || "Unknown",
              qty,
              pricePerBale: pricePerBale.toFixed(2),
              total: total.toFixed(2),
              status: order.status,
            };

            if (order.status === "FINALIZED") {
              sales.push(entry);
            } else if (["LOADING", "PENDING_VERIFICATION", "VERIFIED"].includes(order.status)) {
              loaded.push(entry);
            }
          }

          sales.sort((a, b) => b.orderDate.localeCompare(a.orderDate));
          loaded.sort((a, b) => b.orderDate.localeCompare(a.orderDate));
        }
      }

      // Current stock: IN_STOCK + FINALIZED bales grouped by location
      const inStockBales = await db
        .select({
          id: factoryBales.id,
          weightKg: factoryBales.weightKg,
          erpLocationId: factoryBales.erpLocationId,
        })
        .from(factoryBales)
        .where(
          and(
            eq(factoryBales.companyId, companyId),
            eq(factoryBales.productId, productId),
            eq(factoryBales.status, "IN_STOCK")
          )
        );

      const locStockMap = new Map<
        number,
        { locationId: number; locationName: string; qty: number; totalWeight: number }
      >();
      for (const bale of inStockBales) {
        const locId = bale.erpLocationId ?? 0;
        const existing = locStockMap.get(locId) ?? {
          locationId: locId,
          locationName: "Unknown",
          qty: 0,
          totalWeight: 0,
        };
        existing.qty += 1;
        existing.totalWeight = plusMoney(existing.totalWeight, bale.weightKg);
        locStockMap.set(locId, existing);
      }
      const locIds = [...locStockMap.keys()].filter((id) => id > 0);
      if (locIds.length > 0) {
        const locRecords = await db
          .select({ id: locations.id, name: locations.name })
          .from(locations)
          .where(inArray(locations.id, locIds));
        for (const loc of locRecords) {
          const entry = locStockMap.get(loc.id);
          if (entry) entry.locationName = loc.name;
        }
      }
      const currentStock = {
        totalQty: inStockBales.length,
        totalWeight: sumMoney(inStockBales.map((b) => b.weightKg)).toNumber(),
        locations: Array.from(locStockMap.values()).sort((a, b) => b.qty - a.qty),
      };

      return res.json({ product, pressed, sales, loaded, currentStock });
    } catch (error: unknown) {
      logger.error("Error fetching bale product detail:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

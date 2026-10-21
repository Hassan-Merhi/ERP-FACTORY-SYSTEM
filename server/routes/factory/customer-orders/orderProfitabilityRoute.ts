/**
 * GET /api/factory/customer-orders/:id/profitability: per-line selling value
 * against the catalogue production price, gated by the user's cost visibility.
 * Extracted from orderCrudRoutes.ts and registered from the same place.
 */
import type { Express, Request, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { customerOrderLines, customerOrders, customers, factoryBaleProducts } from "@shared/schema";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import { toMoney } from "../../../lib/money";
import { getExportPriceVisibility } from "../../../helpers/exportVisibility";

export function registerOrderProfitabilityRoute(app: Express): void {
  app.get("/api/factory/customer-orders/:id/profitability", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });

      // Respect per-user cost visibility settings — same gate as stock/proforma/order exports
      const vis = await getExportPriceVisibility(req);
      const hideCostData = vis.hideCost;

      const [order] = await db
        .select({
          id: customerOrders.id,
          status: customerOrders.status,
          invoiceNumber: customerOrders.invoiceNumber,
          customerName: customers.legalName,
        })
        .from(customerOrders)
        .leftJoin(customers, eq(customerOrders.customerId, customers.id))
        .where(and(eq(customerOrders.id, id), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Order not found" });

      const lines = await db.select().from(customerOrderLines).where(eq(customerOrderLines.orderId, id));
      const articleCodes = lines.map((l) => l.articleCode).filter(Boolean);

      const products =
        articleCodes.length > 0
          ? await db
              .select({
                articleCode: factoryBaleProducts.articleCode,
                productionPrice: factoryBaleProducts.productionPrice,
                name: factoryBaleProducts.name,
              })
              .from(factoryBaleProducts)
              .where(
                and(
                  eq(factoryBaleProducts.companyId, companyId),
                  inArray(factoryBaleProducts.articleCode, articleCodes)
                )
              )
          : [];

      const productMap: Record<string, { productionPrice: string | null; name: string }> = {};
      for (const p of products) {
        if (p.articleCode) productMap[p.articleCode] = { productionPrice: p.productionPrice, name: p.name };
      }

      let totalSelling = 0;
      let totalCost = 0;
      let totalCostKnown = true;

      const profitLines = lines.map((line) => {
        const qty = Number(line.qty || 0);
        const selling = toMoney(line.totalPrice).toNumber();
        const product = line.articleCode ? productMap[line.articleCode] : null;
        const hasCost = product !== null && product.productionPrice !== null;
        const costPerBale = hasCost ? toMoney(product!.productionPrice!).toNumber() : 0;
        const cost = hasCost ? costPerBale * qty : 0;
        const profit = hasCost ? selling - cost : null;
        const profitPctOnCost = hasCost && cost !== 0 ? ((selling - cost) / cost) * 100 : null;
        const marginPct = hasCost && selling !== 0 ? ((selling - cost) / selling) * 100 : null;

        totalSelling += selling;
        if (hasCost) {
          totalCost += cost;
        } else {
          totalCostKnown = false;
        }

        return {
          articleCode: line.articleCode,
          baleName: line.baleName,
          qty,
          selling,
          costPerBale: hideCostData ? null : costPerBale,
          cost: hideCostData ? null : cost,
          profit: hideCostData ? null : profit,
          profitPctOnCost: hideCostData ? null : profitPctOnCost,
          marginPct: hideCostData ? null : marginPct,
          missingCost: !hasCost,
          pricePerBale: toMoney(line.pricePerBale).toNumber(),
        };
      });

      const totalProfit = totalCostKnown ? totalSelling - totalCost : null;
      const totalProfitPctOnCost =
        totalCostKnown && totalCost !== 0 ? ((totalSelling - totalCost) / totalCost) * 100 : null;
      const totalMarginPct =
        totalCostKnown && totalSelling !== 0 ? ((totalSelling - totalCost) / totalSelling) * 100 : null;

      res.json({
        orderId: id,
        invoiceNumber: order.invoiceNumber,
        customerName: order.customerName,
        lines: profitLines,
        totalSelling,
        totalCost: hideCostData || !totalCostKnown ? null : totalCost,
        totalProfit: hideCostData ? null : totalProfit,
        totalProfitPctOnCost: hideCostData ? null : totalProfitPctOnCost,
        totalMarginPct: hideCostData ? null : totalMarginPct,
        partialCostData: !totalCostKnown,
        costHidden: hideCostData,
        costBasis: "catalogue-production-price-per-bale", // Wave 11: a selling value, not the bales' recorded cost.
      });
    } catch (error: unknown) {
      logger.error("Error fetching order profitability:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

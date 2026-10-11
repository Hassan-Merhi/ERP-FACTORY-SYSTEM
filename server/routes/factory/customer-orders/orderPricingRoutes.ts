import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { parseId } from "../../../lib/parseId";
import type { Express, Request, Response } from "express";
import type Decimal from "decimal.js";
import { db, type DbTransaction } from "../../../db";
import { requireAuth } from "../../../auth";
import { recalculateOrderTotals } from "../_helpers";
import {
  factoryBaleProducts,
  factoryBales,
  customerProformas,
  customerProformaLines,
  customerOrders,
  customerOrderLines,
  customerOrderBales,
  customerOrderCharges,
} from "@shared/schema";
import { eq, and, sql, inArray } from "drizzle-orm";
import { moneyString, parseMoneyInput, toMoney } from "../../../lib/money";
import { FactoryInvoiceRateRefusalError } from "../../../services/accounting/perpetualInventory/factoryInvoice";
import { PostingValidationError } from "../../../services/accounting/centralPostingEngine";
import { closedPeriodErrorResponse } from "../../../lib/closedPeriodError";
import { lockCustomerOrderTx, syncOrderTotalsTx } from "./orderChargeLedger";

/**
 * Phase 22 (C), F13/PE10 and DI7: every re-pricing runs in one transaction —
 * the order row is locked FOR UPDATE before it is read, the bale prices, the
 * order totals, the invoice's customer balance (locked) and the invoice
 * journal commit together. The invoice journal used to be synced in a second
 * transaction after the commit, so a refused sync (e.g. no factory rate) left
 * the order re-priced with the old journal; the balance row was read and
 * rewritten with no lock.
 */
class PricingHttpError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

type OrderRow = typeof customerOrders.$inferSelect;
type OrderBaleRow = typeof customerOrderBales.$inferSelect;
type PriceUpdate = { baleRowId: number; price: Decimal };

function pricingErrorResponse(res: Response, error: unknown, label: string) {
  if (error instanceof PricingHttpError) return res.status(error.status).json({ message: error.message });
  if (error instanceof FactoryInvoiceRateRefusalError) return res.status(409).json(error.body);
  const closed = closedPeriodErrorResponse(error);
  if (closed) return res.status(closed.status).json(closed.body);
  if (error instanceof PostingValidationError)
    return res.status(400).json({ message: error.message, code: error.code });
  logger.error(label, { error: error });
  return res.status(500).json({ message: getErrorMessage(error) });
}

/** A new price for a bale when it is positive and differs from the current one. */
function changedPrice(raw: string | null | undefined, current: string | null | undefined): Decimal | null {
  if (raw == null) return null;
  const next = toMoney(raw);
  if (next.lessThanOrEqualTo(0)) return null;
  if (next.minus(toMoney(current)).abs().lessThan(0.001)) return null;
  return next;
}

/**
 * Lock the order, compute the bale price changes from its current bales, write
 * them, recalculate and sync the invoice side — one transaction. Returns the
 * number of bales re-priced.
 */
async function repriceOrderTx(
  tx: DbTransaction,
  companyId: number,
  orderId: number,
  check: (order: OrderRow) => string | null,
  plan: (order: OrderRow, bales: OrderBaleRow[]) => Promise<PriceUpdate[]>,
  emptyMessage = "Order has no bales to reprice"
): Promise<number> {
  const order = await lockCustomerOrderTx(tx, companyId, orderId);
  if (!order) throw new PricingHttpError(404, "Order not found");
  const refusal = check(order);
  if (refusal) throw new PricingHttpError(400, refusal);
  const orderBales = await tx.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
  if (orderBales.length === 0) throw new PricingHttpError(400, emptyMessage);
  const updates = await plan(order, orderBales);
  for (const update of updates) {
    await tx
      .update(customerOrderBales)
      .set({ priceUsed: moneyString(update.price) })
      .where(eq(customerOrderBales.id, update.baleRowId));
  }
  await recalculateOrderTotals(tx, orderId);
  await syncOrderTotalsTx(tx, companyId, orderId, { daybook: false });
  return updates.length;
}

async function orderWithDetails(orderId: number, repriced: number) {
  const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
  const updatedBales = await db.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
  const updatedLines = await db.select().from(customerOrderLines).where(eq(customerOrderLines.orderId, orderId));
  const updatedCharges = await db.select().from(customerOrderCharges).where(eq(customerOrderCharges.orderId, orderId));
  return { ...updatedOrder, bales: updatedBales, lines: updatedLines, charges: updatedCharges, repriced };
}

function orderIdOf(req: Request, res: Response): { companyId: number; orderId: number } | null {
  const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
  if (!companyId) {
    res.status(400).json({ message: "No company selected" });
    return null;
  }
  const orderId = parseId(req.params.id);
  if (orderId === null) {
    res.status(400).json({ message: "Invalid id" });
    return null;
  }
  return { companyId, orderId };
}

const notCancelled = (order: OrderRow) => (order.status === "CANCELLED" ? "Cannot reprice a cancelled order" : null);

export function registerOrderPricingRoutes(app: Express) {
  app.post("/api/factory/customer-orders/:id/reprice", requireAuth, async (req: Request, res: Response) => {
    try {
      const ids = orderIdOf(req, res);
      if (!ids) return;
      const { companyId, orderId } = ids;

      // "Apply Current Prices" = use the CURRENT catalogue selling price as primary source.
      // Proforma price is only a fallback if no catalogue price is found for that article.
      const repriced = await db.transaction((tx) =>
        repriceOrderTx(
          tx,
          companyId,
          orderId,
          (order) =>
            ["DRAFT", "LOADING", "PENDING_VERIFICATION", "VERIFIED", "FINALIZED"].includes(order.status)
              ? null
              : "Cannot reprice a cancelled order",
          async (order, orderBales) => {
            // 1. Collect all unique article codes and bale IDs from this order
            const articleCodes = [...new Set(orderBales.map((b) => b.articleCode).filter(Boolean) as string[])];
            const baleIds = [...new Set(orderBales.map((b) => b.baleId).filter(Boolean))];

            // 2a. Bulk-fetch current selling prices by article code (primary path)
            const cataloguePriceMap = new Map<string, string>(); // lowerArticleCode → sellingPrice
            if (articleCodes.length > 0) {
              const catalogueRows = await tx
                .select({
                  articleCode: factoryBaleProducts.articleCode,
                  sellingPrice: factoryBaleProducts.sellingPrice,
                })
                .from(factoryBaleProducts)
                .where(
                  and(
                    eq(factoryBaleProducts.companyId, companyId),
                    inArray(factoryBaleProducts.articleCode, articleCodes)
                  )
                );
              for (const r of catalogueRows) {
                if (r.articleCode && r.sellingPrice != null) {
                  cataloguePriceMap.set(r.articleCode.toLowerCase().trim(), r.sellingPrice);
                }
              }
            }

            // 2b. Fallback: also pull prices via factoryBales.productId chain
            //     This covers cases where the article code in the bale doesn't match the catalogue entry.
            const baleIdPriceMap = new Map<number, string>(); // baleId → sellingPrice
            if (baleIds.length > 0) {
              const chainRows = await tx
                .select({ baleId: factoryBales.id, sellingPrice: factoryBaleProducts.sellingPrice })
                .from(factoryBales)
                .innerJoin(factoryBaleProducts, eq(factoryBaleProducts.id, factoryBales.productId))
                .where(inArray(factoryBales.id, baleIds));
              for (const r of chainRows) {
                if (r.baleId && r.sellingPrice != null) baleIdPriceMap.set(r.baleId, r.sellingPrice);
              }
            }

            // 3. Proforma prices as fallback for articles not in catalogue
            const proformaMap = new Map<string, string>();
            if (order.proformaIdUsed) {
              const proformaLines = await tx
                .select()
                .from(customerProformaLines)
                .where(eq(customerProformaLines.proformaId, order.proformaIdUsed));
              for (const pl of proformaLines) {
                if (pl.articleCode) proformaMap.set(pl.articleCode.toLowerCase(), pl.pricePerBale);
              }
            }

            const updates: PriceUpdate[] = [];
            for (const bale of orderBales) {
              const codeKey = bale.articleCode?.toLowerCase().trim();
              // Priority 1: catalogue price by article code
              // Priority 2: catalogue price via bale→product chain (baleId lookup)
              // Priority 3: proforma price
              const rawPrice =
                codeKey && cataloguePriceMap.has(codeKey)
                  ? cataloguePriceMap.get(codeKey)!
                  : bale.baleId && baleIdPriceMap.has(bale.baleId)
                    ? baleIdPriceMap.get(bale.baleId)!
                    : codeKey && proformaMap.has(codeKey)
                      ? proformaMap.get(codeKey)!
                      : null;
              // Skip if the price is 0 (not yet set) or already identical
              const price = changedPrice(rawPrice, bale.priceUsed);
              if (price) updates.push({ baleRowId: bale.id, price });
            }
            return updates;
          }
        )
      );

      res.json(await orderWithDetails(orderId, repriced));
    } catch (error: unknown) {
      pricingErrorResponse(res, error, "Error repricing order:");
    }
  });

  // Apply PRODUCTION prices to all bales in this order
  app.post("/api/factory/customer-orders/:id/reprice-production", requireAuth, async (req: Request, res: Response) => {
    try {
      const ids = orderIdOf(req, res);
      if (!ids) return;
      const { companyId, orderId } = ids;

      const repriced = await db.transaction((tx) =>
        repriceOrderTx(tx, companyId, orderId, notCancelled, async (_order, orderBales) => {
          // Collect unique article codes and bale IDs
          const articleCodes = [...new Set(orderBales.map((b) => b.articleCode).filter(Boolean) as string[])];
          const baleIds = [...new Set(orderBales.map((b) => b.baleId).filter(Boolean))];

          // Lookup production prices by article code
          const catalogueProdMap = new Map<string, string>();
          if (articleCodes.length > 0) {
            const catRows = await tx
              .select({
                articleCode: factoryBaleProducts.articleCode,
                productionPrice: factoryBaleProducts.productionPrice,
              })
              .from(factoryBaleProducts)
              .where(
                and(
                  eq(factoryBaleProducts.companyId, companyId),
                  inArray(factoryBaleProducts.articleCode, articleCodes)
                )
              );
            for (const r of catRows) {
              if (r.articleCode && r.productionPrice != null) {
                catalogueProdMap.set(r.articleCode.toLowerCase().trim(), r.productionPrice);
              }
            }
          }

          // Fallback: via baleId → product chain
          const baleIdProdMap = new Map<number, string>();
          if (baleIds.length > 0) {
            const chainRows = await tx
              .select({ baleId: factoryBales.id, productionPrice: factoryBaleProducts.productionPrice })
              .from(factoryBales)
              .innerJoin(factoryBaleProducts, eq(factoryBaleProducts.id, factoryBales.productId))
              .where(inArray(factoryBales.id, baleIds));
            for (const r of chainRows) {
              if (r.baleId && r.productionPrice != null) baleIdProdMap.set(r.baleId, r.productionPrice);
            }
          }

          const updates: PriceUpdate[] = [];
          for (const bale of orderBales) {
            const codeKey = bale.articleCode?.toLowerCase().trim();
            const rawPrice =
              codeKey && catalogueProdMap.has(codeKey)
                ? catalogueProdMap.get(codeKey)!
                : bale.baleId && baleIdProdMap.has(bale.baleId)
                  ? baleIdProdMap.get(bale.baleId)!
                  : null;
            const price = changedPrice(rawPrice, bale.priceUsed);
            if (price) updates.push({ baleRowId: bale.id, price });
          }
          return updates;
        })
      );

      res.json(await orderWithDetails(orderId, repriced));
    } catch (error: unknown) {
      pricingErrorResponse(res, error, "Error repricing order with production prices:");
    }
  });

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

  // ─────── CONTAINER DOCUMENT TYPES ───────
}

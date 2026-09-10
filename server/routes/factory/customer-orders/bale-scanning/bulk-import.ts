/**
 * baleScanningRoutes: OrderBaleBulkImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { parseId } from "../../../../lib/parseId";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { recalculateOrderTotals } from "../../_helpers";
import { normalizeLoadingArticleCode } from "./proformaScanPolicy";
import { getProformaCapacitySnapshot } from "../proformaCapacity";
import { evaluateProformaArticleCapacity } from "../proformaCapacityEnforcement";
import {
  factoryBaleProducts,
  factoryBales,
  customerProformaLines,
  customerOrders,
  customerOrderBales,
} from "@shared/schema";
import { eq, and, or, sql, inArray } from "drizzle-orm";
import { resultRows, firstRow } from "../../../../lib/queryResult";

export function registerOrderBaleBulkImportRoutes(app: Express) {
  app.post("/api/factory/customer-orders/:id/bales/bulk-import", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);

      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      const { locationId, items, refNumbers: refNumbersRaw } = req.body;
      const ignoreProforma = req.body.allowBypassProforma === true;
      const hasRefNumbers = Array.isArray(refNumbersRaw) && refNumbersRaw.length > 0;
      const hasItems = Array.isArray(items) && items.length > 0;
      if (!locationId || (!hasItems && !hasRefNumbers)) {
        return res.status(400).json({ message: "locationId and either items or refNumbers are required" });
      }
      const scannerName: string | null = req.session?.username || req.session?.name || req.session?.email || null;

      const [order] = await db
        .select()
        .from(customerOrders)
        .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
      if (!order) return res.status(404).json({ message: "Order not found" });
      if (!["DRAFT", "LOADING", "PENDING_VERIFICATION"].includes(order.status)) {
        return res
          .status(400)
          .json({ message: "Can only add bales to DRAFT, LOADING, or PENDING_VERIFICATION orders" });
      }

      // V5 guard: proformaIdUsed IS NOT NULL
      // V5 bales are SOLD once the order reaches PENDING_VERIFICATION — no further bulk scanning allowed.
      // Legacy V2/V3 behavior (PENDING_VERIFICATION scan allowed) is unchanged.
      if (order.proformaIdUsed && order.status === "PENDING_VERIFICATION") {
        return res
          .status(400)
          .json({ message: "Cannot add bales to a V5 order that is already in PENDING_VERIFICATION" });
      }

      const parsedLocationId = parseInt(locationId);

      // Get all products for this company for matching
      const allProducts = await db
        .select()
        .from(factoryBaleProducts)
        .where(eq(factoryBaleProducts.companyId, companyId));

      // Get bales already in this order
      const existingOrderBales = await db
        .select({ baleId: customerOrderBales.baleId })
        .from(customerOrderBales)
        .where(eq(customerOrderBales.orderId, orderId));
      const alreadyAddedBaleIds = new Set(existingOrderBales.map((b) => b.baleId));

      let totalAdded = 0;
      const notFound: Array<{ articleCode: string; requestedQty: number; foundQty: number }> = [];
      const notFoundRefs: string[] = [];

      // ── REF-NUMBER / REF-CODE MODE ──────────────────────────────────────────
      if (hasRefNumbers) {
        const refNumbers = refNumbersRaw as string[];
        for (const rawRef of refNumbers) {
          const refNum = String(rawRef).trim();
          if (!refNum) continue;

          // Per-refNum tx: lock the bale with SELECT FOR UPDATE, then insert
          // the join row + flip status atomically. Two concurrent bulk-imports
          // referencing the same physical bale will block at the lock; only
          // one will see status='IN_STOCK', the other will skip.
          const refResult = await db.transaction(async (tx) => {
            // Try referenceNumber first, then fall back to baleCode
            let [bale] = await tx
              .select()
              .from(factoryBales)
              .where(
                and(
                  eq(factoryBales.companyId, companyId),
                  eq(factoryBales.referenceNumber, refNum),
                  eq(factoryBales.status, "IN_STOCK")
                )
              )
              .for("update");

            if (!bale) {
              [bale] = await tx
                .select()
                .from(factoryBales)
                .where(
                  and(
                    eq(factoryBales.companyId, companyId),
                    eq(factoryBales.baleCode, refNum),
                    eq(factoryBales.status, "IN_STOCK")
                  )
                )
                .for("update");
            }

            if (!bale) return { kind: "notFound" as const };
            if (alreadyAddedBaleIds.has(bale.id)) return { kind: "skipDuplicate" as const };

            const baleProductForCapacity = bale.productId ? allProducts.find((p) => p.id === bale.productId) : null;
            const effectiveArticleCode = String(bale.articleCode || baleProductForCapacity?.articleCode || "").trim();
            if (order.proformaIdUsed && !ignoreProforma) {
              const capacity = await getProformaCapacitySnapshot(tx, {
                companyId,
                proformaId: order.proformaIdUsed,
                currentOrderId: orderId,
              });
              if (!capacity || !evaluateProformaArticleCapacity(capacity, effectiveArticleCode, 1).allowed) {
                return { kind: "notFound" as const };
              }
            }

            // Universal cross-order duplicate check: block if this bale is already in any other
            // active (non-CANCELLED) order regardless of V5/non-V5 type.
            const bulkCrossOrderCheck = await tx.execute(
              sql`SELECT cob.order_id FROM customer_order_bales cob
                  JOIN customer_orders co ON co.id = cob.order_id
                  WHERE cob.bale_id = ${bale.id}
                    AND co.status != 'CANCELLED'
                    AND cob.order_id != ${orderId}
                  LIMIT 1`
            );
            const bulkCrossOrderRow = firstRow(bulkCrossOrderCheck);
            if (bulkCrossOrderRow) return { kind: "notFound" as const };

            let priceUsed = "0";
            if (order.proformaIdUsed) {
              const [pl] = await tx
                .select()
                .from(customerProformaLines)
                .where(
                  and(
                    eq(customerProformaLines.proformaId, order.proformaIdUsed),
                    sql`LOWER(TRIM(${customerProformaLines.articleCode})) = ${normalizeLoadingArticleCode(effectiveArticleCode)}`
                  )
                );
              if (pl) {
                const pMode = pl.pricingMode ?? "per_bale";
                const pkgRate = parseFloat(String(pl.pricePerKg ?? "0"));
                if (pMode === "per_kg" && pkgRate > 0) {
                  const baleWt = parseFloat(String(bale.weightKg || "0"));
                  priceUsed = (!isNaN(baleWt) ? baleWt * pkgRate : 0).toFixed(2);
                } else {
                  priceUsed = pl.pricePerBale;
                }
              }
            }
            if (priceUsed === "0" && bale.productId) {
              const product = allProducts.find((p) => p.id === bale.productId);
              if (product?.sellingPrice) priceUsed = product.sellingPrice;
            }

            const baleProductForName1 = bale.productId ? allProducts.find((p) => p.id === bale.productId) : null;

            await tx.insert(customerOrderBales).values({
              orderId,
              baleId: bale.id,
              baleReference: bale.referenceNumber,
              locationId: bale.erpLocationId ?? parsedLocationId,
              weight: bale.weightKg,
              articleCode: effectiveArticleCode || bale.articleCode,
              baleName: baleProductForName1?.name || bale.productName || effectiveArticleCode || bale.baleCode,
              priceUsed,
              scannedBy: scannerName,
            });

            // V5 guard: proformaIdUsed IS NOT NULL
            // V5 bales remain IN_STOCK during loading — only legacy V2/V3 orders set RESERVED_FOR_ORDER.
            if (!order.proformaIdUsed) {
              await tx
                .update(factoryBales)
                .set({ status: "RESERVED_FOR_ORDER", updatedAt: new Date() })
                .where(eq(factoryBales.id, bale.id));
            }

            return { kind: "added" as const, baleId: bale.id };
          });

          if (refResult.kind === "notFound") {
            notFoundRefs.push(refNum);
            continue;
          }
          if (refResult.kind === "skipDuplicate") continue;
          alreadyAddedBaleIds.add(refResult.baleId);
          totalAdded++;
        }

        await recalculateOrderTotals(db, orderId);
        const updatedBales = await db.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
        const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
        return res.json({ added: totalAdded, notFound: [], notFoundRefs, order: updatedOrder, bales: updatedBales });
      }

      // ── V5 cross-order block set (ARTICLE mode) ─────────────────────────────
      // V5 guard: proformaIdUsed IS NOT NULL
      // V5 bales remain IN_STOCK while loaded in other orders. Build a set of bale IDs already
      // claimed by other active (non-CANCELLED) V5 orders so they can be excluded during
      // auto-selection. One query covers all articles. Legacy orders skip this block entirely.
      const v5BlockedBaleIds = new Set<number>();
      if (order.proformaIdUsed) {
        const blockedRows = await db.execute(
          sql`SELECT cob.bale_id FROM customer_order_bales cob
              JOIN customer_orders co ON co.id = cob.order_id
              WHERE co.status != 'CANCELLED'
                AND cob.order_id != ${orderId}`
        );
        for (const row of resultRows<{ bale_id: number }>(blockedRows)) {
          v5BlockedBaleIds.add(row.bale_id);
        }
      }

      // ── ARTICLE-CODE MODE (existing) ────────────────────────────────────────
      for (const item of items) {
        const articleCode = String(item.articleCode || "").trim();
        const qty = parseInt(item.qty) || 0;
        if (!articleCode || qty <= 0) continue;

        const codeLower = articleCode.toLowerCase();

        // Find matching product IDs (by articleCode or name)
        const matchingProductIds = allProducts
          .filter(
            (p) =>
              (p.articleCode && p.articleCode.toLowerCase() === codeLower) ||
              (p.name && p.name.toLowerCase() === codeLower)
          )
          .map((p) => p.id);

        // Build bale query conditions
        const matchConditions =
          matchingProductIds.length > 0
            ? or(
                sql`LOWER(${factoryBales.articleCode}) = ${codeLower}`,
                inArray(factoryBales.productId, matchingProductIds)
              )
            : sql`LOWER(${factoryBales.articleCode}) = ${codeLower}`;

        // Per-article tx: lock candidate bales with SELECT FOR UPDATE, filter
        // the locked set in-memory to drop already-claimed/cross-order ones,
        // then insert + status-update inside the same tx. Concurrent imports
        // for the same article will block at the lock and re-evaluate, so
        // they cannot grab the same physical bales.
        const articleResult = await db.transaction(async (tx) => {
          // Find available bales, oldest first
          const availableBales = await tx
            .select()
            .from(factoryBales)
            .where(
              and(
                eq(factoryBales.companyId, companyId),
                eq(factoryBales.status, "IN_STOCK"),
                eq(factoryBales.erpLocationId, parsedLocationId),
                matchConditions
              )
            )
            .orderBy(factoryBales.createdAt)
            .limit(qty * 5)
            .for("update");

          // Filter out bales already in this order, or (V5 only) bales we
          // already know are claimed by another active order from the snapshot
          // taken before this tx. Note: the snapshot can be stale, so for V5
          // we re-verify each candidate inside the tx below before inserting.
          const candidateBales = availableBales.filter(
            (b) => !alreadyAddedBaleIds.has(b.id) && !v5BlockedBaleIds.has(b.id)
          );

          const capacity =
            order.proformaIdUsed && !ignoreProforma
              ? await getProformaCapacitySnapshot(tx, {
                  companyId,
                  proformaId: order.proformaIdUsed,
                  currentOrderId: orderId,
                })
              : null;
          if (order.proformaIdUsed && !ignoreProforma && !capacity) return [];
          const pendingByArticle = new Map<string, number>();

          const addedIds: number[] = [];
          for (const bale of candidateBales) {
            if (addedIds.length >= qty) break;

            // V5 guard: proformaIdUsed IS NOT NULL
            // The outer v5BlockedBaleIds snapshot can race with concurrent V5
            // imports — re-verify inside the tx that no other active order
            // has linked this bale since we took the snapshot. Without this
            // recheck, two concurrent ARTICLE imports could both claim the
            // same V5 bale (V5 keeps bale IN_STOCK so the FOR UPDATE lock
            // alone does not block the second tx from picking it up).
            if (order.proformaIdUsed) {
              const v5DupCheck = await tx.execute(
                sql`SELECT cob.order_id FROM customer_order_bales cob
                    JOIN customer_orders co ON co.id = cob.order_id
                    WHERE cob.bale_id = ${bale.id}
                      AND co.status != 'CANCELLED'
                      AND cob.order_id != ${orderId}
                    LIMIT 1`
              );
              if (firstRow(v5DupCheck)) continue;
            }

            const baleProductForCapacity = bale.productId ? allProducts.find((p) => p.id === bale.productId) : null;
            const effectiveArticleCode = String(bale.articleCode || baleProductForCapacity?.articleCode || "").trim();
            if (capacity) {
              const normalized = normalizeLoadingArticleCode(effectiveArticleCode);
              const proposedForThisArticle = (pendingByArticle.get(normalized) || 0) + 1;
              const decision = evaluateProformaArticleCapacity(capacity, effectiveArticleCode, proposedForThisArticle);
              if (!decision.allowed) continue;
              pendingByArticle.set(normalized, proposedForThisArticle);
            }

            // Determine price
            let priceUsed = "0";
            if (order.proformaIdUsed) {
              const [pl] = await tx
                .select()
                .from(customerProformaLines)
                .where(
                  and(
                    eq(customerProformaLines.proformaId, order.proformaIdUsed),
                    sql`LOWER(TRIM(${customerProformaLines.articleCode})) = ${normalizeLoadingArticleCode(effectiveArticleCode)}`
                  )
                );
              if (pl) {
                const pMode = pl.pricingMode ?? "per_bale";
                const pkgRate = parseFloat(String(pl.pricePerKg ?? "0"));
                if (pMode === "per_kg" && pkgRate > 0) {
                  const baleWt = parseFloat(String(bale.weightKg || "0"));
                  priceUsed = (!isNaN(baleWt) ? baleWt * pkgRate : 0).toFixed(2);
                } else {
                  priceUsed = pl.pricePerBale;
                }
              }
            }
            if (priceUsed === "0" && bale.productId) {
              const product = allProducts.find((p) => p.id === bale.productId);
              if (product?.sellingPrice) priceUsed = product.sellingPrice;
            }

            const baleProductForName2 = bale.productId ? allProducts.find((p) => p.id === bale.productId) : null;

            await tx.insert(customerOrderBales).values({
              orderId,
              baleId: bale.id,
              baleReference: bale.referenceNumber,
              locationId: parsedLocationId,
              weight: bale.weightKg,
              articleCode: effectiveArticleCode || bale.articleCode,
              baleName: baleProductForName2?.name || bale.productName || effectiveArticleCode || bale.baleCode,
              priceUsed,
              scannedBy: scannerName,
            });

            // V5 guard: proformaIdUsed IS NOT NULL
            // V5 bales remain IN_STOCK during loading — only legacy V2/V3 orders set RESERVED_FOR_ORDER.
            if (!order.proformaIdUsed) {
              await tx
                .update(factoryBales)
                .set({ status: "RESERVED_FOR_ORDER", updatedAt: new Date() })
                .where(eq(factoryBales.id, bale.id));
            }

            addedIds.push(bale.id);
          }

          return addedIds;
        });

        if (articleResult.length < qty) {
          notFound.push({ articleCode, requestedQty: qty, foundQty: articleResult.length });
        }
        for (const id of articleResult) {
          alreadyAddedBaleIds.add(id);
          totalAdded++;
        }
      }

      await recalculateOrderTotals(db, orderId);

      const updatedBales = await db.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
      const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));

      res.json({ added: totalAdded, notFound, order: updatedOrder, bales: updatedBales });
    } catch (error: unknown) {
      logger.error("Error bulk importing bales:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

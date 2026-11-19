/**
 * baleScanningRoutes: OrderBaleBulkImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { recalculateOrderTotals } from "../../_helpers";
import { normalizeLoadingArticleCode } from "./proformaScanPolicy";
import { getProformaCapacitySnapshot } from "../proformaCapacity";
import { advanceSatisfiedPriorityScanConfigs } from "../priorityScanQueue";
import { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";
import { evaluateProformaArticleCapacity } from "../proformaCapacityEnforcement";
import { factoryBales, customerProformaLines, customerOrders, customerOrderBales } from "@shared/schema";
import { eq, and, or, sql, inArray } from "drizzle-orm";
import { resultRows, firstRow } from "../../../../lib/queryResult";
import { toMoney } from "../../../../lib/money";
import { bulkImportStep } from "./bulkImportStep";

export function registerOrderBaleBulkImportRoutes(app: Express) {
  app.post("/api/factory/customer-orders/:id/bales/bulk-import", requireAuth, async (req: Request, res: Response) => {
    try {
      const bbi1 = await bulkImportStep({ req, res });
      if (bbi1.done) return bbi1.value;
      const {
        hasRefNumbers,
        refNumbersRaw,
        order,
        companyId,
        orderId,
        alreadyAddedBaleIds,
        allProducts,
        ignoreProforma,
        parsedLocationId,
        scannerName,
        notFoundRefs,
        items,
        notFound,
      } = bbi1;

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
            // Proforma lock first, then the order row, then the bale row —
            // the ordering every capacity-changing writer follows, so an import
            // racing a scan or a finalization waits rather than measuring
            // capacity mid-write.
            if (order.proformaIdUsed) {
              await acquireProformaCapacityTransactionLock(tx, {
                companyId,
                proformaId: order.proformaIdUsed,
              });
            }

            const [currentOrder] = await tx
              .select({ status: customerOrders.status, deletedAt: customerOrders.deletedAt })
              .from(customerOrders)
              .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)))
              .for("update");
            if (
              !currentOrder ||
              currentOrder.deletedAt ||
              !["DRAFT", "LOADING", "PENDING_VERIFICATION"].includes(currentOrder.status)
            ) {
              return { kind: "notFound" as const };
            }

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
              if (
                !capacity ||
                !evaluateProformaArticleCapacity(capacity, effectiveArticleCode, 1, "per_loading").allowed
              ) {
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
                    AND co.company_id = ${companyId}
                    AND co.deleted_at IS NULL
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
                const pkgRate = toMoney(pl.pricePerKg);
                if (pMode === "per_kg" && pkgRate.gt(0)) {
                  // Exact: 3 kg at 1.115/kg is 3.345, which the float product rounded to 3.34.
                  priceUsed = toMoney(bale.weightKg).times(pkgRate).toFixed(2);
                } else {
                  priceUsed = pl.pricePerBale;
                }
              }
            }
            let hasContainerPrice = false;
            if (order.proformaIdUsed && effectiveArticleCode) {
              const extra = resultRows<{ price: string }>(
                await tx.execute(sql`
                SELECT price_per_bale::text AS price
                FROM customer_order_extra_expected_lines
                WHERE company_id = ${companyId} AND order_id = ${orderId}
                  AND UPPER(TRIM(article_code)) = UPPER(TRIM(${effectiveArticleCode}))
                LIMIT 1
              `)
              )[0];
              // Container-local agreed price wins over the reusable proforma.
              if (extra) {
                priceUsed = extra.price;
                hasContainerPrice = true;
              }
            }
            if (priceUsed === "0" && !hasContainerPrice && bale.productId) {
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
          bbi1.totalAdded++;
        }

        await recalculateOrderTotals(db, orderId);
        const updatedBales = await db.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
        const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));
        return res.json({
          added: bbi1.totalAdded,
          notFound: [],
          notFoundRefs,
          order: updatedOrder,
          bales: updatedBales,
        });
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
                AND co.company_id = ${companyId}
                AND co.deleted_at IS NULL
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
          // Proforma lock first, then the order row, then the bale row —
          // the ordering every capacity-changing writer follows, so an import
          // racing a scan or a finalization waits rather than measuring
          // capacity mid-write.
          if (order.proformaIdUsed) {
            await acquireProformaCapacityTransactionLock(tx, {
              companyId,
              proformaId: order.proformaIdUsed,
            });
          }

          const [currentOrder] = await tx
            .select({ status: customerOrders.status })
            .from(customerOrders)
            .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)))
            .for("update");
          if (!currentOrder || !["DRAFT", "LOADING", "PENDING_VERIFICATION"].includes(currentOrder.status)) {
            return [] as number[];
          }

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
                      AND co.company_id = ${companyId}
                      AND co.deleted_at IS NULL
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
              const decision = evaluateProformaArticleCapacity(
                capacity,
                effectiveArticleCode,
                proposedForThisArticle,
                "per_loading"
              );
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
                const pkgRate = toMoney(pl.pricePerKg);
                if (pMode === "per_kg" && pkgRate.gt(0)) {
                  // Exact: 3 kg at 1.115/kg is 3.345, which the float product rounded to 3.34.
                  priceUsed = toMoney(bale.weightKg).times(pkgRate).toFixed(2);
                } else {
                  priceUsed = pl.pricePerBale;
                }
              }
            }
            let hasContainerPrice = false;
            if (order.proformaIdUsed && effectiveArticleCode) {
              const extra = resultRows<{ price: string }>(
                await tx.execute(sql`
                SELECT price_per_bale::text AS price
                FROM customer_order_extra_expected_lines
                WHERE company_id = ${companyId} AND order_id = ${orderId}
                  AND UPPER(TRIM(article_code)) = UPPER(TRIM(${effectiveArticleCode}))
                LIMIT 1
              `)
              )[0];
              // Container-local agreed price wins over the reusable proforma.
              if (extra) {
                priceUsed = extra.price;
                hasContainerPrice = true;
              }
            }
            if (priceUsed === "0" && !hasContainerPrice && bale.productId) {
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
          bbi1.totalAdded++;
        }
      }

      await recalculateOrderTotals(db, orderId);

      try {
        await advanceSatisfiedPriorityScanConfigs(companyId, orderId);
      } catch (advanceError) {
        logger.error("Priority Scan auto-advance failed after bulk bale allocation", {
          orderId,
          error: getErrorMessage(advanceError),
        });
      }

      const updatedBales = await db.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
      const [updatedOrder] = await db.select().from(customerOrders).where(eq(customerOrders.id, orderId));

      res.json({ added: bbi1.totalAdded, notFound, order: updatedOrder, bales: updatedBales });
    } catch (error: unknown) {
      logger.error("Error bulk importing bales:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

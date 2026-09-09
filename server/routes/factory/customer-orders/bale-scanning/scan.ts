/**
 * baleScanningRoutes: OrderBaleScan endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { EXPECTED_CLIENT_RESPONSE_CODES, markExpectedClientResponse } from "../../../../lib/expectedClientResponse";
import { parseId } from "../../../../lib/parseId";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { recalculateOrderTotalsForScannedArticle, type ScannedArticleTotalsPatch } from "./incrementalTotals";
import {
  normalizeLoadingArticleCode,
  shouldEnforceProformaOverload,
  shouldRequireProformaMembership,
  sumProformaQuantityLimit,
} from "./proformaScanPolicy";
import {
  factoryBales,
  customerProformaLines,
  customerOrders,
  customerOrderBales,
  customerOrderBaleRemovals,
} from "@shared/schema";
import { eq, and, or, sql, isNull } from "drizzle-orm";
import { firstRow } from "../../../../lib/queryResult";

export function registerOrderBaleScanRoutes(app: Express) {
  app.post("/api/factory/customer-orders/:id/bales", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);
      if (orderId === null) return res.status(400).json({ message: "Invalid id" });

      const { scanCode, locationId } = req.body;
      if (!scanCode || !locationId) return res.status(400).json({ message: "scanCode and locationId are required" });

      const parsedLocationId = Number.parseInt(String(locationId), 10);
      if (!Number.isInteger(parsedLocationId) || parsedLocationId <= 0) {
        return res.status(400).json({ message: "scanCode and locationId are required" });
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
      // V5 bales are SOLD once the order reaches PENDING_VERIFICATION — no further scanning allowed.
      // Legacy V2/V3 behavior (PENDING_VERIFICATION scan allowed) is unchanged.
      if (order.proformaIdUsed && order.status === "PENDING_VERIFICATION") {
        return res
          .status(400)
          .json({ message: "Cannot add bales to a V5 order that is already in PENDING_VERIFICATION" });
      }

      const scanTrimmed = String(scanCode).trim();
      const scanLower = scanTrimmed.toLowerCase();
      const scanLike = `%${scanTrimmed}%`;

      // Successful scans used to pay for two preflight reads before entering the
      // transaction: one RESERVED_FOR_ORDER lookup and one product-name lookup.
      // Fold both into the locked candidate query instead. Exact reserved unique
      // identifiers still win so the user keeps the same descriptive error.
      const uniqueIdentifierCondition = or(
        sql`LOWER(${factoryBales.referenceNumber}) = ${scanLower}`,
        sql`LOWER(${factoryBales.baleCode}) = ${scanLower}`
      );
      const availableNameCondition = or(
        uniqueIdentifierCondition,
        sql`LOWER(${factoryBales.articleCode}) = ${scanLower}`,
        sql`LOWER(${factoryBales.productName}) = ${scanLower}`,
        sql`EXISTS (
          SELECT 1
          FROM factory_bale_products fbp
          WHERE fbp.id = ${factoryBales.productId}
            AND fbp.company_id = ${companyId}
            AND (
              LOWER(fbp.name) = ${scanLower}
              OR fbp.name ILIKE ${scanLike}
              OR LOWER(fbp.article_code) = ${scanLower}
              OR fbp.article_code ILIKE ${scanLike}
            )
        )`
      );

      type PickResult =
        | {
            ok: true;
            bale: typeof customerOrderBales.$inferSelect;
            line: ScannedArticleTotalsPatch["line"];
            totals: ScannedArticleTotalsPatch["totals"];
          }
        | { ok: false; httpStatus: number; body: any };

      const result: PickResult = await db.transaction(async (tx) => {
        const [bale] = await tx
          .select({
            id: factoryBales.id,
            status: factoryBales.status,
            referenceNumber: factoryBales.referenceNumber,
            baleCode: factoryBales.baleCode,
            articleCode: factoryBales.articleCode,
            productName: factoryBales.productName,
            productId: factoryBales.productId,
            weightKg: factoryBales.weightKg,
            productArticleCode: sql<string | null>`(
              SELECT fbp.article_code
              FROM factory_bale_products fbp
              WHERE fbp.id = ${factoryBales.productId}
                AND fbp.company_id = ${companyId}
              LIMIT 1
            )`,
            canonicalProductName: sql<string | null>`(
              SELECT fbp.name
              FROM factory_bale_products fbp
              WHERE fbp.id = ${factoryBales.productId}
                AND fbp.company_id = ${companyId}
              LIMIT 1
            )`,
            productSellingPrice: sql<string | null>`(
              SELECT fbp.selling_price
              FROM factory_bale_products fbp
              WHERE fbp.id = ${factoryBales.productId}
                AND fbp.company_id = ${companyId}
              LIMIT 1
            )`,
            reservedInThisOrder: sql<boolean>`EXISTS (
              SELECT 1
              FROM customer_order_bales cob
              WHERE cob.order_id = ${orderId}
                AND cob.bale_id = ${factoryBales.id}
            )`,
            removedFromThisOrder: sql<boolean>`EXISTS (
              SELECT 1
              FROM ${customerOrderBaleRemovals} cobr
              WHERE cobr.order_id = ${orderId}
                AND cobr.bale_id = ${factoryBales.id}
            )`,
          })
          .from(factoryBales)
          .where(
            and(
              eq(factoryBales.companyId, companyId),
              or(
                and(eq(factoryBales.status, "RESERVED_FOR_ORDER"), uniqueIdentifierCondition),
                and(
                  eq(factoryBales.status, "IN_STOCK"),
                  eq(factoryBales.erpLocationId, parsedLocationId),
                  availableNameCondition
                )
              )
            )
          )
          .orderBy(sql`CASE WHEN ${factoryBales.status} = 'RESERVED_FOR_ORDER' THEN 0 ELSE 1 END`, factoryBales.id)
          .limit(1)
          .for("update");

        if (!bale) {
          return {
            ok: false,
            httpStatus: 404,
            body: { message: "Bale not found, not at this location, or not available for sale" },
          };
        }

        if (bale.status === "RESERVED_FOR_ORDER") {
          const reservedBale = bale;
          if (reservedBale.reservedInThisOrder) {
            return {
              ok: false,
              httpStatus: 400,
              body: { message: `${reservedBale.referenceNumber || scanCode} is already loaded in this order` },
            };
          }
          return {
            ok: false,
            httpStatus: 400,
            body: { message: `Bale ${reservedBale.referenceNumber || scanCode} is reserved for another loading order` },
          };
        }

        // One active-order lookup covers both "already in this order" and
        // "already in another order". V5 bales stay IN_STOCK while loading, so
        // status alone cannot enforce this duplicate rule.
        const activeOrderCheck = await tx.execute(
          sql`SELECT cob.order_id, co.status, co.invoice_number
              FROM customer_order_bales cob
              JOIN customer_orders co ON co.id = cob.order_id
              WHERE cob.bale_id = ${bale.id}
                AND co.status != 'CANCELLED'
              ORDER BY CASE WHEN cob.order_id = ${orderId} THEN 0 ELSE 1 END, cob.order_id
              LIMIT 1`
        );
        const crossOrderDupRow = firstRow(activeOrderCheck);
        if (crossOrderDupRow) {
          if (Number(crossOrderDupRow.order_id) === orderId) {
            return { ok: false, httpStatus: 400, body: { message: "Bale already added to this order" } };
          }
          const orderRef = crossOrderDupRow.invoice_number
            ? `invoice ${crossOrderDupRow.invoice_number}`
            : `loading #${crossOrderDupRow.order_id}`;
          return {
            ok: false,
            httpStatus: 400,
            body: {
              message: `Bale ${bale.referenceNumber || scanCode} is already in ${orderRef} (${crossOrderDupRow.status}). Remove it from that order first.`,
            },
          };
        }

        const effectiveArticleCode: string = (bale.articleCode || bale.productArticleCode || "").trim();
        const normalizedEffectiveArticleCode = normalizeLoadingArticleCode(effectiveArticleCode);
        const ignoreProforma = req.body.allowBypassProforma === true;
        const enforceOverload = shouldEnforceProformaOverload({
          ignoreProforma,
          allowBypassOverload: req.body.allowBypassOverload === true,
          isReinstatingRemovedBale: bale.removedFromThisOrder,
        });

        let priceUsed = bale.productSellingPrice || "0";

        if (order.proformaIdUsed) {
          // Membership and pricing always come from the proforma line. The
          // potentially expensive active-bale COUNT is only needed while the
          // overload guard is actually enforced; confirmed/bypass/reinstatement scans use 0.
          const currentCountExpression = enforceOverload
            ? sql<number>`(
                SELECT COUNT(*)::int
                FROM customer_order_bales cob
                JOIN customer_orders ON customer_orders.id = cob.order_id
                WHERE customer_orders.company_id = ${companyId}
                  AND customer_orders.proforma_id_used = ${order.proformaIdUsed}
                  AND customer_orders.status != 'CANCELLED'
                  AND ${isNull(customerOrders.deletedAt)}
                  AND LOWER(TRIM(COALESCE(cob.article_code, ''))) = ${normalizedEffectiveArticleCode}
              )`
            : sql<number>`0`;

          const matchingProformaLines = await tx
            .select({
              quantity: customerProformaLines.quantity,
              pricingMode: customerProformaLines.pricingMode,
              pricePerKg: customerProformaLines.pricePerKg,
              pricePerBale: customerProformaLines.pricePerBale,
              currentCount: currentCountExpression,
            })
            .from(customerProformaLines)
            .where(
              and(
                eq(customerProformaLines.proformaId, order.proformaIdUsed),
                sql`LOWER(TRIM(${customerProformaLines.articleCode})) = ${normalizedEffectiveArticleCode}`
              )
            );
          const matchedProformaLine = matchingProformaLines[0] || null;
          const proformaQuantityLimit = sumProformaQuantityLimit(matchingProformaLines);
          const proformaLine = matchedProformaLine ? { ...matchedProformaLine, quantity: proformaQuantityLimit } : null;
          if (proformaLine) {
            const pricingMode = proformaLine.pricingMode ?? "per_bale";
            const perKgVal = proformaLine.pricePerKg;
            if (pricingMode === "per_kg" && perKgVal) {
              const weightKg = parseFloat(String(bale.weightKg || "0"));
              const pkgRate = parseFloat(String(perKgVal));
              priceUsed = !isNaN(weightKg) && !isNaN(pkgRate) ? (weightKg * pkgRate).toFixed(2) : "0";
            } else {
              priceUsed = proformaLine.pricePerBale || "0";
            }
            const currentCount = Number(proformaLine.currentCount || 0);
            if (enforceOverload && currentCount >= proformaQuantityLimit) {
              return {
                ok: false,
                httpStatus: 400,
                body: {
                  confirmationRequired: true,
                  confirmationType: "overload",
                  overloaded: true,
                  message: `Quantity exceeded (${currentCount}/${proformaLine.quantity}). Scan again to bypass.`,
                },
              };
            }
          } else if (
            shouldRequireProformaMembership({
              ignoreProforma,
              hasProformaLine: false,
            })
          ) {
            return {
              ok: false,
              httpStatus: 400,
              body: {
                confirmationRequired: true,
                confirmationType: "not_in_proforma",
                notInProforma: true,
                message: "Item loaded not requested. Please scan again to bypass.",
              },
            };
          }
        }

        const resolvedBaleName =
          bale.canonicalProductName || bale.productName || bale.articleCode || bale.baleCode || "Bale";

        const [insertedOrderBale] = await tx
          .insert(customerOrderBales)
          .values({
            orderId,
            baleId: bale.id,
            baleReference: bale.referenceNumber,
            locationId: parsedLocationId,
            weight: bale.weightKg,
            articleCode: effectiveArticleCode || bale.articleCode,
            baleName: resolvedBaleName,
            priceUsed,
            scannedBy: scannerName,
          })
          .returning();

        // V5 bales remain IN_STOCK during loading — only legacy V2/V3 orders set RESERVED_FOR_ORDER.
        if (!order.proformaIdUsed) {
          await tx
            .update(factoryBales)
            .set({ status: "RESERVED_FOR_ORDER", updatedAt: new Date() })
            .where(eq(factoryBales.id, bale.id));
        }

        const recalculated = await recalculateOrderTotalsForScannedArticle(
          tx,
          orderId,
          effectiveArticleCode || bale.articleCode
        );
        return {
          ok: true,
          bale: insertedOrderBale,
          line: recalculated.line,
          totals: recalculated.totals,
        };
      });

      if (!result.ok) {
        if (result.body?.confirmationType === "overload") {
          markExpectedClientResponse(res, EXPECTED_CLIENT_RESPONSE_CODES.BALE_SCAN_OVERLOAD);
        } else if (result.body?.confirmationType === "not_in_proforma") {
          markExpectedClientResponse(res, EXPECTED_CLIENT_RESPONSE_CODES.BALE_SCAN_NOT_IN_PROFORMA);
        }
        return res.status(result.httpStatus).json(result.body);
      }

      return res.json({
        compactBaleScan: true,
        orderId,
        order: {
          ...order,
          ...result.totals,
        },
        bale: result.bale,
        line: result.line,
        totals: result.totals,
      });
    } catch (error: unknown) {
      logger.error("Error adding bale to order:", { error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

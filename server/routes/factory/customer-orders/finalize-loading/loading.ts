/**
 * orderFinalizeLoadingRoutes: OrderLoading endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { parseId } from "../../../../lib/parseId";
import { dispatchNotification } from "../../../../lib/notificationService";
import { getClientDate } from "../../../../lib/dateUtils";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { writeDaybookEntry } from "../../_helpers";
import { syncProformaReservations } from "../../_stockReservationHelper";
import { acquireProformaCapacityTransactionLock } from "../proformaCapacityConcurrency";
import { getProformaCapacitySnapshot } from "../proformaCapacity";
import { buildRemainingLoadingPlan } from "../remainingLoadingPlan";
import { mergeNewProformaArticles } from "../proformaPlan";
import { guardProformaOrderCreation } from "../proformaCapacityWriteGuards";
import {
  factoryBales,
  customerOrders,
  customerOrderBales,
  customerOrderExpectedLines,
  customerProformas,
  customerProformaLines,
  customers,
  factoryDaybookEntries,
} from "@shared/schema";
import { eq, and, inArray, isNull, ne } from "drizzle-orm";
import { isFactorySessionLocation } from "../../../helpers/companyOwnership";
import { plusMoney, toMoney } from "../../../../lib/money";

export function registerOrderLoadingRoutes(app: Express) {
  app.post("/api/factory/customer-orders-loading", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { customerId, proformaIdUsed, locationId, orderDate, containerNotes } = req.body;
      if (!customerId) return res.status(400).json({ message: "Customer is required" });
      if (!locationId) return res.status(400).json({ message: "Location is required" });
      if (!(await isFactorySessionLocation(req.session, locationId))) {
        return res.status(400).json({ message: "Location not found" });
      }

      const parsedCustomerId = parseInt(customerId);
      const parsedProformaId = proformaIdUsed ? parseInt(proformaIdUsed) : null;

      // Capacity is checked and the order is inserted inside one locked
      // transaction. Checking outside it let two loadings for the same proforma
      // each read the last remaining slot and both take it.
      const creation = await db.transaction(async (tx) => {
        if (parsedProformaId) {
          await acquireProformaCapacityTransactionLock(tx, { companyId, proformaId: parsedProformaId });
          const guard = await guardProformaOrderCreation(tx, {
            companyId,
            proformaId: parsedProformaId,
            customerId: parsedCustomerId,
          });
          if (!guard.allowed) return { ok: false, rejection: guard } as const;
        }

        const [created] = await tx
          .insert(customerOrders)
          .values({
            companyId,
            customerId: parsedCustomerId,
            proformaIdUsed: parsedProformaId,
            locationId: parseInt(locationId),
            orderDate: orderDate || getClientDate(req),
            status: "LOADING",
            loadingStartedAt: new Date(),
            containerNotes: containerNotes || null,
          })
          .returning();
        return { ok: true, order: created } as const;
      });

      if (!creation.ok) {
        return res.status(creation.rejection.status).json(creation.rejection.body);
      }
      const order = creation.order;

      const [loadingCustomer] = await db
        .select({ legalName: customers.legalName })
        .from(customers)
        .where(eq(customers.id, parseInt(customerId)));
      const loadingToday = orderDate || getClientDate(req);
      await writeDaybookEntry(db, {
        companyId,
        txDate: loadingToday,
        txType: "LOADING_CREATED",
        referenceId: order.id,
        referenceTable: "customer_orders",
        description: `Loading started for customer: ${loadingCustomer?.legalName || customerId}`,
      });

      dispatchNotification({
        eventType: "LOADING_STARTED",
        title: "Loading Started",
        message: `New loading started for ${loadingCustomer?.legalName || "customer"}`,
        entityType: "customer_order",
        entityId: order.id,
        triggeredByUserId: req.session?.userId ?? null,
        companyId,
      }).catch(() => {});

      res.json(order);
    } catch (error: unknown) {
      logger.error("Error creating loading order:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/customer-orders/:id/finalize-loading", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const orderId = parseId(req.params.id);
      if (orderId === null) return res.status(400).json({ message: "Invalid id" });
      // Keep accepting the legacy flag so an older browser bundle still gets
      // the new carried-over-proforma behavior after the server is deployed.
      const createCarryoverProforma =
        req.body?.createCarryoverProforma === true || req.body?.createContinuation === true;
      // This is a separate workflow: keep the reusable proforma active and open
      // an empty loading, rather than splitting/deactivating the source proforma.
      const createNextLoading = req.body?.createNextLoading === true;
      if (createNextLoading && createCarryoverProforma) {
        return res.status(400).json({ message: "Choose either a new loading or legacy proforma carryover" });
      }

      // The date selected in Validate & Finalize is the business-effective date.
      // Keep a separate actual timestamp for audit/update bookkeeping.
      const txDate = req.body?.txDate || getClientDate(req);
      if (
        typeof txDate !== "string" ||
        !/^\d{4}-\d{2}-\d{2}$/.test(txDate) ||
        Number.isNaN(Date.parse(txDate)) ||
        new Date(`${txDate}T12:00:00.000Z`).toISOString().slice(0, 10) !== txDate
      ) {
        return res.status(400).json({ message: "Invalid finalization date (expected YYYY-MM-DD)" });
      }
      const effectiveFinalizedAt = new Date(`${txDate}T12:00:00.000Z`);

      const finalized = await db.transaction(async (tx) => {
        // Finalization consumes the proforma and may split a carried-over one,
        // so it serializes against scanners and imports on the same proforma.
        // Read the link with an unlocked select first so the proforma lock is
        // taken before the order row lock, the ordering every protected path
        // follows; the locked read below is still the authoritative one.
        const [orderProformaLink] = await tx
          .select({ proformaIdUsed: customerOrders.proformaIdUsed })
          .from(customerOrders)
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)));
        if (orderProformaLink?.proformaIdUsed) {
          await acquireProformaCapacityTransactionLock(tx, {
            companyId,
            proformaId: orderProformaLink.proformaIdUsed,
          });
        }

        const [order] = await tx
          .select()
          .from(customerOrders)
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)))
          .for("update");
        if (!order) throw new Error("Order not found");
        if (order.status !== "LOADING") throw new Error("Only LOADING orders can be finalized for loading");

        if (order.proformaIdUsed && order.proformaIdUsed !== orderProformaLink?.proformaIdUsed) {
          await acquireProformaCapacityTransactionLock(tx, {
            companyId,
            proformaId: order.proformaIdUsed,
          });
        }

        const bales = await tx.select().from(customerOrderBales).where(eq(customerOrderBales.orderId, orderId));
        if (bales.length === 0) throw new Error("Order has no bales scanned");

        // Use the current loading's own immutable expected plan, when present.
        // Otherwise this is the first container and the proforma is the plan.
        // In both cases only this container's bales are subtracted.
        const nextLoadingLines: Array<{
          articleCode: string;
          productName: string | null;
          expectedQty: number;
          proformaLineId: number | null;
        }> = [];
        let nextLoadingRemainingBales = 0;
        if (createNextLoading) {
          if (!order.proformaIdUsed) {
            throw new Error("A linked proforma is required to open a loading for remaining quantities");
          }
          const [proforma] = await tx
            .select({ id: customerProformas.id, isActive: customerProformas.isActive })
            .from(customerProformas)
            .where(
              and(
                eq(customerProformas.id, order.proformaIdUsed),
                eq(customerProformas.companyId, companyId),
                eq(customerProformas.customerId, order.customerId),
                isNull(customerProformas.deletedAt)
              )
            );
          if (!proforma?.isActive) throw new Error("Linked proforma is no longer active");

          const existingPlan = await tx
            .select({
              articleCode: customerOrderExpectedLines.articleCode,
              productName: customerOrderExpectedLines.productName,
              expectedQty: customerOrderExpectedLines.expectedQty,
              proformaLineId: customerOrderExpectedLines.proformaLineId,
            })
            .from(customerOrderExpectedLines)
            .where(
              and(
                eq(customerOrderExpectedLines.orderId, orderId),
                eq(customerOrderExpectedLines.companyId, companyId),
                eq(customerOrderExpectedLines.proformaId, proforma.id)
              )
            );
          const proformaLines = await tx
            .select({
              id: customerProformaLines.id,
              articleCode: customerProformaLines.articleCode,
              productName: customerProformaLines.productName,
              quantity: customerProformaLines.quantity,
              createdAt: customerProformaLines.createdAt,
            })
            .from(customerProformaLines)
            .where(eq(customerProformaLines.proformaId, proforma.id));

          // The shared capacity engine counts each distinct physical bale once,
          // including the article-code fallbacks used by the scan route.
          const capacity = await getProformaCapacitySnapshot(tx, {
            companyId,
            proformaId: proforma.id,
            currentOrderId: orderId,
          });
          if (!capacity) throw new Error("Unable to read loading capacity");
          const loadedByArticle = new Map(
            capacity.articles.map((article) => [article.normalizedArticleCode, article.currentOrderLoadedQty])
          );
          const masterPlan = proformaLines.map((line) => ({
            articleCode: line.articleCode,
            productName: line.productName,
            expectedQty: line.quantity,
            proformaLineId: line.id,
            createdAt: line.createdAt,
          }));
          const plan = buildRemainingLoadingPlan(
            mergeNewProformaArticles(existingPlan, masterPlan, true, order.createdAt),
            loadedByArticle
          );
          nextLoadingLines.push(...plan.lines);
          nextLoadingRemainingBales = plan.remainingBales;
          if (nextLoadingRemainingBales <= 0) {
            throw new Error("This loading has no remaining proforma quantities; use Finalize Only");
          }
        }

        let carriedOverProforma: typeof customerProformas.$inferSelect | null = null;
        if (createCarryoverProforma && order.proformaIdUsed) {
          const [proforma] = await tx
            .select()
            .from(customerProformas)
            .where(
              and(
                eq(customerProformas.id, order.proformaIdUsed),
                eq(customerProformas.companyId, companyId),
                eq(customerProformas.customerId, order.customerId),
                eq(customerProformas.isActive, true),
                isNull(customerProformas.deletedAt)
              )
            )
            .for("update");
          const proformaLines = proforma
            ? await tx
                .select()
                .from(customerProformaLines)
                .where(eq(customerProformaLines.proformaId, order.proformaIdUsed))
            : [];
          const relatedOrders = await tx
            .select({ id: customerOrders.id, status: customerOrders.status })
            .from(customerOrders)
            .where(
              and(
                eq(customerOrders.companyId, companyId),
                eq(customerOrders.proformaIdUsed, order.proformaIdUsed),
                ne(customerOrders.status, "CANCELLED"),
                isNull(customerOrders.deletedAt)
              )
            );
          const activeRelatedOrder = relatedOrders.find(
            (related) => related.id !== orderId && ["DRAFT", "LOADING", "PENDING_VERIFICATION"].includes(related.status)
          );
          if (activeRelatedOrder) {
            throw new Error(`Cannot move remaining while loading #${activeRelatedOrder.id} still uses this proforma`);
          }
          const relatedOrderIds = relatedOrders.map((related) => related.id);
          const relatedBales =
            relatedOrderIds.length > 0
              ? await tx
                  .select({ articleCode: customerOrderBales.articleCode })
                  .from(customerOrderBales)
                  .where(inArray(customerOrderBales.orderId, relatedOrderIds))
              : [];
          const normalizeArticleCode = (value: string | null | undefined) => (value || "").trim().toLowerCase();
          const loadedByArticle = new Map<string, number>();
          for (const bale of relatedBales) {
            const articleCode = normalizeArticleCode(bale.articleCode);
            if (!articleCode) continue;
            loadedByArticle.set(articleCode, (loadedByArticle.get(articleCode) || 0) + 1);
          }
          // Apply loaded bales once across duplicate/case-variant article lines,
          // retaining each source line's own pricing for whatever remains.
          const unallocatedLoadedByArticle = new Map(loadedByArticle);
          const remainingLines = proformaLines.flatMap((line) => {
            const articleCode = normalizeArticleCode(line.articleCode);
            const loaded = unallocatedLoadedByArticle.get(articleCode) || 0;
            const appliedLoaded = Math.min(line.quantity, loaded);
            unallocatedLoadedByArticle.set(articleCode, loaded - appliedLoaded);
            const quantity = line.quantity - appliedLoaded;
            return quantity > 0 ? [{ line, quantity }] : [];
          });
          const remainingTotal = remainingLines.reduce((sum, { quantity }) => sum + quantity, 0);

          if (proforma && remainingTotal > 0) {
            const carriedOverName = `${proforma.name} - ${remainingTotal} Remaining - Carried Over`;
            [carriedOverProforma] = await tx
              .insert(customerProformas)
              .values({
                companyId,
                customerId: order.customerId,
                name: carriedOverName,
                isActive: true,
                status: "ACTIVE",
              })
              .returning();

            await tx.insert(customerProformaLines).values(
              remainingLines.map(({ line, quantity }) => ({
                proformaId: carriedOverProforma!.id,
                articleCode: line.articleCode,
                productName: line.productName,
                quantity,
                pricePerBale: line.pricePerBale,
                productionPricePerBale: line.productionPricePerBale,
                priceFixed: line.priceFixed,
                pricingMode: line.pricingMode,
                pricePerKg: line.pricePerKg,
              }))
            );

            // The carried-over proforma replaces the original document's
            // outstanding commitment. Release the original reservation and
            // reserve only the copied remaining quantities, atomically.
            await tx
              .update(customerProformas)
              .set({
                isActive: false,
                status: "PARTIALLY_DISPATCHED",
                updatedAt: new Date(),
              })
              .where(
                and(
                  eq(customerProformas.id, proforma.id),
                  eq(customerProformas.companyId, companyId),
                  eq(customerProformas.customerId, order.customerId)
                )
              );
            await syncProformaReservations(tx, companyId, proforma.id);
            await syncProformaReservations(tx, companyId, carriedOverProforma.id);
          }
        }

        const now = new Date();
        const [updated] = await tx
          .update(customerOrders)
          .set({
            status: "VERIFIED",
            // Remember that this invoice originated in the loading workflow.
            // The later invoice-finalization step must preserve this value so a
            // revert returns here instead of incorrectly returning to VERIFIED.
            previousStatus: "LOADING",
            // A reopened loading keeps its first confirmed loading date. Re-verification
            // may happen days later and must not silently replace that date.
            loadingFinalizedAt: order.loadingFinalizedAt ?? effectiveFinalizedAt,
            verifiedAt: effectiveFinalizedAt,
            updatedAt: now,
          })
          .where(and(eq(customerOrders.id, orderId), eq(customerOrders.companyId, companyId)))
          .returning();

        // V5 guard: proformaIdUsed IS NOT NULL.
        // The previous implementation issued one UPDATE per scanned bale, so a
        // 700-bale loading generated ~700 database calls. Set the exact same SOLD
        // state in one company-scoped statement instead.
        if (order.proformaIdUsed) {
          const baleIds = [
            ...new Set(bales.map((b) => Number(b.baleId)).filter((id: number) => Number.isSafeInteger(id) && id > 0)),
          ];
          if (baleIds.length > 0) {
            await tx
              .update(factoryBales)
              .set({ status: "SOLD", updatedAt: now })
              .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, baleIds)));
          }
        }

        const [loadingCustomer] = await tx
          .select({ legalName: customers.legalName })
          .from(customers)
          .where(eq(customers.id, order.customerId));
        const totalValue = bales.reduce((sum: number, b) => plusMoney(sum, b.priceUsed), 0);

        await writeDaybookEntry(tx, {
          companyId,
          txDate,
          txType: "LOADING_SUBMITTED",
          referenceId: orderId,
          referenceTable: "customer_orders",
          description: `Loading submitted: ${loadingCustomer?.legalName || "Customer"}, ${bales.length} bale${bales.length !== 1 ? "s" : ""} scanned`,
          amountCurrency: totalValue,
          amountUsd: totalValue,
        });

        // Also write ORDER_VERIFIED immediately since we skip the Pending step.
        const verifyTotalValue = toMoney(updated?.grandTotal).toNumber() || totalValue;
        await tx
          .delete(factoryDaybookEntries)
          .where(
            and(
              eq(factoryDaybookEntries.companyId, companyId),
              eq(factoryDaybookEntries.txType, "ORDER_VERIFIED"),
              eq(factoryDaybookEntries.referenceId, orderId)
            )
          );
        await writeDaybookEntry(tx, {
          companyId,
          txDate,
          txType: "ORDER_VERIFIED",
          referenceId: orderId,
          referenceTable: "customer_orders",
          description: `Order verified for customer: ${loadingCustomer?.legalName || "Customer"}`,
          amountCurrency: verifyTotalValue,
          amountUsd: verifyTotalValue,
        });

        // Both actions commit together: a failure to create the next loading
        // must not leave the original container finalized without its successor.
        let nextLoading: { id: number; remainingBales: number } | null = null;
        if (createNextLoading) {
          const [created] = await tx
            .insert(customerOrders)
            .values({
              companyId,
              customerId: order.customerId,
              proformaIdUsed: order.proformaIdUsed,
              locationId: order.locationId,
              orderDate: getClientDate(req),
              status: "LOADING",
              loadingStartedAt: now,
              containerNotes: null,
            })
            .returning();
          if (!created) throw new Error("Could not create the next loading");
          // Persist the remaining-only plan BEFORE this transaction commits.
          // It is used for the next loading's progress, scan limits, and any
          // subsequent continuation. Original proforma lines stay untouched.
          await tx.insert(customerOrderExpectedLines).values(
            nextLoadingLines.map((line) => ({
              companyId,
              orderId: created.id,
              proformaId: order.proformaIdUsed,
              proformaLineId: line.proformaLineId,
              articleCode: line.articleCode,
              productName: line.productName,
              expectedQty: line.expectedQty,
            }))
          );
          nextLoading = { id: created.id, remainingBales: nextLoadingRemainingBales };
          await writeDaybookEntry(tx, {
            companyId,
            txDate: getClientDate(req),
            txType: "LOADING_CREATED",
            referenceId: created.id,
            referenceTable: "customer_orders",
            description: `Continuation of loading #${orderId} for ${loadingCustomer?.legalName || "Customer"}`,
          });
        }

        return {
          updated,
          customerName: loadingCustomer?.legalName || "customer",
          baleCount: bales.length,
          carriedOverProforma,
          nextLoading,
        };
      });

      const lsMsg = `${finalized.baleCount} bale${finalized.baleCount !== 1 ? "s" : ""} verified for ${finalized.customerName}`;
      dispatchNotification({
        eventType: "LOADING_FINALIZED",
        title: "Loading Finalized",
        message: lsMsg,
        entityType: "customer_order",
        entityId: orderId,
        triggeredByUserId: req.session?.userId ?? null,
        companyId,
      }).catch(() => {});

      if (finalized.nextLoading) {
        dispatchNotification({
          eventType: "LOADING_STARTED",
          title: "Loading Started",
          message: `Continuation loading #${finalized.nextLoading.id} started for ${finalized.customerName}`,
          entityType: "customer_order",
          entityId: finalized.nextLoading.id,
          triggeredByUserId: req.session?.userId ?? null,
          companyId,
        }).catch(() => {});
      }

      res.json({
        ...finalized.updated,
        ...(finalized.carriedOverProforma ? { carriedOverProforma: finalized.carriedOverProforma } : {}),
        ...(finalized.nextLoading ? { nextLoading: finalized.nextLoading } : {}),
      });
    } catch (error: unknown) {
      logger.error("Error finalizing loading:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}

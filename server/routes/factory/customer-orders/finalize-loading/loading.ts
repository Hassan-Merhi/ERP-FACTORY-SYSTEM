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
import { guardProformaOrderCreation } from "../proformaCapacityWriteGuards";
import {
  factoryBales,
  customerOrders,
  customerOrderBales,
  customerProformas,
  customerProformaLines,
  customers,
  factoryDaybookEntries,
} from "@shared/schema";
import { eq, and, inArray, isNull, ne } from "drizzle-orm";

export function registerOrderLoadingRoutes(app: Express) {
  app.post("/api/factory/customer-orders-loading", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { customerId, proformaIdUsed, locationId, orderDate, containerNotes } = req.body;
      if (!customerId) return res.status(400).json({ message: "Customer is required" });
      if (!locationId) return res.status(400).json({ message: "Location is required" });

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
            loadingFinalizedAt: now,
            verifiedAt: now,
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
        const txDate = req.body?.txDate || getClientDate(req);
        const totalValue = bales.reduce((sum: number, b) => sum + parseFloat(b.priceUsed || "0"), 0);

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
        const verifyTotalValue = parseFloat(updated?.grandTotal || "0") || totalValue;
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

        return {
          updated,
          customerName: loadingCustomer?.legalName || "customer",
          baleCount: bales.length,
          carriedOverProforma,
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

      res.json({
        ...finalized.updated,
        ...(finalized.carriedOverProforma ? { carriedOverProforma: finalized.carriedOverProforma } : {}),
      });
    } catch (error: unknown) {
      logger.error("Error finalizing loading:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}

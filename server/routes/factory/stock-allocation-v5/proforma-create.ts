/**
 * factoryStockAllocationV5Routes: V5ProformaCreate endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { getClientDate } from "../../../lib/dateUtils";
import { customerProformas, customerProformaLines, customerOrders, customerOrderExpectedLines } from "@shared/schema";
import { eq, sql, and } from "drizzle-orm";
import { resultRows } from "../../../lib/queryResult";
import { acquireProformaCapacityTransactionLock } from "../customer-orders/proformaCapacityConcurrency";
import { guardProformaOrderCreation } from "../customer-orders/proformaCapacityWriteGuards";

export function registerV5ProformaCreateRoutes(app: Express) {
  // ── POST /api/factory/v5/proforma-with-loading ──────────────────────────
  // Body: { customerId, name, isActive, lines[], sendToLoading, containerNames[] }
  app.post("/api/factory/v5/proforma-with-loading", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { customerId, name, isActive, lines, sendToLoading, containerNames } = req.body;

      if (!customerId || !name || !Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ message: "customerId, name, and at least one line are required" });
      }
      const validLines = lines.filter((l) => l.articleCode && l.productName && parseInt(l.quantity) > 0);
      if (validLines.length === 0) {
        return res
          .status(400)
          .json({ message: "At least one line must have articleCode, productName, and quantity > 0" });
      }

      const names: string[] = Array.isArray(containerNames) ? containerNames.filter(Boolean) : [];

      const result = await db.transaction(async (tx) => {
        const [proforma] = await tx
          .insert(customerProformas)
          .values({ companyId, customerId: Number(customerId), name, isActive: isActive ?? false })
          .returning();

        const lineValues = validLines.map((l) => ({
          proformaId: proforma.id,
          articleCode: l.articleCode,
          productName: l.productName,
          quantity: parseInt(l.quantity),
          pricePerBale: String(l.pricePerBale ?? "0"),
          productionPricePerBale: String(l.productionPricePerBale ?? "0"),
          pricingMode: l.pricingMode ?? "per_bale",
          pricePerKg:
            l.pricingMode === "per_kg" && l.pricePerKg != null && l.pricePerKg !== "" ? String(l.pricePerKg) : null,
        }));
        const insertedLines = await tx.insert(customerProformaLines).values(lineValues).returning();

        let createdOrders: (typeof customerOrders.$inferSelect)[] = [];
        if (sendToLoading && names.length > 0) {
          const today = getClientDate(req);
          const orderValues = names.map((containerName: string) => ({
            companyId,
            customerId: Number(customerId),
            orderDate: today,
            proformaIdUsed: proforma.id,
            containerNumber: containerName,
            status: "DRAFT",
            subtotalBales: "0",
            freightAmount: "0",
            otherChargesTotal: "0",
            grandTotal: "0",
            totalQtyBales: 0,
          }));
          createdOrders = await tx.insert(customerOrders).values(orderValues).returning();

          // Phase B: Insert one expected line per (container × proforma line).
          // These lock in the expected quantity at order creation time.
          // V5 guard: proformaIdUsed IS NOT NULL (all createdOrders are V5 by construction)
          const expectedLineValues = [];
          for (const order of createdOrders) {
            for (const line of insertedLines) {
              expectedLineValues.push({
                companyId,
                orderId: order.id,
                proformaId: proforma.id,
                proformaLineId: line.id,
                articleCode: line.articleCode,
                productName: line.productName,
                expectedQty: line.quantity,
              });
            }
          }
          if (expectedLineValues.length > 0) {
            await tx.insert(customerOrderExpectedLines).values(expectedLineValues);
          }
        }

        return { proforma, lines: insertedLines, orders: createdOrders };
      });

      res.json(result);
    } catch (err: unknown) {
      logger.error("[V5] proforma-with-loading error:", { error: err });
      res.status(400).json({ message: getErrorMessage(err) });
    }
  });

  // ── POST /api/factory/v5/proforma/:proformaId/add-containers ─────────────
  // Adds new DRAFT containers to an existing active proforma.
  // Creates customer_orders + customer_order_expected_lines for each new container.
  // Does NOT touch existing containers or their expected lines.
  // V5 guard: proformaIdUsed IS NOT NULL (all created orders are V5 by construction)
  app.post("/api/factory/v5/proforma/:proformaId/add-containers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const proformaId = parseInt(req.params.proformaId);
      if (!proformaId || isNaN(proformaId)) return res.status(400).json({ message: "Invalid proformaId" });

      let { containerNames } = req.body;
      if (!Array.isArray(containerNames) || containerNames.length === 0) {
        return res.status(400).json({ message: "containerNames must be a non-empty array" });
      }

      // Trim names
      containerNames = (containerNames as unknown[]).map((n) => String(n ?? "").trim());

      // Reject empty names
      if (containerNames.some((n: string) => !n)) {
        return res.status(400).json({ message: "Container names must not be empty" });
      }

      // Reject duplicates within the request
      const uniqueInReq = new Set(containerNames);
      if (uniqueInReq.size !== containerNames.length) {
        const seen = new Set<string>();
        const dupes = containerNames.filter((n: string) => seen.size === seen.add(n).size);
        return res
          .status(400)
          .json({ message: `Duplicate container names in request: ${Array.from(new Set(dupes)).join(", ")}` });
      }

      // Confirm proforma exists for this company and is active
      const [proforma] = await db
        .select()
        .from(customerProformas)
        .where(and(eq(customerProformas.id, proformaId), eq(customerProformas.companyId, companyId)));
      if (!proforma) return res.status(404).json({ message: "Proforma not found" });
      if (!proforma.isActive) return res.status(400).json({ message: "Proforma is not active" });

      // Reject names that already exist in customer_orders for this proforma (any status,
      // including CANCELLED — prefer strict rejection to avoid confusion)
      const existingOrdersRaw = await db.execute(
        sql`SELECT container_number FROM customer_orders
            WHERE proforma_id_used = ${proformaId}
              AND container_number IS NOT NULL`
      );
      const existingNames = new Set(resultRows(existingOrdersRaw).map((r) => String(r.container_number ?? "").trim()));
      const conflicting = containerNames.filter((n: string) => existingNames.has(n));
      if (conflicting.length > 0) {
        return res
          .status(400)
          .json({ message: `Container name(s) already exist under this proforma: ${conflicting.join(", ")}` });
      }

      // Fetch current proforma lines — used to create expected_lines for each new container
      const proformaLines = await db
        .select()
        .from(customerProformaLines)
        .where(eq(customerProformaLines.proformaId, proformaId));

      const result = await db.transaction(async (tx: Parameters<Parameters<typeof db.transaction>[0]>[0]) => {
        // Capacity is re-checked under the proforma lock inside the same
        // transaction that inserts the containers. Checking it outside let two
        // add-containers calls on one proforma each see the last free slot.
        await acquireProformaCapacityTransactionLock(tx, { companyId, proformaId });
        const guard = await guardProformaOrderCreation(tx, {
          companyId,
          proformaId,
          customerId: proforma.customerId,
        });
        if (!guard.allowed) return { ok: false, rejection: guard } as const;

        const today = getClientDate(req);
        const orderValues = containerNames.map((containerName: string) => ({
          companyId,
          customerId: proforma.customerId,
          orderDate: today,
          proformaIdUsed: proformaId,
          containerNumber: containerName,
          status: "DRAFT",
          subtotalBales: "0",
          freightAmount: "0",
          otherChargesTotal: "0",
          grandTotal: "0",
          totalQtyBales: 0,
        }));
        const createdOrders = await tx.insert(customerOrders).values(orderValues).returning();

        // Phase B: Insert one expected line per (container × proforma line).
        // This locks in the expected qty at order creation time.
        // Existing containers and their expected lines are not touched.
        // V5 guard: proformaIdUsed IS NOT NULL (all createdOrders are V5 by construction)
        const expectedLineValues = [];
        for (const order of createdOrders) {
          for (const line of proformaLines) {
            expectedLineValues.push({
              companyId,
              orderId: order.id,
              proformaId: proformaId,
              proformaLineId: line.id,
              articleCode: line.articleCode,
              productName: line.productName,
              expectedQty: Number(line.quantity),
            });
          }
        }
        if (expectedLineValues.length > 0) {
          await tx.insert(customerOrderExpectedLines).values(expectedLineValues);
        }

        return { ok: true, orders: createdOrders, expectedLinesCreated: expectedLineValues.length } as const;
      });

      if (!result.ok) return res.status(result.rejection.status).json(result.rejection.body);

      res.json({
        added: containerNames.length,
        orders: result.orders,
        expectedLinesCreated: result.expectedLinesCreated,
      });
    } catch (err: unknown) {
      logger.error("[V5] add-containers error:", { error: err });
      res.status(400).json({ message: getErrorMessage(err) });
    }
  });
}

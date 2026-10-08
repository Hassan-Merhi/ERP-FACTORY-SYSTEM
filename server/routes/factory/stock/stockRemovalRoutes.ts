/**
 * factoryStockRoutes: FactoryStockRemoval endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import { adjustInventory } from "../../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../../services/inventory/stockMovementIntegrityService";
import { writeDaybookEntry, verifySupervisorPassword } from "../_helpers";
import { recordFactoryStockValueEventTx, valuedBalesCostTx } from "../../../services/factory/factoryStockValueEvents";
import { factoryBaleProducts, factoryBales, inventory, stockItems, users, userCompanyRoles } from "@shared/schema";
import { eq, and, inArray } from "drizzle-orm";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export function registerFactoryStockRemovalRoutes(app: Express) {
  app.post("/api/factory/stock-entry/remove", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { baleIds, supervisorUsername, supervisorPassword, reason } = req.body;

      if (!baleIds || !Array.isArray(baleIds) || baleIds.length === 0) {
        return res.status(400).json({ message: "baleIds array is required" });
      }
      if (!supervisorUsername || !supervisorPassword) {
        return res.status(400).json({ message: "Supervisor credentials are required" });
      }

      const [supervisor] = await db.select().from(users).where(eq(users.username, supervisorUsername));

      if (!supervisor) {
        return res.status(403).json({ message: "Supervisor not found" });
      }

      const passwordValid = await verifySupervisorPassword(supervisorPassword, supervisor.password);
      if (!passwordValid) {
        return res.status(403).json({ message: "Invalid supervisor password" });
      }

      const [role] = await db
        .select()
        .from(userCompanyRoles)
        .where(and(eq(userCompanyRoles.userId, supervisor.id), eq(userCompanyRoles.companyId, companyId)));

      if (!role || !["Admin", "Owner", "Manager", "Developer"].includes(role.role)) {
        return res.status(403).json({ message: "Supervisor must have Admin, Owner, or Manager role" });
      }

      const result = await db.transaction(async (tx) => {
        const balesToRemove = await tx
          .select()
          .from(factoryBales)
          .where(and(eq(factoryBales.companyId, companyId), inArray(factoryBales.id, baleIds)));

        // Perpetual inventory: the cost of the stock removed is a write-off in
        // the daily factory stock journal (wave 11).
        await recordFactoryStockValueEventTx(tx, {
          companyId,
          kind: "WASTE",
          amount: (
            await valuedBalesCostTx(
              tx,
              companyId,
              balesToRemove.map((bale) => bale.id)
            )
          ).negated(),
          sourceType: "factory-bale-removal",
          sourceId: balesToRemove.map((bale) => bale.id).join(","),
        });

        const removedBales = [];
        const now = new Date();

        const productIds: number[] = [];
        for (const bale of balesToRemove) {
          if (bale.productId && !productIds.includes(bale.productId)) productIds.push(bale.productId);
        }
        const factoryProducts =
          productIds.length > 0
            ? await tx.select().from(factoryBaleProducts).where(inArray(factoryBaleProducts.id, productIds))
            : [];
        const productMap = new Map(factoryProducts.map((p) => [p.id, p]));

        const stockItemCache = new Map<string, number>();

        for (const bale of balesToRemove) {
          const [updated] = await tx
            .update(factoryBales)
            .set({
              status: "DELETED",
              updatedAt: now,
            })
            .where(eq(factoryBales.id, bale.id))
            .returning();

          const factoryProductForBale = productMap.get(bale.productId as number);
          removedBales.push({
            ...updated,
            productName: factoryProductForBale?.name || factoryProductForBale?.articleCode || "Unknown",
          });

          // Only adjust ERP inventory for bales that were actually counted in stock
          if (bale.status === "IN_STOCK" && bale.erpLocationId) {
            const factoryProduct = productMap.get(bale.productId as number);
            const itemCode = factoryProduct?.articleCode || factoryProduct?.code || bale.articleCode || bale.baleCode;

            if (itemCode) {
              let erpStockItemId = stockItemCache.get(itemCode);
              if (!erpStockItemId) {
                const [existing] = await tx
                  .select({ id: stockItems.id })
                  .from(stockItems)
                  .where(and(eq(stockItems.companyId, companyId), eq(stockItems.code, itemCode)));
                if (existing) {
                  erpStockItemId = existing.id;
                  stockItemCache.set(itemCode, erpStockItemId!);
                }
              }

              if (erpStockItemId) {
                const [inventoryBefore] = await tx
                  .select({ averageRate: inventory.averageRate })
                  .from(inventory)
                  .where(
                    and(
                      eq(inventory.companyId, companyId),
                      eq(inventory.locationId, bale.erpLocationId),
                      eq(inventory.stockItemId, erpStockItemId)
                    )
                  )
                  .limit(1);
                const preAdjustmentRate = Number.parseFloat(inventoryBefore?.averageRate || "0");
                const movementUnitCost = Number.isFinite(preAdjustmentRate) ? Math.max(preAdjustmentRate, 0) : 0;

                await adjustInventory(tx, bale.erpLocationId!, erpStockItemId, -1, companyId);
                await postStockMovementTx(
                  tx,
                  {
                    companyId,
                    stockItemId: erpStockItemId,
                    kind: "adjustment",
                    quantity: "1",
                    unitCost: String(movementUnitCost),
                    fromLocationId: bale.erpLocationId,
                    occurredAt: now.toISOString(),
                    source: {
                      sourceType: "factory_bale_removal",
                      sourceId: String(bale.id),
                      idempotencyKey: `factory-bale-removal:${companyId}:${bale.id}`,
                    },
                    actor: {
                      userId: supervisor.id,
                      username: supervisorUsername,
                      reason: reason || "Factory bale stock removal",
                    },
                    allowNegativeStock: true,
                  },
                  canonicalStockMovementAdapter
                );
              }
            }
          }
        }

        return { removed: removedBales };
      });

      const today = getClientDate(req);
      const removalMetaJson = JSON.stringify({
        bales: result.removed.map((b) => ({
          id: b.id,
          ref: b.referenceNumber,
          productName: b.productName || "Unknown",
          weightKg: b.weightKg,
          status: "DELETED",
        })),
      });
      await writeDaybookEntry(db, {
        companyId,
        txDate: today,
        txType: "BALE_REMOVAL",
        description: `Removed ${result.removed.length} bale(s) from stock. Supervisor: ${supervisorUsername}. Reason: ${reason || "N/A"}`,
        metaJson: removalMetaJson,
      });

      res.json({ removed: result.removed.length, bales: result.removed });
    } catch (error: unknown) {
      logger.error("Error removing bales:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // Remove N bales of a specific product from a specific location
  app.post("/api/factory/stock-entry/remove-by-product", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { productId, locationId, qty, supervisorUsername, supervisorPassword, reason } = req.body;

      if (!productId || !locationId || !qty || qty < 1) {
        return res.status(400).json({ message: "productId, locationId, and qty >= 1 are required" });
      }
      if (!supervisorUsername || !supervisorPassword) {
        return res.status(400).json({ message: "Supervisor credentials are required" });
      }

      const [supervisor] = await db.select().from(users).where(eq(users.username, supervisorUsername));

      if (!supervisor) return res.status(403).json({ message: "Supervisor not found" });

      const passwordValid = await verifySupervisorPassword(supervisorPassword, supervisor.password);
      if (!passwordValid) return res.status(403).json({ message: "Invalid supervisor password" });

      const [role] = await db
        .select()
        .from(userCompanyRoles)
        .where(and(eq(userCompanyRoles.userId, supervisor.id), eq(userCompanyRoles.companyId, companyId)));

      if (!role || !["Admin", "Owner", "Manager", "Developer"].includes(role.role)) {
        return res.status(403).json({ message: "Supervisor must have Admin, Owner, or Manager role" });
      }

      const result = await db.transaction(async (tx) => {
        const balesToRemove = await tx
          .select()
          .from(factoryBales)
          .where(
            and(
              eq(factoryBales.companyId, companyId),
              eq(factoryBales.productId, productId),
              eq(factoryBales.erpLocationId, locationId),
              eq(factoryBales.status, "IN_STOCK")
            )
          )
          .limit(qty);

        if (balesToRemove.length === 0) {
          throw new Error("No in-stock bales found for this product at this location");
        }

        await recordFactoryStockValueEventTx(tx, {
          companyId,
          kind: "WASTE",
          amount: (
            await valuedBalesCostTx(
              tx,
              companyId,
              balesToRemove.map((bale) => bale.id)
            )
          ).negated(),
          sourceType: "factory-bale-removal",
          sourceId: balesToRemove.map((bale) => bale.id).join(","),
        });

        const removedBales = [];
        const now = new Date();
        const [factoryProduct] = await tx
          .select()
          .from(factoryBaleProducts)
          .where(eq(factoryBaleProducts.id, productId));
        const itemCode = factoryProduct?.articleCode || factoryProduct?.code;
        let erpStockItemId: number | undefined;
        if (itemCode) {
          const [existing] = await tx
            .select({ id: stockItems.id })
            .from(stockItems)
            .where(and(eq(stockItems.companyId, companyId), eq(stockItems.code, itemCode)));
          if (existing) erpStockItemId = existing.id;
        }

        for (const bale of balesToRemove) {
          const [updated] = await tx
            .update(factoryBales)
            .set({ status: "DELETED", updatedAt: now })
            .where(eq(factoryBales.id, bale.id))
            .returning();
          removedBales.push({
            ...updated,
            productName: factoryProduct?.name || factoryProduct?.articleCode || "Unknown",
          });
          if (erpStockItemId) {
            const [inventoryBefore] = await tx
              .select({ averageRate: inventory.averageRate })
              .from(inventory)
              .where(
                and(
                  eq(inventory.companyId, companyId),
                  eq(inventory.locationId, bale.erpLocationId!),
                  eq(inventory.stockItemId, erpStockItemId)
                )
              )
              .limit(1);
            const preAdjustmentRate = Number.parseFloat(inventoryBefore?.averageRate || "0");
            const movementUnitCost = Number.isFinite(preAdjustmentRate) ? Math.max(preAdjustmentRate, 0) : 0;

            await adjustInventory(tx, bale.erpLocationId!, erpStockItemId, -1, companyId);
            await postStockMovementTx(
              tx,
              {
                companyId,
                stockItemId: erpStockItemId,
                kind: "adjustment",
                quantity: "1",
                unitCost: String(movementUnitCost),
                fromLocationId: bale.erpLocationId,
                occurredAt: now.toISOString(),
                source: {
                  sourceType: "factory_bale_removal",
                  sourceId: String(bale.id),
                  idempotencyKey: `factory-bale-removal:${companyId}:${bale.id}`,
                },
                actor: {
                  userId: supervisor.id,
                  username: supervisorUsername,
                  reason: reason || "Factory bale stock removal",
                },
                allowNegativeStock: true,
              },
              canonicalStockMovementAdapter
            );
          }
        }
        return { removed: removedBales };
      });

      const today = getClientDate(req);
      const baleMetaJson = JSON.stringify({
        bales: result.removed.map((b) => ({
          id: b.id,
          ref: b.referenceNumber,
          productName: b.productName || "Unknown",
          weightKg: b.weightKg,
          status: "DELETED",
        })),
      });
      await writeDaybookEntry(db, {
        companyId,
        txDate: today,
        txType: "BALE_REMOVAL",
        description: `Removed ${result.removed.length} bale(s) from stock. Supervisor: ${supervisorUsername}. Reason: ${reason || "N/A"}`,
        metaJson: baleMetaJson,
      });

      res.json({ removed: result.removed.length, bales: result.removed });
    } catch (error: unknown) {
      logger.error("Error removing bales by product:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}

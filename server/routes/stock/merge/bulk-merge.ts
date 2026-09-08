/**
 * stockMergeRoutes: StockItemBulkMerge endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import {
  addInventoryValues,
  divideInventoryValues,
  inventoryMoney,
  inventoryQuantity,
  inventoryUnitCost,
} from "../../../lib/inventoryMath";
import { db } from "../../../db";
import { requireAuth, requireNonPOS } from "../../../auth";
import {
  inventory,
  stockItems,
  stockItemCodeAliases,
  stockItemMergeLogs,
  stockItemLocationPrices,
  poLineItems,
} from "@shared/schema";
import { eq, and, sql, isNull } from "drizzle-orm";

export function registerStockItemBulkMergeRoutes(app: Express) {
  app.post("/api/stock-items/bulk-merge", requireAuth, requireNonPOS, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      // `users.id` is a varchar UUID and `session.userId` is a string; the old
      // `: number` annotation was untrue and only survived because `req` was `any`.
      const userId = req.user?.id ?? req.session.userId ?? "";

      const pairs: { oldCode: string; keepCode: string }[] = req.body.pairs ?? [];
      if (!Array.isArray(pairs) || pairs.length === 0)
        return res.status(400).json({ message: "pairs array is required and must not be empty" });
      if (pairs.length > 500) return res.status(400).json({ message: "Maximum 500 pairs per request" });

      async function resolveItem(code: string) {
        const trimmed = code.trim().toUpperCase();
        const [direct] = await db
          .select()
          .from(stockItems)
          .where(
            and(
              eq(stockItems.companyId, companyId!),
              sql`UPPER(${stockItems.code}) = ${trimmed}`,
              isNull(stockItems.deletedAt)
            )
          )
          .limit(1);
        if (direct) return direct;
        const [aliasRow] = await db
          .select({ stockItemId: stockItemCodeAliases.stockItemId })
          .from(stockItemCodeAliases)
          .where(
            and(
              eq(stockItemCodeAliases.companyId, companyId!),
              sql`UPPER(${stockItemCodeAliases.aliasCode}) = ${trimmed}`
            )
          )
          .limit(1);
        if (!aliasRow) return null;
        const [fromAlias] = await db
          .select()
          .from(stockItems)
          .where(and(eq(stockItems.id, aliasRow.stockItemId), isNull(stockItems.deletedAt)))
          .limit(1);
        return fromAlias ?? null;
      }

      type PairResult = {
        oldCode: string;
        keepCode: string;
        status: "success" | "skipped" | "error";
        reason?: string;
        keptItemName?: string;
        oldItemName?: string;
        keptItemId?: number;
        mergedItemId?: number;
      };

      const results: PairResult[] = [];

      for (const pair of pairs) {
        const { oldCode, keepCode } = pair;
        if (!oldCode || !keepCode) {
          results.push({
            oldCode: oldCode ?? "",
            keepCode: keepCode ?? "",
            status: "skipped",
            reason: "Missing code",
          });
          continue;
        }

        try {
          const [keptItem, duplicateItem] = await Promise.all([resolveItem(keepCode), resolveItem(oldCode)]);

          if (!keptItem) {
            results.push({ oldCode, keepCode, status: "skipped", reason: `Keep code "${keepCode}" not found` });
            continue;
          }
          if (!duplicateItem) {
            results.push({ oldCode, keepCode, status: "skipped", reason: `Old code "${oldCode}" not found` });
            continue;
          }
          if (keptItem.id === duplicateItem.id) {
            results.push({
              oldCode,
              keepCode,
              status: "skipped",
              reason: "Old and keep codes resolve to the same item",
              keptItemName: keptItem.name,
              oldItemName: duplicateItem.name,
            });
            continue;
          }
          if (duplicateItem.deletedAt) {
            results.push({
              oldCode,
              keepCode,
              status: "skipped",
              reason: "Old item is already merged or deleted",
              keptItemName: keptItem.name,
              oldItemName: duplicateItem.name,
            });
            continue;
          }
          if (keptItem.uom !== duplicateItem.uom) {
            results.push({
              oldCode,
              keepCode,
              status: "skipped",
              reason: `UOM mismatch: "${keptItem.uom}" vs "${duplicateItem.uom}"`,
              keptItemName: keptItem.name,
              oldItemName: duplicateItem.name,
            });
            continue;
          }

          const keptId = keptItem.id;
          const duplicateId = duplicateItem.id;

          const keptInvBefore = await db
            .select()
            .from(inventory)
            .where(and(eq(inventory.stockItemId, keptId), eq(inventory.companyId, companyId)));
          const dupInvBefore = await db
            .select()
            .from(inventory)
            .where(and(eq(inventory.stockItemId, duplicateId), eq(inventory.companyId, companyId)));

          const totalValueBefore = addInventoryValues(
            ...[...keptInvBefore, ...dupInvBefore].map((row) => row.totalValue)
          );

          const snapshotBefore: Record<string, unknown> = {};
          for (const r of [...keptInvBefore, ...dupInvBefore]) {
            snapshotBefore[`${r.stockItemId}_${r.locationId}`] = {
              stockItemId: r.stockItemId,
              locationId: r.locationId,
              quantity: r.quantity,
              averageRate: r.averageRate,
              totalValue: r.totalValue,
            };
          }

          const snapshotAfter: Record<string, unknown> = {};

          await db.transaction(async (tx) => {
            const keptMap = new Map(keptInvBefore.map((r) => [r.locationId, r]));

            for (const dupRow of dupInvBefore) {
              const locId = dupRow.locationId;
              const keptRow = keptMap.get(locId);
              if (!keptRow) {
                await tx
                  .update(inventory)
                  .set({ stockItemId: keptId, lastUpdated: new Date() })
                  .where(and(eq(inventory.stockItemId, duplicateId), eq(inventory.locationId, locId)));
              } else {
                const combinedQty = addInventoryValues(keptRow.quantity, dupRow.quantity);
                const combinedValue = addInventoryValues(keptRow.totalValue, dupRow.totalValue);
                const combinedRate = divideInventoryValues(combinedValue, combinedQty);
                await tx
                  .update(inventory)
                  .set({
                    quantity: inventoryQuantity(combinedQty),
                    totalValue: inventoryMoney(combinedValue),
                    averageRate: inventoryUnitCost(combinedRate),
                    lastUpdated: new Date(),
                  })
                  .where(and(eq(inventory.stockItemId, keptId), eq(inventory.locationId, locId)));
                await tx
                  .delete(inventory)
                  .where(and(eq(inventory.stockItemId, duplicateId), eq(inventory.locationId, locId)));
              }
            }

            const dupAliases = await tx
              .select()
              .from(stockItemCodeAliases)
              .where(eq(stockItemCodeAliases.stockItemId, duplicateId));
            const keptAliases = await tx
              .select()
              .from(stockItemCodeAliases)
              .where(eq(stockItemCodeAliases.stockItemId, keptId));
            const keptAliasCodes = new Set([keptItem.code, ...keptAliases.map((a) => a.aliasCode)]);
            for (const alias of dupAliases) {
              if (keptAliasCodes.has(alias.aliasCode)) continue;
              await tx
                .update(stockItemCodeAliases)
                .set({ stockItemId: keptId })
                .where(eq(stockItemCodeAliases.id, alias.id));
              keptAliasCodes.add(alias.aliasCode);
            }
            if (!keptAliasCodes.has(duplicateItem.code)) {
              await tx.insert(stockItemCodeAliases).values({
                companyId,
                stockItemId: keptId,
                aliasCode: duplicateItem.code,
                description: `Merged from: ${duplicateItem.name}`,
              });
            }

            const dupPrices = await tx
              .select()
              .from(stockItemLocationPrices)
              .where(eq(stockItemLocationPrices.stockItemId, duplicateId));
            const keptPrices = await tx
              .select()
              .from(stockItemLocationPrices)
              .where(eq(stockItemLocationPrices.stockItemId, keptId));
            const keptPriceLocations = new Set(keptPrices.map((p) => p.locationId));
            for (const price of dupPrices) {
              if (!keptPriceLocations.has(price.locationId)) {
                await tx
                  .update(stockItemLocationPrices)
                  .set({ stockItemId: keptId })
                  .where(eq(stockItemLocationPrices.id, price.id));
              } else {
                await tx.delete(stockItemLocationPrices).where(eq(stockItemLocationPrices.id, price.id));
              }
            }

            await tx
              .update(poLineItems)
              .set({ stockItemId: keptId, itemName: keptItem.name })
              .where(eq(poLineItems.stockItemId, duplicateId));

            await tx
              .update(stockItems)
              .set({ active: false, deletedAt: new Date(), name: `[MERGED] ${duplicateItem.name}` })
              .where(eq(stockItems.id, duplicateId));

            const keptInvAfter = await tx
              .select()
              .from(inventory)
              .where(and(eq(inventory.stockItemId, keptId), eq(inventory.companyId, companyId)));
            const totalValueAfter = addInventoryValues(...keptInvAfter.map((row) => row.totalValue));
            if (totalValueAfter.minus(totalValueBefore).abs().greaterThan("0.02")) {
              throw new Error(
                `Value integrity check failed — before: ${inventoryMoney(totalValueBefore)}, after: ${inventoryMoney(totalValueAfter)}`
              );
            }

            for (const r of keptInvAfter) {
              snapshotAfter[`${r.stockItemId}_${r.locationId}`] = {
                stockItemId: r.stockItemId,
                locationId: r.locationId,
                quantity: r.quantity,
                averageRate: r.averageRate,
                totalValue: r.totalValue,
              };
            }
          });

          try {
            await db.insert(stockItemMergeLogs).values({
              companyId,
              keptItemId: keptId,
              keptItemCode: keptItem.code.slice(0, 50),
              keptItemName: keptItem.name,
              mergedItemId: duplicateId,
              mergedItemCode: duplicateItem.code.slice(0, 50),
              mergedItemName: duplicateItem.name,
              snapshotBefore,
              snapshotAfter,
              mergedByUserId: String(userId),
              notes: `Bulk merge via Excel`,
            });
          } catch (_auditErr) {
            /* non-fatal */
          }

          results.push({
            oldCode,
            keepCode,
            status: "success",
            keptItemName: keptItem.name,
            oldItemName: duplicateItem.name,
            keptItemId: keptId,
            mergedItemId: duplicateId,
          });
        } catch (pairErr: unknown) {
          results.push({ oldCode, keepCode, status: "error", reason: getErrorMessage(pairErr) });
        }
      }

      return res.json({ results });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

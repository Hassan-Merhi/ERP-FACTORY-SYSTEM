/**
 * factoryStockRoutes: FactoryStockEntry endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { getClientDate } from "../../../lib/dateUtils";
import { db } from "../../../db";
import { isFactorySessionLocation } from "../../helpers/companyOwnership";
import { requireAuth } from "../../../auth";
import { adjustInventory } from "../../../inventoryHelper";
import { writeDaybookEntry } from "../_helpers";
import { factoryBaleProducts, factoryBales, stockItems } from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { MoneyDecimal, parseMoneyInput, toMoney } from "../../../lib/money";
import type Decimal from "decimal.js";
import { registerFactoryStockEntryRoutesPart1 } from "./registerFactoryStockEntryRoutesPart1";
import { validateRequest } from "../../../lib/validateRequest";
import { baleImportInput } from "./stockEntryRoutesSchemas";

export function registerFactoryStockEntryRoutes(app: Express) {
  registerFactoryStockEntryRoutesPart1(app);
  registerFactoryStockEntryRoutesPart2(app);
}

function registerFactoryStockEntryRoutesPart2(app: Express) {
  // ───────────────────────────────────────────────
  // BALE IMPORT - Historical bales from Excel
  // ───────────────────────────────────────────────

  app.post(
    "/api/factory/bales/import",
    requireAuth,
    validateRequest(baleImportInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { erpLocationId, bales } = req.body;
        if (!erpLocationId) return res.status(400).json({ message: "Location is required" });
        if (!(await isFactorySessionLocation(req.session, erpLocationId))) {
          return res.status(400).json({ message: "Location not found" });
        }
        if (!bales || !Array.isArray(bales) || bales.length === 0) {
          return res.status(400).json({ message: "No bales to import" });
        }

        for (const b of bales) {
          if (!b.itemName || !b.barcode || !b.weight) {
            return res.status(400).json({
              message: `Each bale must have itemName, barcode, and weight. Problem row: ${b.itemName || b.barcode || "unknown"}`,
            });
          }
          const importWeight = parseMoneyInput(b.weight);
          if (!importWeight || importWeight.lte(0)) {
            return res.status(400).json({ message: `Invalid weight for ${b.itemName}: ${b.weight}` });
          }
        }

        const allIntendedRefs: string[] = [];
        const payloadDupes = new Set<string>();
        for (const b of bales) {
          const base = b.refNumber && b.refNumber.trim() ? b.refNumber.trim() : b.barcode.trim();
          const qty = parseInt(b.quantity) || 1;
          const refs = qty === 1 ? [base] : Array.from({ length: qty }, (_, i) => `${base}-${i + 1}`);
          for (const ref of refs) {
            if (allIntendedRefs.includes(ref)) payloadDupes.add(ref);
            allIntendedRefs.push(ref);
          }
        }
        if (payloadDupes.size > 0) {
          return res
            .status(400)
            .json({ message: `Duplicate ref numbers within import file: ${Array.from(payloadDupes).join(", ")}` });
        }

        const result = await db.transaction(async (tx) => {
          const existingBarcodes = await tx
            .select({ referenceNumber: factoryBales.referenceNumber })
            .from(factoryBales)
            .where(eq(factoryBales.companyId, companyId));
          const existingRefSet = new Set(existingBarcodes.map((b) => b.referenceNumber));

          const conflicting = allIntendedRefs.filter((ref) => existingRefSet.has(ref));
          if (conflicting.length > 0) {
            throw new Error(
              `Barcodes already exist in system: ${conflicting.slice(0, 10).join(", ")}${conflicting.length > 10 ? ` and ${conflicting.length - 10} more` : ""}`
            );
          }

          const allProducts = await tx
            .select()
            .from(factoryBaleProducts)
            .where(eq(factoryBaleProducts.companyId, companyId));
          type ImportedStockProduct = (typeof allProducts)[number];
          const productByName = new Map<string, ImportedStockProduct>(
            allProducts.map((p: ImportedStockProduct) => [p.name.toLowerCase(), p] as const)
          );

          const createdBales: (typeof factoryBales.$inferSelect)[] = [];
          let totalWeight: Decimal = new MoneyDecimal(0);

          for (const b of bales) {
            const itemName = b.itemName.trim();
            const weight = toMoney(parseMoneyInput(b.weight));
            const qty = parseInt(b.quantity) || 1;
            const barcode = b.barcode.trim();

            let product = productByName.get(itemName.toLowerCase());
            if (!product) {
              const autoPrefix = "HMD00";
              const autoPrefixLen = autoPrefix.length;
              const [autoMaxResult] = await tx
                .select({
                  maxNum: sql<number>`COALESCE(MAX(CAST(SUBSTRING(${factoryBaleProducts.articleCode} FROM ${autoPrefixLen + 1}) AS INTEGER)), 0)`,
                })
                .from(factoryBaleProducts)
                .where(
                  and(
                    eq(factoryBaleProducts.companyId, companyId),
                    sql`${factoryBaleProducts.articleCode} LIKE ${autoPrefix + "%"}`,
                    sql`SUBSTRING(${factoryBaleProducts.articleCode} FROM ${autoPrefixLen + 1}) ~ '^[0-9]+$'`
                  )
                );
              let autoNextNum = (autoMaxResult?.maxNum || 0) + 1;
              let articleCode = `${autoPrefix}${String(autoNextNum).padStart(3, "0")}`;
              let autoAttempts = 0;
              while (autoAttempts < 100) {
                const [dupCheck] = await tx
                  .select({ id: factoryBaleProducts.id })
                  .from(factoryBaleProducts)
                  .where(
                    and(eq(factoryBaleProducts.companyId, companyId), eq(factoryBaleProducts.articleCode, articleCode))
                  );
                if (!dupCheck) break;
                autoNextNum++;
                articleCode = `${autoPrefix}${String(autoNextNum).padStart(3, "0")}`;
                autoAttempts++;
              }
              const code = articleCode;

              const [newProduct] = await tx
                .insert(factoryBaleProducts)
                .values({
                  companyId,
                  code,
                  articleCode,
                  name: itemName,
                  active: true,
                })
                .returning();
              product = newProduct;
              productByName.set(itemName.toLowerCase(), product);
            }

            for (let i = 0; i < qty; i++) {
              const pressedAt = b.productionDate ? new Date(b.productionDate) : null;
              const refBase = b.refNumber && b.refNumber.trim() ? b.refNumber.trim() : barcode;
              const refNum = qty === 1 ? refBase : `${refBase}-${i + 1}`;

              const [bale] = await tx
                .insert(factoryBales)
                .values({
                  companyId,
                  productId: product.id,
                  erpLocationId,
                  baleCode: product.code,
                  referenceNumber: refNum,
                  articleCode: product.articleCode,
                  productName: product.name,
                  weightKg: weight.toString(),
                  costPerKg: "0",
                  totalCost: "0",
                  status: "IN_STOCK",
                  finalizedAt: new Date(),
                  ...(pressedAt && !isNaN(pressedAt.getTime()) ? { pressedAt } : {}),
                })
                .returning();

              createdBales.push(bale);
              totalWeight = totalWeight.plus(weight);
            }
          }

          const stockItemCache = new Map<string, number>();

          for (const bale of createdBales) {
            const product = productByName.get((bale.productName as string).toLowerCase());
            if (!product) continue;
            const itemCode: string = product.articleCode || product.code;
            if (!itemCode) continue;

            let erpStockItemId = stockItemCache.get(itemCode);
            if (!erpStockItemId) {
              const [existing] = await tx
                .select({ id: stockItems.id })
                .from(stockItems)
                .where(and(eq(stockItems.companyId, companyId), eq(stockItems.code, itemCode)));

              if (existing) {
                erpStockItemId = existing.id;
              } else {
                const [created] = await tx
                  .insert(stockItems)
                  .values({ companyId, code: itemCode, name: product.name as string, uom: "BALE", active: true })
                  .returning({ id: stockItems.id });
                erpStockItemId = created.id;
              }
              stockItemCache.set(itemCode, erpStockItemId!);
            }

            await adjustInventory(tx, erpLocationId, erpStockItemId!, 1, companyId, 0);
          }

          return { bales: createdBales, totalWeight, count: createdBales.length };
        });

        const today = getClientDate(req);
        await writeDaybookEntry(db, {
          companyId,
          txDate: today,
          txType: "BALE_IMPORT",
          description: `Imported ${result.count} historical bale(s) into stock (${result.totalWeight.toFixed(1)} kg)`,
        });

        res.json({ imported: result.count, totalWeight: result.totalWeight.toNumber(), bales: result.bales });
      } catch (error: unknown) {
        logger.error("Error importing bales:", { error: error });
        res.status(400).json({ message: getErrorMessage(error) });
      }
    }
  );
}

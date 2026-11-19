// Extracted from ./balesImportRoutes.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { writeAuditEvent } from "../../../services/audit/auditService";
import {
  assertStockImportAllowedTx,
  RAW_STOCK_IMPORT_AUDIT,
  sendStockImportRefusal,
} from "../../../services/factory/stockImportPolicy";
import { requestRole } from "../../../services/accounting/accountHistoryPolicy";
import { createFactorySupplierTx, updateFactorySupplierTx } from "../suppliers/crud/factorySupplierWrites";
import { factoryContainers, factoryRawStock, factorySuppliers } from "@shared/schema";
import { and, eq, ilike } from "drizzle-orm";

import { validateRequest } from "../../../lib/validateRequest";
import { rawStockImportInput, supplierImportInput } from "./balesImportRoutesSchemas";

export function registerBalesImportRoutesPart1(app: Express) {
  // ───────────────────────────────────────────────
  // Factory Import API Endpoints
  // ───────────────────────────────────────────────

  app.post(
    "/api/factory/import/suppliers",
    requireAuth,
    validateRequest(supplierImportInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { suppliers: supplierList } = req.body;
        if (!Array.isArray(supplierList) || supplierList.length === 0) {
          return res.status(400).json({ message: "No suppliers provided" });
        }

        let imported = 0;
        let updated = 0;
        const errors: string[] = [];

        for (let i = 0; i < supplierList.length; i++) {
          const s = supplierList[i];
          try {
            if (!s.name || !s.name.trim()) {
              errors.push(`Row ${i + 1}: Name is required`);
              continue;
            }

            const [existing] = await db
              .select()
              .from(factorySuppliers)
              .where(and(eq(factorySuppliers.companyId, companyId), ilike(factorySuppliers.name, s.name.trim())));

            // Wave 16 (B): each row is written and audited in its own
            // transaction under the history rules (factorySupplierWrites.ts).
            const actor = {
              userId: req.session.userId!,
              username: req.session.username || "unknown",
              role: requestRole(req),
            };
            if (existing) {
              await db.transaction((tx) =>
                updateFactorySupplierTx(
                  tx,
                  companyId,
                  existing.id,
                  {
                    openingBalance: s.openingBalance || existing.openingBalance,
                    contactPerson: s.contactPerson !== undefined ? s.contactPerson : existing.contactPerson,
                    phone: s.phone !== undefined ? s.phone : existing.phone,
                    email: s.email !== undefined ? s.email : existing.email,
                  },
                  actor,
                  "import"
                )
              );
              updated++;
            } else {
              await db.transaction((tx) =>
                createFactorySupplierTx(
                  tx,
                  companyId,
                  {
                    name: s.name.trim(),
                    openingBalance: s.openingBalance ? String(s.openingBalance) : "0",
                    contactPerson: s.contactPerson || null,
                    phone: s.phone || null,
                    email: s.email || null,
                  },
                  actor
                )
              );
              imported++;
            }
          } catch (err: unknown) {
            errors.push(`Row ${i + 1}: ${getErrorMessage(err)}`);
          }
        }

        res.json({ imported, updated, errors });
      } catch (error: unknown) {
        logger.error("Error importing suppliers:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );

  // Wave 18 C (owner decision): the raw-stock and bale imports create stock
  // value from a spreadsheet with no journal. Admin/Owner only (Developer
  // passes); refused once the perpetual cut-over is applied (409
  // FACTORY_STOCK_IMPORT_AFTER_CUTOVER: stock enters through costed receipts
  // and mixes); one transaction with the audit rows in it (a failing row is
  // rolled back to its savepoint and reported, as before); the readiness
  // report lists what they brought in at the spreadsheet's cost.
  app.post(
    "/api/factory/import/raw-stock",
    requireAuth,
    requireRole("Admin", "Owner"),
    validateRequest(rawStockImportInput),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });

        const { items } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
          return res.status(400).json({ message: "No items provided" });
        }

        const result = await db.transaction(async (tx) => {
          await assertStockImportAllowedTx(tx, companyId);
          let imported = 0;
          const errors: string[] = [];

          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (!item.containerNumber || !item.containerNumber.trim()) {
              errors.push(`Row ${i + 1}: Container number is required`);
              continue;
            }
            if (!item.receivedKg) {
              errors.push(`Row ${i + 1}: Received KG is required`);
              continue;
            }
            if (!item.costPerKg) {
              errors.push(`Row ${i + 1}: Cost per KG is required`);
              continue;
            }
            try {
              await tx.transaction(async (row) => {
                let supplierId: number | null = null;
                if (item.supplierName && item.supplierName.trim()) {
                  const [supplier] = await row
                    .select()
                    .from(factorySuppliers)
                    .where(
                      and(
                        eq(factorySuppliers.companyId, companyId),
                        ilike(factorySuppliers.name, item.supplierName.trim())
                      )
                    );
                  if (supplier) {
                    supplierId = supplier.id;
                  }
                }

                let [container] = await row
                  .select()
                  .from(factoryContainers)
                  .where(
                    and(
                      eq(factoryContainers.companyId, companyId),
                      eq(factoryContainers.containerNumber, item.containerNumber.trim())
                    )
                  );

                const containerCreated = !container;
                if (!container) {
                  [container] = await row
                    .insert(factoryContainers)
                    .values({
                      companyId,
                      containerNumber: item.containerNumber.trim(),
                      supplierId,
                      totalKg: item.receivedKg,
                      ratePerKg: item.costPerKg,
                      arrivalDate: item.arrivalDate || null,
                      status: "RECEIVED",
                    })
                    .returning();
                } else if (supplierId && !container.supplierId) {
                  await row.update(factoryContainers).set({ supplierId }).where(eq(factoryContainers.id, container.id));
                }

                // The import carries no currency: the cost is in the container's
                // currency, so it is the USD cost only for a USD container. Any other
                // currency stays without a USD cost (not valued) until its rate is
                // confirmed (wave 11: never a native-currency cost as USD).
                const containerIsUsd = (container.currencyCode || "USD").toUpperCase() === "USD";
                const [rawStock] = await row
                  .insert(factoryRawStock)
                  .values({
                    companyId,
                    containerId: container.id,
                    receivedKg: item.receivedKg,
                    usedKg: item.usedKg || "0",
                    costPerKg: item.costPerKg,
                    costPerKgUsd: containerIsUsd ? String(item.costPerKg) : null,
                  })
                  .returning({ id: factoryRawStock.id });
                // One audit row per raw-stock row: it is also how the readiness
                // report finds the rows imported at spreadsheet cost.
                await writeAuditEvent(
                  {
                    userId: req.session.userId ?? "unknown",
                    username: req.session.username || "unknown",
                    companyId,
                    action: RAW_STOCK_IMPORT_AUDIT.action,
                    tableName: RAW_STOCK_IMPORT_AUDIT.tableName,
                    recordId: rawStock.id,
                    recordIdentifier: `raw-stock import: container ${container.containerNumber}`,
                    metadata: {
                      source: "factory_raw_stock_import",
                      containerId: container.id,
                      containerCreated,
                      receivedKg: String(item.receivedKg),
                      usedKg: String(item.usedKg || "0"),
                      costPerKg: String(item.costPerKg),
                      costPerKgUsd: containerIsUsd ? String(item.costPerKg) : null,
                    },
                  },
                  row
                );
              });
              imported++;
            } catch (err: unknown) {
              errors.push(`Row ${i + 1}: ${getErrorMessage(err)}`);
            }
          }
          return { imported, errors };
        });

        res.json(result);
      } catch (error: unknown) {
        if (sendStockImportRefusal(res, error)) return;
        logger.error("Error importing raw stock:", { error: error });
        res.status(500).json({ message: getErrorMessage(error) });
      }
    }
  );
}

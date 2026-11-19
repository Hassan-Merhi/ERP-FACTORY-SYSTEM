// Extracted from ./crud.ts to keep that module under the source-size cap.
import type { Express, Request, Response } from "express";
import { parseId } from "../../../../lib/parseId";
import { getErrorMessage } from "../../../../lib/httpHandlers";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import { factoryContainers, factoryRawStock, factorySuppliers } from "@shared/schema";
import { and, eq } from "drizzle-orm";
import { toMoney } from "../../../../lib/money";
import { registerRawStockOpeningBalanceRoutesPart2 } from "./registerRawStockOpeningBalanceRoutesPart2";

export function registerRawStockOpeningBalanceRoutesPart1(app: Express) {
  registerRawStockOpeningBalanceRoutesPart2(app);

  // GET a single opening-balance raw stock record
  app.get("/api/factory/raw-stock/opening-balance/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid id" });

      const [row] = await db
        .select({
          id: factoryRawStock.id,
          containerId: factoryRawStock.containerId,
          receivedKg: factoryRawStock.receivedKg,
          usedKg: factoryRawStock.usedKg,
          costPerKg: factoryRawStock.costPerKg,
          costPerKgUsd: factoryRawStock.costPerKgUsd,
          containerNumber: factoryContainers.containerNumber,
          containerStatus: factoryContainers.status,
          currencyCode: factoryContainers.currencyCode,
          fxRateToUsd: factoryContainers.fxRateToUsd,
          notes: factoryContainers.notes,
          origin: factoryContainers.origin,
          supplierId: factoryContainers.supplierId,
          supplierName: factorySuppliers.name,
        })
        .from(factoryRawStock)
        .innerJoin(factoryContainers, eq(factoryRawStock.containerId, factoryContainers.id))
        .leftJoin(factorySuppliers, eq(factoryContainers.supplierId, factorySuppliers.id))
        .where(and(eq(factoryRawStock.id, id), eq(factoryRawStock.companyId, companyId)))
        .limit(1);

      if (!row) return res.status(404).json({ message: "Raw stock record not found" });
      if (row.containerStatus !== "OPENING_BALANCE") {
        return res.status(400).json({ message: "This record is not an opening balance entry" });
      }

      res.json({ ...row, remainingKg: toMoney(row.receivedKg).minus(toMoney(row.usedKg)).toFixed(3) });
    } catch (error: unknown) {
      logger.error("Error fetching opening balance record:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

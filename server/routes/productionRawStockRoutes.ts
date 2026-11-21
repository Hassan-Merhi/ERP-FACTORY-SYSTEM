/**
 * Production raw-stock & mix-batch routes.
 *
 * Raw-stock listing/offload/available-containers and mix-batch CRUD plus
 * mix-batch source management. Extracted from baleRoutes.ts as a
 * sub-registrar; behaviour is unchanged.
 */
import type { Express } from "express";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { eq, and, desc } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { requireAuth } from "../auth";
import { productionRawStock, containers, suppliers, insertMixBatchSourceSchema } from "@shared/schema";
import { parseMoneyInput, toMoney } from "../lib/money";
import { registerProductionRawStockRoutesPart1 } from "./registerProductionRawStockRoutesPart1";

export function registerProductionRawStockRoutes(app: Express) {
  // Production Raw Stock API Routes
  app.get("/api/production-raw-stock", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const rawStockRows = await db
        .select({
          id: productionRawStock.id,
          companyId: productionRawStock.companyId,
          containerId: productionRawStock.containerId,
          receivedKg: productionRawStock.receivedKg,
          usedKg: productionRawStock.usedKg,
          costPerKg: productionRawStock.costPerKg,
          offloadedAt: productionRawStock.offloadedAt,
          containerNumber: containers.containerNumber,
          supplierId: containers.supplierId,
          supplierName: suppliers.legalName,
        })
        .from(productionRawStock)
        .leftJoin(containers, eq(productionRawStock.containerId, containers.id))
        .leftJoin(suppliers, eq(containers.supplierId, suppliers.id))
        .where(eq(productionRawStock.companyId, companyId))
        .orderBy(desc(productionRawStock.offloadedAt));

      const result = rawStockRows.map((row) => {
        const remaining = toMoney(row.receivedKg).minus(toMoney(row.usedKg));
        return {
          ...row,
          remainingKg: remaining.toFixed(3),
          valueRemaining: remaining.times(toMoney(row.costPerKg)).toFixed(2),
        };
      });

      res.json(result);
    } catch (error: unknown) {
      logger.error("Error fetching production raw stock:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/production-raw-stock/offload", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { containerId } = req.body;
      if (!containerId) {
        return res.status(400).json({ message: "Missing required field: containerId" });
      }

      const container = await storage.getContainerById(parseInt(containerId));
      if (!container || container.companyId !== companyId) {
        return res.status(404).json({ message: "Container not found" });
      }

      const finalReceivedKg = req.body.receivedKg || container.totalKg || null;
      const finalCostPerKg = req.body.costPerKg || container.ratePerKg || null;

      if (!finalReceivedKg || !parseMoneyInput(finalReceivedKg)?.greaterThan(0)) {
        return res
          .status(400)
          .json({ message: "Received weight is required. Container has no saved Total KG - please provide a value." });
      }
      if (!finalCostPerKg || !parseMoneyInput(finalCostPerKg)?.greaterThan(0)) {
        return res
          .status(400)
          .json({ message: "Cost per kg is required. Container has no saved Rate per KG - please provide a value." });
      }

      const existing = await db
        .select()
        .from(productionRawStock)
        .where(
          and(eq(productionRawStock.companyId, companyId), eq(productionRawStock.containerId, parseInt(containerId)))
        );

      if (existing.length > 0) {
        return res.status(409).json({ message: "Container already offloaded to production raw stock" });
      }

      const [record] = await db
        .insert(productionRawStock)
        .values({
          companyId,
          containerId: parseInt(containerId),
          receivedKg: finalReceivedKg.toString(),
          costPerKg: finalCostPerKg.toString(),
          usedKg: "0",
        })
        .returning();

      res.json(record);
    } catch (error: unknown) {
      logger.error("Error offloading container:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/production-raw-stock/available-containers", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const offloadedIds = await db
        .select({ containerId: productionRawStock.containerId })
        .from(productionRawStock)
        .where(eq(productionRawStock.companyId, companyId));

      const offloadedIdList = offloadedIds.map((r) => r.containerId);

      const allContainers = await db
        .select()
        .from(containers)
        .where(and(eq(containers.companyId, companyId), eq(containers.status, "AVAILABLE")));

      const available = allContainers.filter((c) => !offloadedIdList.includes(c.id));
      res.json(available);
    } catch (error: unknown) {
      logger.error("Error fetching available containers:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Mix Batches API Routes
  app.get("/api/mix-batches", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const batches = await storage.getAllMixBatches(companyId);
      res.json(batches);
    } catch (error: unknown) {
      logger.error("Error fetching mix batches:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  registerProductionRawStockRoutesPart1(app);

  app.get("/api/mix-batches/:id/sources", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const id = parseInt(req.params.id);
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid mix batch ID" });
      }

      const sources = await storage.getMixBatchSources(id, companyId);
      res.json(sources);
    } catch (error: unknown) {
      logger.error("Error fetching mix batch sources:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/mix-batches/:id/sources", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const mixBatchId = parseInt(req.params.id);
      if (isNaN(mixBatchId)) {
        return res.status(400).json({ message: "Invalid mix batch ID" });
      }

      // Verify the mix batch belongs to this company
      const batch = await storage.getMixBatchById(mixBatchId, companyId);
      if (!batch) {
        return res.status(404).json({ message: "Mix batch not found" });
      }
      const data = insertMixBatchSourceSchema.parse({
        ...req.body,
        mixBatchId,
      });

      const source = await storage.addMixBatchSource(data);
      res.json(source);
    } catch (error: unknown) {
      logger.error("Error adding mix batch source:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}

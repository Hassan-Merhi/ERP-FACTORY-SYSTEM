/**
 * supplierCrudRoutes: FactorySupplierCrud endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { parseId } from "../../../../lib/parseId";
import { errorStatus, getErrorMessage } from "../../../../lib/httpHandlers";
import { ZodError } from "zod";
import { accountHistoryErrorResponse, requestRole } from "../../../../services/accounting/accountHistoryPolicy";
import {
  FactorySupplierWriteError,
  createFactorySupplierTx,
  factorySupplierUpdateSchema,
  parseFactorySupplierOpening,
  updateFactorySupplierTx,
} from "./factorySupplierWrites";
import { logger } from "../../../../lib/logger";
import { db } from "../../../../db";
import { requireAuth } from "../../../../auth";
import {
  factorySuppliers,
  factoryContainers,
  factoryRawStock,
  factoryMixBatchSources,
  factoryContainerCommissions,
  factoryOffloadAdditionalCharges,
  factorySupplierScoreSnapshots,
  factorySupplierPayments,
  factorySupplierFxTransfers,
  factoryFxAllocations,
} from "@shared/schema";
import { eq, and, or, inArray } from "drizzle-orm";

function factorySupplierActor(req: Request) {
  return {
    userId: req.session.userId!,
    username: req.session.username || "unknown",
    role: requestRole(req),
  };
}

function sendFactorySupplierWriteError(res: Response, error: unknown, fallback: number) {
  const refused = accountHistoryErrorResponse(error);
  if (refused) return res.status(refused.status).json(refused.body);
  if (error instanceof FactorySupplierWriteError) return res.status(error.status).json({ message: error.message });
  if (error instanceof ZodError) return res.status(400).json({ message: getErrorMessage(error) });
  return res.status(errorStatus(error, fallback)).json({ message: getErrorMessage(error) });
}

export function registerFactorySupplierCrudRoutes(app: Express) {
  app.get("/api/factory/suppliers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const results = await db
        .select()
        .from(factorySuppliers)
        .where(eq(factorySuppliers.companyId, companyId))
        .orderBy(factorySuppliers.name);

      res.json(results);
    } catch (error: unknown) {
      logger.error("Error fetching factory suppliers:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/suppliers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const supplier = await db.transaction((tx) =>
        createFactorySupplierTx(tx, companyId, req.body, factorySupplierActor(req))
      );
      res.json(supplier);
    } catch (error: unknown) {
      logger.error("Error creating factory supplier:", { error: error });
      sendFactorySupplierWriteError(res, error, 400);
    }
  });

  app.patch("/api/factory/suppliers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      // Wave 16 (B): only the supplier's own editable fields, under the
      // history rules, audited in the transaction (the raw body used to be
      // written as is, any column included).
      const updates = factorySupplierUpdateSchema.parse(req.body ?? {});
      const updated = await db.transaction((tx) =>
        updateFactorySupplierTx(tx, companyId, id, updates, factorySupplierActor(req))
      );

      if (!updated) return res.status(404).json({ message: "Supplier not found" });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating factory supplier:", { error: error });
      sendFactorySupplierWriteError(res, error, 400);
    }
  });

  app.delete("/api/factory/suppliers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [updated] = await db
        .update(factorySuppliers)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)))
        .returning();

      if (!updated) return res.status(404).json({ message: "Supplier not found" });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error deleting factory supplier:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.patch("/api/factory/suppliers/:id/reactivate", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [updated] = await db
        .update(factorySuppliers)
        .set({ isActive: true, updatedAt: new Date() })
        .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Supplier not found" });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error reactivating factory supplier:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Overwrite a factory supplier's opening balance
  app.patch("/api/factory/suppliers/:id/opening-balance", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) return res.status(400).json({ message: "Invalid supplier id" });

      const { openingBalance } = req.body;
      if (openingBalance === undefined || openingBalance === null || openingBalance === "") {
        return res.status(400).json({ message: "openingBalance is required" });
      }

      const updated = await db.transaction((tx) =>
        updateFactorySupplierTx(
          tx,
          companyId,
          id,
          { openingBalance: parseFactorySupplierOpening(openingBalance) },
          factorySupplierActor(req)
        )
      );
      if (!updated) return res.status(404).json({ message: "Supplier not found" });

      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating supplier opening balance:", { error: error });
      sendFactorySupplierWriteError(res, error, 500);
    }
  });

  // Mark / unmark a supplier as broker (explicit flag, independent of whether children exist)
  app.patch("/api/factory/suppliers/:id/set-broker", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const { isBroker } = req.body;
      if (typeof isBroker !== "boolean") return res.status(400).json({ message: "isBroker must be boolean" });
      // A broker cannot itself have a parent (it IS the parent)
      if (isBroker) {
        const [sup] = await db
          .select({ parentId: factorySuppliers.parentId })
          .from(factorySuppliers)
          .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)))
          .limit(1);
        if (sup?.parentId) {
          return res.status(400).json({
            message: "A linked supplier (child) cannot be set as broker directly. Remove the parent link first.",
          });
        }
      }
      const [updated] = await db
        .update(factorySuppliers)
        .set({ isBroker, updatedAt: new Date() })
        .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)))
        .returning();
      if (!updated) return res.status(404).json({ message: "Supplier not found" });
      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error setting broker flag:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Hard-delete a factory supplier — cascades through all related records
  app.delete("/api/factory/suppliers/:id/permanent", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const id = parseId(req.params.id);

      if (id === null) return res.status(400).json({ message: "Invalid id" });
      const [supplier] = await db
        .select()
        .from(factorySuppliers)
        .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)));

      if (!supplier) return res.status(404).json({ message: "Supplier not found" });

      // 1. Collect container IDs belonging to this supplier
      const supplierContainers = await db
        .select({ id: factoryContainers.id })
        .from(factoryContainers)
        .where(and(eq(factoryContainers.companyId, companyId), eq(factoryContainers.supplierId, id)));
      const containerIds = supplierContainers.map((c) => c.id);

      // 2. Cascade-delete container-level dependents (only when containers exist)
      if (containerIds.length > 0) {
        await db.delete(factoryFxAllocations).where(inArray(factoryFxAllocations.containerId, containerIds));
        await db
          .delete(factoryOffloadAdditionalCharges)
          .where(inArray(factoryOffloadAdditionalCharges.containerId, containerIds));
        await db
          .delete(factoryContainerCommissions)
          .where(inArray(factoryContainerCommissions.containerId, containerIds));
        await db.delete(factoryMixBatchSources).where(inArray(factoryMixBatchSources.containerId, containerIds));
        await db.delete(factoryRawStock).where(inArray(factoryRawStock.containerId, containerIds));
        await db.delete(factoryContainers).where(inArray(factoryContainers.id, containerIds));
      }

      // 3. Delete supplier-level financial records
      await db
        .delete(factorySupplierFxTransfers)
        .where(
          and(
            eq(factorySupplierFxTransfers.companyId, companyId),
            or(eq(factorySupplierFxTransfers.fromSupplierId, id), eq(factorySupplierFxTransfers.toSupplierId, id))
          )
        );
      await db
        .delete(factorySupplierPayments)
        .where(and(eq(factorySupplierPayments.companyId, companyId), eq(factorySupplierPayments.supplierId, id)));
      await db
        .delete(factorySupplierScoreSnapshots)
        .where(
          and(eq(factorySupplierScoreSnapshots.companyId, companyId), eq(factorySupplierScoreSnapshots.supplierId, id))
        );

      // 4. Finally delete the supplier itself
      await db
        .delete(factorySuppliers)
        .where(and(eq(factorySuppliers.id, id), eq(factorySuppliers.companyId, companyId)));

      res.json({ message: "Supplier permanently deleted" });
    } catch (error: unknown) {
      logger.error("Error permanently deleting factory supplier:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ───────────────────────────────────────────────
  // 1b. Factory Supplier Categories
  // ───────────────────────────────────────────────
}

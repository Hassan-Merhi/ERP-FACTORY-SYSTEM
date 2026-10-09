import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../../services/accounting/infrastructureVoucherIdentity";
import { systemAccountDefinition } from "../../services/accounting/systemAccounts";
import { moneyString, toMoney } from "../../lib/money";
import { parseId } from "../../lib/parseId";
import { getErrorMessage } from "../../lib/httpHandlers";
import { getClientDate } from "../../lib/dateUtils";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireRole, requireNonPOS } from "../../auth";
import { logAudit } from "../_helpers";
import { logger } from "../../lib/logger";
import {
  stockItems,
  containers,
  containerOffloads,
  insertContainerSchema,
  purchaseOrders,
  poLineItems,
  stockGrades,
  stockCategories,
  suppliers,
  ledgerAccounts,
  voucherEntries,
} from "@shared/schema";
import { eq, and, sql } from "drizzle-orm";
import { requireNonSP } from "./containerHelpers";

export function registerContainerCrudRoutes(app: Express) {
  app.get("/api/containers", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const containers = await storage.getAllContainers(req.session.currentCompanyId);
      res.json(containers);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get active containers (not sold)
  app.get("/api/containers/active", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const containers = await storage.getActiveContainers(req.session.currentCompanyId);
      res.json(containers);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get sold containers with full details
  app.get("/api/containers/sold", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const soldContainers = await storage.getSoldContainers(req.session.currentCompanyId);
      res.json(soldContainers);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Update container tracking fields (OTW tracking)

  app.post("/api/containers", requireAuth, requireNonPOS, requireNonSP, async (req, res) => {
    const _t = Date.now();
    const _uid = req.session.userId;
    const _cid = req.session.currentCompanyId;
    try {
      logger.info("container create started", {
        module: "containers",
        action: "create",
        userId: _uid,
        companyId: _cid,
      });
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      if (req.body.companyId !== undefined && Number(req.body.companyId) !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Container belongs to a different company",
        });
      }

      const data = insertContainerSchema.parse({
        ...req.body,
        companyId: req.session.currentCompanyId,
      });
      if (data.supplierId !== undefined && data.supplierId !== null) {
        const supplier = await storage.getSupplierById(data.supplierId, req.session.currentCompanyId);
        if (!supplier) {
          return res.status(403).json({
            message: "Access denied: Supplier belongs to a different company",
          });
        }
      }

      // Extract manual container cost data from request body (not in base schema)
      const itemName = req.body.itemName?.trim();
      const ratePerKg = req.body.ratePerKg ? parseFloat(req.body.ratePerKg) : 0;
      const totalKg = req.body.totalKg ? parseFloat(req.body.totalKg) : 0;
      const hasManualCostData = itemName && ratePerKg > 0 && totalKg > 0;

      // Validate supplier required for manual containers with cost data
      if (hasManualCostData && !data.supplierId) {
        return res.status(400).json({
          message: "Supplier is required for manual containers with cost information",
        });
      }

      // The container, its purchase voucher and both lines commit together. They
      // used to be separate autocommit writes; a failure deleted the container but
      // could leave a voucher header or a one-sided debit line behind.
      const companyId = req.session.currentCompanyId;
      const container = await db.transaction(async (tx) => {
        const [container] = await tx.insert(containers).values(data).returning();
        if (!hasManualCostData) return container;

        const totalAmount = moneyString(toMoney(req.body.ratePerKg).times(toMoney(req.body.totalKg)));
        const voucherDate = data.importDate || getClientDate(req);

        // Get or create the PURCHASES ledger account, in the same transaction.
        await tx
          .insert(ledgerAccounts)
          .values({
            companyId,
            code: "PURCHASES",
            name: "Purchases",
            accountType: systemAccountDefinition("PURCHASES")?.accountType ?? "Expense",
            openingBalance: "0",
            openingBalanceSide: "Dr",
            active: true,
          })
          .onConflictDoNothing();
        const [purchasesAccount] = await tx
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, "PURCHASES")))
          .limit(1);

        const { voucher } = await insertInfrastructureVoucherTx(
          tx,
          {
            companyId,
            currency: "USD",
            voucherNumber: `CONT-${container.containerNumber}-${Date.now()}`,
            voucherType: "Purchase",
            voucherDate: voucherDate,
            description: `Container ${container.containerNumber} - ${itemName}`,
            totalAmount,
            optional: false,
            sourceModule: "ERP",
          },
          infrastructurePostingIdentity("manual-container", `${companyId}:${container.id}`, "purchase")
        );

        const narration = `Container ${container.containerNumber} - ${itemName} (${totalKg}kg @ $${ratePerKg}/kg)`;
        await tx.insert(voucherEntries).values([
          // Debit: Purchases account (Expense increases)
          {
            voucherId: voucher.id,
            ledgerAccountId: purchasesAccount.id,
            debitAmount: totalAmount,
            creditAmount: "0",
            narration,
          },
          // Credit: Supplier account (Accounts Payable increases)
          {
            voucherId: voucher.id,
            supplierId: data.supplierId,
            debitAmount: "0",
            creditAmount: totalAmount,
            narration,
          },
        ]);
        return container;
      });

      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "create",
          tableName: "containers",
          recordId: container.id,
          recordIdentifier: container.containerNumber || `Container #${container.id}`,
          changes: {
            containerNumber: { new: container.containerNumber },
            status: { new: container.status },
            importDate: { new: container.importDate },
            supplierId: { new: container.supplierId },
          },
        });
      } catch {
        /* non-fatal */
      }
      logger.info("container create succeeded", {
        module: "containers",
        action: "create",
        userId: _uid,
        companyId: _cid,
        containerId: container.id,
        durationMs: Date.now() - _t,
      });
      res.status(201).json(container);
    } catch (error: unknown) {
      logger.error("container create failed", {
        module: "containers",
        action: "create",
        userId: _uid,
        companyId: _cid,
        durationMs: Date.now() - _t,
        error,
      });
      if ((error as { name?: string }).name === "ZodError") {
        return res.status(400).json({
          message: "Validation error",
          errors: (error as { errors?: unknown }).errors,
        });
      }
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Bulk OTW line-items (replaces N individual /api/containers/:id fan-out) ─
  // MUST be registered BEFORE the /:id route to avoid being swallowed by it.
  app.get("/api/containers/otw-items", requireAuth, requireNonPOS, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }
      const companyId = req.session.currentCompanyId;

      const rows = await db
        .select({
          stockItemCode: stockItems.code,
          stockItemName: sql<string>`COALESCE(
            CASE WHEN ${stockItems.deletedAt} IS NULL THEN ${stockItems.name} ELSE NULL END,
            ${poLineItems.itemName}
          )`,
          quantity: poLineItems.quantity,
          totalCost: poLineItems.lineTotal,
          rate: poLineItems.rate,
          containerNumber: containers.containerNumber,
          supplierId: containers.supplierId,
          supplierName: sql<string>`COALESCE(${suppliers.legalName}, 'Unknown')`,
          importDate: containers.importDate,
          gradeId: stockItems.gradeId,
          gradeName: stockGrades.name,
          categoryId: stockItems.categoryId,
          categoryName: stockCategories.name,
        })
        .from(containers)
        .innerJoin(purchaseOrders, eq(purchaseOrders.containerId, containers.id))
        .innerJoin(poLineItems, eq(poLineItems.poId, purchaseOrders.id))
        .leftJoin(stockItems, eq(stockItems.id, poLineItems.stockItemId))
        .leftJoin(stockGrades, eq(stockGrades.id, stockItems.gradeId))
        .leftJoin(stockCategories, eq(stockCategories.id, stockItems.categoryId))
        .leftJoin(suppliers, eq(suppliers.id, containers.supplierId))
        .where(and(eq(containers.companyId, companyId), eq(containers.status, "OTW")));

      res.json(rows);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Get container details with POs, line items, and charges
  app.get("/api/containers/:id", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const containerId = parseId(req.params.id);
      if (containerId === null) return res.status(400).json({ message: "Invalid id" });
      const container = await storage.getContainerByIdForCompany(containerId, req.session.currentCompanyId!);

      if (!container) {
        return res.status(404).json({ message: "Container not found" });
      }

      const pos = await storage.getPurchaseOrdersByContainerForCompany(containerId, req.session.currentCompanyId!);
      const charges = await storage.getChargesByContainer(containerId);

      // Get line items for all POs
      const allLineItems = await Promise.all(pos.map((po) => storage.getLineItemsByPO(po.id)));

      const posWithItems = pos.map((po, index) => ({
        ...po,
        items: allLineItems[index],
      }));

      // Fetch offload ID so the frontend can link to the offload detail page
      let offloadId: number | null = null;
      if (container.status === "OFFLOADED") {
        const [offloadRow] = await db
          .select({ id: containerOffloads.id })
          .from(containerOffloads)
          .where(eq(containerOffloads.containerId, containerId))
          .limit(1);
        offloadId = offloadRow?.id ?? null;
      }

      res.json({
        container,
        pos: posWithItems,
        charges,
        offloadId,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Offload container to location (ERP only — SP companies must use /api/sp/offload)

  app.delete("/api/containers/:id", requireAuth, requireRole("Admin"), async (req, res) => {
    try {
      const id = parseId(req.params.id);
      if (id === null) return res.status(400).json({ message: "Invalid id" });
      if (isNaN(id)) {
        return res.status(400).json({ message: "Invalid container ID" });
      }

      const existingContainer = await storage.getContainerById(id);
      if (!existingContainer) {
        return res.status(404).json({ message: "Container not found" });
      }

      // Verify container belongs to current company
      if (existingContainer.companyId !== req.session.currentCompanyId) {
        return res.status(403).json({
          message: "Access denied: Container belongs to a different company",
        });
      }

      await storage.deleteContainer(id, {
        userId: req.session.userId ?? "unknown",
        username: req.session.username || "unknown",
      });
      try {
        await logAudit({
          userId: req.session.userId!,
          username: req.session.username || "unknown",
          companyId: req.session.currentCompanyId!,
          action: "delete",
          tableName: "containers",
          recordId: existingContainer.id,
          recordIdentifier: existingContainer.containerNumber || `Container #${id}`,
          changes: {
            containerNumber: { old: existingContainer.containerNumber },
            status: { old: existingContainer.status },
            importDate: { old: existingContainer.importDate },
          },
        });
      } catch {
        /* non-fatal */
      }
      res.json({ message: "Container deleted successfully" });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // Backfill voucher entries for existing POs
}

// Extracted from ./containerCrudRoutes.ts
import { postFactoryVoucherTx } from "../../services/factory/factoryVoucherPosting";
import { systemAccountDefinition } from "../../services/accounting/systemAccounts";
import { moneyString, parseMoneyInput, toMoney } from "../../lib/money";
import { getErrorMessage } from "../../lib/httpHandlers";
import { getClientDate } from "../../lib/dateUtils";
import type { Express } from "express";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth, requireNonPOS } from "../../auth";
import { logAudit } from "../_helpers";
import { logger } from "../../lib/logger";
import { containers, insertContainerSchema, ledgerAccounts } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import { requireNonSP } from "./containerHelpers";
import { z } from "zod";
import { emptyQuery, validateRequest, type RequestSchemas } from "../../lib/validateRequest";

// The handler parses the body with insertContainerSchema itself (companyId is
// replaced by the session's company after a mismatch check on Number(companyId)).
const createContainerInput = {
  query: emptyQuery,
  body: insertContainerSchema.extend({ companyId: z.union([z.number(), z.string()]).nullable().optional() }).strict(),
} satisfies RequestSchemas;

export function registerContainerCrudRoutesPart1(app: Express) {
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

  app.post(
    "/api/containers",
    requireAuth,
    requireNonPOS,
    requireNonSP,
    validateRequest(createContainerInput),
    async (req, res) => {
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
        const ratePerKg = req.body.ratePerKg ? (parseMoneyInput(req.body.ratePerKg)?.toNumber() ?? NaN) : 0;
        const totalKg = req.body.totalKg ? (parseMoneyInput(req.body.totalKg)?.toNumber() ?? NaN) : 0;
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
          // Phase 21 (B): the create audit commits with the container.
          await logAudit(
            {
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
            },
            tx
          );
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

          // Phase 22 (C): through the engine, engine-numbered (was
          // CONT-{container}-{Date.now()}, read nowhere), same posting identity.
          // Dr Purchases (expense) / Cr the supplier (payable).
          const narration = `Container ${container.containerNumber} - ${itemName} (${totalKg}kg @ $${ratePerKg}/kg)`;
          await postFactoryVoucherTx(tx, {
            companyId,
            voucherType: "Purchase",
            voucherDate: voucherDate,
            description: `Container ${container.containerNumber} - ${itemName}`,
            sourceModule: "ERP",
            source: { sourceType: "manual-container", sourceId: `${companyId}:${container.id}`, phase: "purchase" },
            lines: [
              { ledgerAccountId: purchasesAccount.id, debit: totalAmount, narration },
              { supplierId: data.supplierId, credit: totalAmount, narration },
            ],
          });
          return container;
        });

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
    }
  );
}

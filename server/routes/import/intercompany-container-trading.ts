import type { Express } from "express";
import { z } from "zod";
import { and, eq, or } from "drizzle-orm";
import { requireAuth, requireRole } from "../../auth";
import { db } from "../../db";
import { logger } from "../../lib/logger";
import { containers, intercompanyTrades, intercompanyImportBatchContainers } from "@shared/schema";
import { upload } from "../_helpers";
import { autoProvisionTradingRelationship } from "../../services/intercompany/tradingAccountProvisioning";
import {
  getTradingSetup,
  importInputSchema,
  parseIntercompanyWorkbook,
  postIntercompanyImport,
  relationshipInputSchema,
  setTradingRelationship,
  TradingImportError,
} from "../../services/intercompany/containerTradingImport";

function sendError(res: import("express").Response, error: unknown) {
  if (error instanceof TradingImportError) {
    return res.status(error.status).json({ code: error.code, message: error.message });
  }
  if (error instanceof z.ZodError) {
    return res
      .status(400)
      .json({ code: "INTERCOMPANY_INVALID_INPUT", message: error.issues.map((i) => i.message).join("; ") });
  }
  logger.error("Intercompany container trading error", { error });
  return res.status(500).json({
    code: "INTERCOMPANY_INTERNAL_ERROR",
    message: "Container trading could not be completed. No partial import was committed.",
  });
}

function companyFromSession(req: import("express").Request) {
  const companyId = Number(req.session.currentCompanyId);
  const userId = req.session.userId;
  const role = req.session.currentRole ?? "";
  if (!Number.isSafeInteger(companyId) || companyId <= 0 || !userId) {
    throw new TradingImportError(403, "Choose the Properties company and sign in first");
  }
  return { companyId, userId, role };
}

export function registerIntercompanyContainerTradingRoutes(app: Express) {
  // These endpoints deliberately do not modify the legacy /api/po-import path.
  app.get(
    "/api/intercompany-container-trading/setup",
    requireAuth,
    requireRole("Owner", "Developer"),
    async (req, res) => {
      try {
        const { companyId, userId, role } = companyFromSession(req);
        return res.json(await getTradingSetup(companyId, userId, role));
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  // An Owner/Developer must explicitly select company-scoped accounts and the
  // destination's Hassan Properties supplier before trading can be enabled.
  app.post(
    "/api/intercompany-container-trading/relationships",
    requireAuth,
    requireRole("Owner", "Developer"),
    async (req, res) => {
      try {
        const { companyId, userId, role } = companyFromSession(req);
        const mapping = relationshipInputSchema.parse(req.body);
        const saved = await setTradingRelationship(companyId, userId, role, mapping);
        return res.status(201).json({
          relationshipId: saved.id,
          destinationCompanyId: saved.destinationCompanyId,
          tradeEnabled: saved.tradeEnabled,
        });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  // One-click, company-scoped setup: provision only missing master data and
  // verified mappings. No historical balances, vouchers, or cash are changed.
  app.post(
    "/api/intercompany-container-trading/relationships/auto",
    requireAuth,
    requireRole("Owner", "Developer"),
    async (req, res) => {
      try {
        const { companyId, userId, role } = companyFromSession(req);
        const { destinationCompanyId } = z
          .object({ destinationCompanyId: z.number().int().positive() })
          .parse(req.body);
        const configured = await autoProvisionTradingRelationship({
          sourceCompanyId: companyId,
          destinationCompanyId,
          userId,
          username: req.session.username || "unknown",
          role,
        });
        return res.status(configured.status === "configured" ? 201 : 200).json(configured);
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  // Previews use actual workbook bytes, not an untrusted browser-supplied JSON
  // representation. Confirmation uploads the SAME file and re-parses it.
  app.post(
    "/api/intercompany-container-trading/preview",
    requireAuth,
    requireRole("Owner", "Developer"),
    upload.single("file"),
    async (req, res) => {
      try {
        const { companyId, userId, role } = companyFromSession(req);
        await getTradingSetup(companyId, userId, role);
        if (!req.file) throw new TradingImportError(400, "Select an Excel workbook");
        const parsed = await parseIntercompanyWorkbook(req.file.buffer, req.file.originalname, companyId);
        return res.json({
          fileName: parsed.fileName,
          sha256: parsed.sha256,
          rowCount: parsed.rowCount,
          containers: parsed.containers,
        });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.post(
    "/api/intercompany-container-trading/import",
    requireAuth,
    requireRole("Owner", "Developer"),
    upload.single("file"),
    async (req, res) => {
      try {
        const { companyId, userId, role } = companyFromSession(req);
        if (!req.file) throw new TradingImportError(400, "Select the original Excel workbook");
        let selections: unknown;
        try {
          selections = JSON.parse(String(req.body.selections ?? "null"));
        } catch {
          throw new TradingImportError(400, "Invalid container destination selections");
        }
        const input = importInputSchema.parse({
          externalSupplierId: Number(req.body.externalSupplierId),
          importDate: req.body.importDate,
          selections,
        });
        const parsed = await parseIntercompanyWorkbook(req.file.buffer, req.file.originalname, companyId);
        // Hash comes from the fresh upload, not from a browser request field.
        return res.status(201).json(
          await postIntercompanyImport({
            sourceCompanyId: companyId,
            userId,
            username: req.session.username || "unknown",
            role,
            preview: parsed,
            input,
          })
        );
      } catch (error) {
        return sendError(res, error);
      }
    }
  );

  app.get(
    "/api/intercompany-container-trading/trades",
    requireAuth,
    requireRole("Owner", "Developer"),
    async (req, res) => {
      try {
        const { companyId, userId, role } = companyFromSession(req);
        await getTradingSetup(companyId, userId, role);
        const trades = await db
          .select({
            id: intercompanyTrades.id,
            containerNumber: containers.containerNumber,
            sourceCompanyId: intercompanyTrades.sourceCompanyId,
            destinationCompanyId: intercompanyTrades.destinationCompanyId,
            sourcePoId: intercompanyTrades.originalSupplierPoId,
            destinationPoId: intercompanyTrades.destinationPoId,
            status: intercompanyTrades.state,
            confirmedLandedCost: intercompanyImportBatchContainers.confirmedLandedCost,
          })
          .from(intercompanyTrades)
          .innerJoin(containers, eq(containers.id, intercompanyTrades.physicalContainerId))
          .leftJoin(
            intercompanyImportBatchContainers,
            eq(intercompanyImportBatchContainers.tradeId, intercompanyTrades.id)
          )
          .where(
            and(
              eq(intercompanyTrades.sourceCompanyId, companyId),
              or(eq(intercompanyTrades.state, "active"), eq(intercompanyTrades.state, "pending"))
            )
          )
          .limit(250);
        return res.json({ trades });
      } catch (error) {
        return sendError(res, error);
      }
    }
  );
}

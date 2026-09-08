import { type Express } from "express";
import { z } from "zod";
import { requireAuth } from "../../auth";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  applyPosItemReplacements,
  listPosItemReplacementCandidates,
} from "../../services/pos/itemReplacementService";
import { classifyGoldenCoastPosConfigurationError } from "../../services/pos/goldenCoastPosConfigurationError";

const candidateQuerySchema = z.object({
  locationId: z.coerce.number().int().positive(),
  stockItemId: z.coerce.number().int().positive(),
  from: z.string().optional(),
  to: z.string().optional(),
});

const replacementSchema = z.object({
  saleItemId: z.coerce.number().int().positive(),
  replacementStockItemId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().positive().finite(),
});

const bulkReplacementSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  replacements: z.array(replacementSchema).min(1).max(100),
});

function ensureErpCorrectionAccess(req: any, res: any): boolean {
  if (req.user?.role === "POS") {
    res.status(403).json({ message: "POS item replacement is available from ERP only" });
    return false;
  }
  return true;
}

export function registerPosItemReplacementRoutes(app: Express): void {
  app.get("/api/pos/item-replacements/candidates", requireAuth, async (req, res) => {
    if (!ensureErpCorrectionAccess(req, res)) return;
    if (!req.session.currentCompanyId) {
      return res.status(400).json({ message: "No company selected" });
    }

    const parsed = candidateQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid filters" });
    }

    try {
      const rows = await listPosItemReplacementCandidates({
        companyId: req.session.currentCompanyId,
        ...parsed.data,
      });
      return res.json({ rows, count: rows.length, capped: rows.length >= 500 });
    } catch (error: unknown) {
      logger.error("POS item replacement candidate lookup failed", {
        module: "pos",
        action: "itemReplacementCandidates",
        companyId: req.session.currentCompanyId,
        userId: req.session.userId,
        error,
      });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pos/item-replacements", requireAuth, async (req, res) => {
    if (!ensureErpCorrectionAccess(req, res)) return;
    if (!req.session.currentCompanyId || !req.session.userId) {
      return res.status(400).json({ message: "No company selected" });
    }

    const parsed = bulkReplacementSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid replacement request" });
    }

    try {
      const result = await applyPosItemReplacements(
        {
          companyId: req.session.currentCompanyId,
          locationId: parsed.data.locationId,
          userId: req.session.userId,
          username: req.session.username || "unknown",
          userRole: req.user?.role,
          canSellNegativeStock: req.user?.canSellNegativeStock || false,
        },
        parsed.data.replacements
      );
      return res.status(result.status).json(result.body);
    } catch (error: unknown) {
      logger.error("POS item replacement failed", {
        module: "pos",
        action: "itemReplacement",
        companyId: req.session.currentCompanyId,
        userId: req.session.userId,
        error,
      });

      const configurationError = classifyGoldenCoastPosConfigurationError(error);
      if (configurationError) {
        return res.status(configurationError.status).json(configurationError.body);
      }

      const message = getErrorMessage(error);
      if (message.includes("Insufficient stock") || message.includes("Not enough stock")) {
        return res.status(400).json({ message });
      }
      if (message.includes("Voucher not found") || message.includes("Inventory not found")) {
        return res.status(404).json({ message });
      }
      return res.status(500).json({ message });
    }
  });
}

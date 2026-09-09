import { type Express } from "express";
import { z } from "zod";
import { requireAuth } from "../../auth";
import { pool } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { storage } from "../../storage";
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

const lastSoldPriceQuerySchema = z.object({
  locationId: z.coerce.number().int().positive(),
  stockItemId: z.coerce.number().int().positive(),
});

const replacementSchema = z.object({
  saleItemId: z.coerce.number().int().positive(),
  replacementStockItemId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().positive().finite(),
});

const bulkReplacementSchema = z.object({
  locationId: z.coerce.number().int().positive(),
  replacements: z.array(replacementSchema).min(1).max(500),
});

async function ensureErpCorrectionAccess(req: any, res: any): Promise<boolean> {
  const role = req.session?.currentRole ?? req.user?.role;
  if (role === "POS") {
    res.status(403).json({ message: "POS item replacement is available from ERP only" });
    return false;
  }

  const companyId = req.session?.currentCompanyId;
  const userId = req.session?.userId;
  if (!companyId || !userId) {
    res.status(400).json({ message: "No company selected" });
    return false;
  }

  // Mirror /api/my-erp-pages: Admin/Developer have full ERP access, while
  // every other ERP role must explicitly have the POS feature assigned.
  if (role === "Admin" || role === "Developer") return true;
  const pageKeys = await storage.getErpUserPageAccess(companyId, userId);
  if (!pageKeys.includes("pos")) {
    res.status(403).json({ message: "You do not have access to POS item replacement" });
    return false;
  }
  return true;
}

export function registerPosItemReplacementRoutes(app: Express): void {
  app.get("/api/pos/item-replacements/candidates", requireAuth, async (req, res) => {
    try {
      if (!(await ensureErpCorrectionAccess(req, res))) return;
      const parsed = candidateQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid filters" });
      }

      const rows = await listPosItemReplacementCandidates({
        companyId: req.session.currentCompanyId!,
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

  app.get("/api/pos/item-replacements/last-sold-price", requireAuth, async (req, res) => {
    try {
      if (!(await ensureErpCorrectionAccess(req, res))) return;
      const parsed = lastSoldPriceQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid filters" });
      }

      const companyId = req.session.currentCompanyId!;
      const { locationId, stockItemId } = parsed.data;
      const location = await storage.getLocationById(locationId);
      if (!location || location.companyId !== companyId) {
        return res.status(403).json({ message: "Access denied: Invalid location" });
      }

      const result = await pool.query<{ selling_price: string }>(
        `SELECT si.selling_price
           FROM sales_items si
           INNER JOIN vouchers v ON si.voucher_id = v.id
          WHERE v.company_id = $1
            AND v.location_id = $2
            AND v.voucher_type = 'Sales'
            AND v.deleted_at IS NULL
            AND si.stock_item_id = $3
            AND COALESCE(si.quantity, 0) > 0
          ORDER BY v.voucher_date DESC, v.id DESC, si.created_at DESC, si.id DESC
          LIMIT 1`,
        [companyId, locationId, stockItemId]
      );

      res.setHeader("Cache-Control", "private, no-cache");
      return res.json({ sellingPrice: result.rows[0]?.selling_price ?? null });
    } catch (error: unknown) {
      logger.error("POS item replacement last-sold-price lookup failed", {
        module: "pos",
        action: "itemReplacementLastSoldPrice",
        companyId: req.session.currentCompanyId,
        userId: req.session.userId,
        error,
      });
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/pos/item-replacements", requireAuth, async (req, res) => {
    try {
      if (!(await ensureErpCorrectionAccess(req, res))) return;

      const parsed = bulkReplacementSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ message: parsed.error.issues[0]?.message || "Invalid replacement request" });
      }

      const result = await applyPosItemReplacements(
        {
          companyId: req.session.currentCompanyId!,
          locationId: parsed.data.locationId,
          userId: req.session.userId!,
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

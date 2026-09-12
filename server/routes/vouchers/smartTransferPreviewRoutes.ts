import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { z } from "zod";
import { requireAuth, requireNonPOS } from "../../auth";
import { buildSmartTransferTargetBalancedPreview } from "../../services/smartTransferTargetMix";
import {
  createSmartTransferPreviewFeedback,
  getSmartTransferFeedbackSummary,
  recordSmartTransferImportFeedback,
  resetSmartTransferFeedback,
} from "../../services/smartTransferFeedback";

const smartTransferPreviewSchema = z.object({
  destinationLocationId: z.coerce.number().int().positive(),
  sourceLocationIds: z.array(z.coerce.number().int().positive()).min(1).max(30),
  // 0 = auto-compute from demand, then optimize sources and assortment rules.
  targetQuantity: z.coerce.number().int().nonnegative().max(1_000_000).optional().default(0),
  includeOtw: z.boolean().optional().default(true),
  stockGroupIds: z.array(z.coerce.number().int().positive()).max(100).optional().default([]),
  categoryIds: z.array(z.coerce.number().int().positive()).max(100).optional().default([]),
  targetCoverageDays: z.coerce.number().int().min(1).max(180).optional().default(21),
  maxItemSharePct: z.coerce.number().int().min(5).max(100).optional().default(30),
  maxCategorySharePct: z.coerce.number().int().min(10).max(100).optional().default(65),
  maxStockGroupSharePct: z.coerce.number().int().min(10).max(100).optional().default(55),
  // 0 = automatic minimum based on requested transfer size.
  minItemQuantity: z.coerce.number().int().nonnegative().max(10_000).optional().default(0),
  preserveDestinationMix: z.boolean().optional().default(true),
  priorityCategoryIds: z.array(z.coerce.number().int().positive()).max(100).optional().default([]),
  priorityStockGroupIds: z.array(z.coerce.number().int().positive()).max(100).optional().default([]),
  asOfDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, "asOfDate must use YYYY-MM-DD")
    .optional(),
});

const feedbackItemSchema = z.object({
  stockItemId: z.coerce.number().int().positive(),
  sourceLocationId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().positive().max(1_000_000),
  stockItemName: z.string().max(300).optional(),
  sourceLocationName: z.string().max(300).optional(),
});

const importFeedbackSchema = z.object({
  destinationLocationId: z.coerce.number().int().positive(),
  sourceLocationIds: z.array(z.coerce.number().int().positive()).min(1).max(30),
  items: z.array(feedbackItemSchema).min(1).max(2_000),
  feedbackSessionId: z.string().max(120).optional().nullable(),
});

export type SmartTransferPreviewRequest = z.infer<typeof smartTransferPreviewSchema>;

export function registerSmartTransferPreviewRoutes(app: Express) {
  /**
   * Read-only preview endpoint. It does not create a voucher, reserve stock,
   * move inventory or post accounting entries.
   */
  app.post("/api/stock-transfers/smart-preview", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const userId = req.session.userId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!userId) return res.status(401).json({ message: "Unauthorized" });

      const parsed = smartTransferPreviewSchema.parse(req.body);
      const preview = await buildSmartTransferTargetBalancedPreview(
        companyId,
        parsed.sourceLocationIds,
        parsed.destinationLocationId,
        parsed.targetQuantity,
        {
          asOfDate: parsed.asOfDate,
          includeOtw: parsed.includeOtw,
          stockGroupIds: parsed.stockGroupIds,
          categoryIds: parsed.categoryIds,
          targetCoverageDays: parsed.targetCoverageDays,
          maxItemSharePct: parsed.maxItemSharePct,
          maxCategorySharePct: parsed.maxCategorySharePct,
          maxStockGroupSharePct: parsed.maxStockGroupSharePct,
          minItemQuantity: parsed.minItemQuantity,
          preserveDestinationMix: parsed.preserveDestinationMix,
          priorityCategoryIds: parsed.priorityCategoryIds,
          priorityStockGroupIds: parsed.priorityStockGroupIds,
        }
      );

      const responsePreview = parsed.targetQuantity > 0 && preview.lines.length === 0
        ? {
            ...preview,
            targetQuantity: parsed.targetQuantity,
            achievedQuantity: 0,
            shortfallQuantity: parsed.targetQuantity,
            shortfall: true,
            summary: `No eligible smart-transfer items qualified for the manually requested target of ${parsed.targetQuantity} unit(s).`,
          }
        : preview;

      const feedbackSessionId = await createSmartTransferPreviewFeedback({
        companyId,
        userId,
        requestInput: parsed,
        preview: (responsePreview),
      });

      res.set("Cache-Control", "no-store");
      return res.json({ ...responsePreview, feedbackSessionId });
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid smart transfer preview request",
          errors: error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        });
      }

      const message = String(getErrorMessage(error) || "");
      const isInputError =
        /valid company|required|positive whole number|source location|destination location|YYYY-MM-DD|not found/i.test(message);
      if (isInputError) return res.status(400).json({ message });

      logger.error("[SmartTransferPreview] Failed:", { error: error });
      return res.status(500).json({ message: "Failed to generate smart transfer preview" });
    }
  });

  /** Records the editable preview at the moment it is imported into the order editor. */
  app.post("/api/stock-transfers/smart-feedback/import", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const userId = req.session.userId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      const parsed = importFeedbackSchema.parse(req.body);
      const result = await recordSmartTransferImportFeedback({
        companyId,
        userId,
        destinationLocationId: parsed.destinationLocationId,
        sourceLocationIds: parsed.sourceLocationIds,
        importedItems: parsed.items,
        sessionId: parsed.feedbackSessionId,
      });
      return res.json(result);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({
          message: "Invalid smart transfer feedback payload",
          errors: error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
        });
      }
      logger.error("[SmartTransferFeedback] Import feedback failed:", { error: error });
      return res.status(500).json({ message: "Failed to record smart transfer feedback" });
    }
  });

  /** Returns observe-only adoption, edit and post-transfer accuracy indicators. */
  app.get("/api/stock-transfers/smart-feedback/summary", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const days = z.coerce.number().int().min(7).max(365).optional().default(90).parse(req.query.days);
      const summary = await getSmartTransferFeedbackSummary(companyId, days);
      res.set("Cache-Control", "no-store");
      return res.json(summary);
    } catch (error: unknown) {
      if (error instanceof z.ZodError) return res.status(400).json({ message: "days must be between 7 and 365" });
      logger.error("[SmartTransferFeedback] Summary failed:", { error: error });
      return res.status(500).json({ message: "Failed to load smart transfer feedback summary" });
    }
  });

  /** Starts a new reporting baseline without deleting the immutable audit history. */
  app.post("/api/stock-transfers/smart-feedback/reset", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const userId = req.session.userId;
      const role = req.session.currentRole;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (!userId) return res.status(401).json({ message: "Unauthorized" });
      if (!["Admin", "Owner", "Developer"].includes(role || "")) {
        return res.status(403).json({ message: "Only admins can reset the smart transfer feedback baseline" });
      }
      const resetSessionId = await resetSmartTransferFeedback({ companyId, userId });
      return res.json({ success: true, resetSessionId });
    } catch (error) {
      logger.error("[SmartTransferFeedback] Reset failed:", { error: error });
      return res.status(500).json({ message: "Failed to reset smart transfer feedback baseline" });
    }
  });
}

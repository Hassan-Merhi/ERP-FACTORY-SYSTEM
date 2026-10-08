import type { Express, NextFunction, Request, Response } from "express";
import { sendBaleMirrorMovementRefusal } from "../../services/accounting/perpetualInventory/cutoverRefusal";
import { logger } from "../../lib/logger";
import { z } from "zod";
import { requireAuth, requireNonPOS } from "../../auth";
import { requireActionAccess } from "../../lib/permissionMiddleware";
import { db } from "../../db";
import { stockTransferVouchers, vouchers } from "@shared/schema";
import { eq } from "drizzle-orm";
import {
  finalizeOptionalStockTransfer,
  finalizeStockTransferByTransferId,
  reopenStockTransferAsDraft,
  saveStockTransferLifecycle,
  type StockTransferLifecycleItem,
} from "../../services/stockTransferLifecycle";

const lifecycleItemSchema = z.object({
  stockItemId: z.coerce.number().int().positive(),
  sourceLocationId: z.coerce.number().int().positive(),
  quantity: z.coerce.number().positive(),
  rate: z.coerce.number().nonnegative().default(0),
});

const putSchema = z.object({
  destinationLocationId: z.coerce.number().int().positive(),
  notes: z.string().optional().default(""),
  items: z.array(lifecycleItemSchema).min(1),
});

const transferPatchSchema = z.object({
  voucherDate: z.string().optional(),
  description: z.string().optional().default(""),
  sourceLocationId: z.coerce.number().int().positive().optional(),
  destinationLocationId: z.coerce.number().int().positive(),
  items: z
    .array(
      z.object({
        stockItemId: z.coerce.number().int().positive(),
        sourceLocationId: z.coerce.number().int().positive().optional(),
        quantity: z.coerce.number().positive(),
        rate: z.coerce.number().nonnegative().default(0),
      })
    )
    .min(1),
});

function errorStatus(error: unknown): number {
  const code = String((error as { code: unknown })?.code ?? "");
  const message = String((error as { message: unknown })?.message ?? "");
  if (code === "STOCK_TRANSFER_INSUFFICIENT_STOCK" || /insufficient stock/i.test(message)) return 409;
  if (/belong.*different company/i.test(message)) return 403;
  if (/required|positive|different|missing|deleted|not found|not a stock transfer|inactive/i.test(message)) return 400;
  return 500;
}

function sendError(res: Response, error: unknown, context: string) {
  if (sendBaleMirrorMovementRefusal(res, error)) return res;
  const status = errorStatus(error);
  if (status === 500) logger.error(`[StockTransferLifecycle ${context}]`, { error: error });
  const payload: Record<string, unknown> = {
    message: String((error as { message: unknown })?.message ?? `Failed to ${context.toLowerCase()} stock transfer`),
  };
  for (const field of ["code", "stockItemId", "sourceLocationId", "requiredQuantity", "availableQuantity"]) {
    if ((error as { [key: string]: undefined })?.[field] !== undefined)
      payload[field] = (error as { [key: string]: unknown })[field];
  }
  return res.status(status).json(payload);
}

async function getVoucher(voucherId: number) {
  const [voucher] = await db.select().from(vouchers).where(eq(vouchers.id, voucherId)).limit(1);
  return voucher;
}

/**
 * Registered before generic and legacy voucher handlers. These handlers own
 * Stock Transfer draft/post transitions only; unrelated voucher types call next().
 */
export function registerStockTransferLifecycleRoutes(app: Express) {
  /**
   * Prevent the editor's two-request PATCH-then-PUT sequence from posting the
   * old draft before its edited item rows are saved. Drafts must be saved while
   * optional, then finalized through the atomic finalize endpoint.
   */
  app.patch("/api/vouchers/:id", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    try {
      if (req.body?.optional === undefined) return next();
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const voucherId = Number(req.params.id);
      if (!Number.isInteger(voucherId) || voucherId <= 0)
        return res.status(400).json({ message: "Invalid voucher ID" });

      const voucher = await getVoucher(voucherId);
      if (
        !voucher ||
        (voucher.voucherType !== "Stock Transfer" &&
          voucher.voucherType !== "StockTransfer" &&
          voucher.voucherType !== "Transfer")
      )
        return next();
      if (voucher.companyId !== companyId)
        return res.status(403).json({ message: "Voucher belongs to a different company" });

      const targetOptional = req.body.optional === true;
      if (targetOptional === voucher.optional) return next();

      if (!targetOptional) {
        return res.status(409).json({
          code: "STOCK_TRANSFER_FINALIZE_REQUIRED",
          message:
            "Save this stock transfer as Optional first, then use Finalize. Finalization revalidates source stock and posts the complete edited order atomically.",
        });
      }

      if (req.session.currentRole === "POS") {
        return res.status(403).json({ message: "POS users cannot reopen a posted stock transfer" });
      }

      const result = await reopenStockTransferAsDraft(companyId, voucherId, {
        voucherDate: req.body.voucherDate,
        description: req.body.description,
      });
      return res.json({ success: true, ...result });
    } catch (error) {
      return sendError(res, error, "Reopen");
    }
  });

  app.put("/api/stock-transfers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const transferId = Number(req.params.id);
      if (!Number.isInteger(transferId) || transferId <= 0) {
        return res.status(400).json({ message: "Transfer ID is required" });
      }

      const parsed = putSchema.parse(req.body);
      const result = await saveStockTransferLifecycle({
        companyId,
        transferId,
        destinationLocationId: parsed.destinationLocationId,
        notes: parsed.notes,
        items: parsed.items,
      });
      return res.json({
        transfer: {
          id: result.transferId,
          voucherId: result.voucherId,
          inventoryApplied: result.inventoryApplied,
        },
        items: result.items,
        lifecycle: result,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return res.status(400).json({ message: "Invalid stock transfer data", errors: error.issues });
      }
      return sendError(res, error, "Update");
    }
  });

  /** Shadows the old single-source voucher edit path with multi-source-safe lifecycle logic. */
  app.patch(
    "/api/vouchers/:id/transfer",
    requireAuth,
    requireNonPOS,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const voucherId = Number(req.params.id);
        if (!Number.isInteger(voucherId) || voucherId <= 0)
          return res.status(400).json({ message: "Invalid voucher ID" });

        const voucher = await getVoucher(voucherId);
        if (
          !voucher ||
          (voucher.voucherType !== "Stock Transfer" &&
            voucher.voucherType !== "StockTransfer" &&
            voucher.voucherType !== "Transfer")
        )
          return next();
        if (voucher.companyId !== companyId)
          return res.status(403).json({ message: "Voucher belongs to a different company" });

        const [transfer] = await db
          .select()
          .from(stockTransferVouchers)
          .where(eq(stockTransferVouchers.voucherId, voucherId))
          .limit(1);
        if (!transfer) return res.status(404).json({ message: "Stock transfer not found" });

        const parsed = transferPatchSchema.parse(req.body);
        const fallbackSourceId = parsed.sourceLocationId;
        const items: StockTransferLifecycleItem[] = parsed.items.map((item) => {
          const sourceLocationId = item.sourceLocationId ?? fallbackSourceId;
          if (!sourceLocationId) throw new Error("Source location is required for every transfer item");
          return { ...item, sourceLocationId };
        });

        const result = await saveStockTransferLifecycle({
          companyId,
          transferId: transfer.id,
          destinationLocationId: parsed.destinationLocationId,
          notes: parsed.description,
          description: parsed.description,
          voucherDate: parsed.voucherDate,
          items,
        });
        return res.json({ success: true, voucherId, transferId: transfer.id, lifecycle: result });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return res.status(400).json({ message: "Invalid stock transfer data", errors: error.issues });
        }
        return sendError(res, error, "Update");
      }
    }
  );

  app.post(
    "/api/vouchers/:id/finalize",
    requireAuth,
    requireNonPOS,
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const voucherId = Number(req.params.id);
        if (!Number.isInteger(voucherId) || voucherId <= 0)
          return res.status(400).json({ message: "Invalid voucher ID" });

        const voucher = await getVoucher(voucherId);
        if (
          !voucher ||
          (voucher.voucherType !== "Stock Transfer" &&
            voucher.voucherType !== "StockTransfer" &&
            voucher.voucherType !== "Transfer")
        )
          return next();
        if (voucher.companyId !== companyId)
          return res.status(403).json({ message: "Voucher belongs to a different company" });

        const result = await finalizeOptionalStockTransfer(companyId, voucherId);
        return res.json({ success: true, ...result });
      } catch (error) {
        return sendError(res, error, "Finalize");
      }
    }
  );

  /** Explicit approval endpoint for other stock-transfer screens and future workflows. */
  app.post(
    "/api/stock-transfers/:id/approve",
    requireAuth,
    requireNonPOS,
    requireActionAccess("act_transfer_stock"),
    async (req: Request, res: Response) => {
      try {
        const companyId = req.session.currentCompanyId;
        if (!companyId) return res.status(400).json({ message: "No company selected" });
        const transferId = Number(req.params.id);
        if (!Number.isInteger(transferId) || transferId <= 0) {
          return res.status(400).json({ message: "Transfer ID is required" });
        }
        const result = await finalizeStockTransferByTransferId(companyId, transferId);
        return res.json({ success: true, ...result });
      } catch (error) {
        return sendError(res, error, "Approve");
      }
    }
  );
}

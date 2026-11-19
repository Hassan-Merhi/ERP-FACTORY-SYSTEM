// Extracted from ./stockAdjustmentCreateHandler.ts
import type { Request, Response } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { storage } from "../storage";
import { logger } from "../lib/logger";
import { companies, locations } from "@shared/schema";
import { DuplicateStockAdjustmentError } from "../storage/stock-ops/transfers-create";
import { infrastructurePostingIdentity } from "../services/accounting/infrastructureVoucherIdentity";
import { getCurrentExchangeRate } from "./_helpers";

export type AdjustmentType = "Production" | "Consumption" | "Mixed";

type IncomingAdjustmentItem = {
  stockItemId?: unknown;
  quantity?: unknown;
  rate?: unknown;
};

export function normalizeCurrency(code: string | null | undefined): string {
  const normalized = (code || "USD").trim().toUpperCase();
  return normalized === "XOF" ? "CFA" : normalized;
}

export function normalizeAdjustmentItems(items: IncomingAdjustmentItem[]) {
  return items.map((item, index) => {
    const stockItemId = Number(item.stockItemId);
    const quantity = Number(item.quantity);
    const rawRate = item.rate === null || item.rate === undefined || item.rate === "" ? 0 : Number(item.rate);

    if (!Number.isInteger(stockItemId) || stockItemId <= 0) {
      throw new Error(`Stock item ID is required for item ${index + 1}`);
    }
    if (!Number.isFinite(quantity) || quantity === 0) {
      throw new Error(`Quantity cannot be zero for item ${index + 1}`);
    }
    if (!Number.isFinite(rawRate) || rawRate < 0) {
      throw new Error(`Rate must be a non-negative number for item ${index + 1}`);
    }

    return {
      stockItemId,
      quantity: quantity.toString(),
      // Consumption ultimately uses the locked/current inventory rate in the
      // storage layer. Accepting a missing client-side rate prevents the
      // voucher from being created without its linked adjustment rows.
      rate: rawRate.toString(),
    };
  });
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Creates the stock voucher and its adjustment in one transaction
 * (createStockAdjustmentWithVoucher): the generic voucher routes refuse the
 * stock voucher types (wave 12), so this is how the form creates one.
 */
export async function createWithVoucher(
  req: Request,
  res: Response,
  input: {
    header: Record<string, unknown>;
    locationId: number;
    adjustmentType: AdjustmentType;
    notes: string;
    items: ReturnType<typeof normalizeAdjustmentItems>;
    startedAt: number;
  }
) {
  const companyId = req.session.currentCompanyId;
  if (!companyId) return res.status(400).json({ message: "No company selected" });
  const { header } = input;
  const voucherDate = typeof header.voucherDate === "string" ? header.voucherDate.trim() : "";
  if (!ISO_DATE.test(voucherDate)) {
    return res.status(400).json({ message: "Invalid request data", field: "voucherDate" });
  }
  if (header.optional !== undefined && typeof header.optional !== "boolean") {
    return res.status(400).json({ message: "Invalid request data", field: "optional" });
  }
  const [location] = await db.select().from(locations).where(eq(locations.id, input.locationId)).limit(1);
  if (!location) return res.status(404).json({ message: "Location not found" });
  if (location.companyId !== companyId) {
    return res.status(403).json({ message: "Voucher and location must belong to the selected company" });
  }
  const [company] = await db
    .select({ baseCurrency: companies.baseCurrency })
    .from(companies)
    .where(eq(companies.id, companyId))
    .limit(1);
  const nativeCurrency = normalizeCurrency(company?.baseCurrency);
  if (nativeCurrency.length > 3) {
    return res.status(400).json({ message: `Unsupported voucher currency: ${nativeCurrency}` });
  }
  const voucherNumber =
    typeof header.voucherNumber === "string" && header.voucherNumber.trim()
      ? header.voucherNumber.trim()
      : `${input.adjustmentType.toUpperCase()}-${Date.now()}`;
  const exchangeRate = await getCurrentExchangeRate(companyId);
  try {
    const created = await storage.createStockAdjustmentWithVoucher(
      {
        companyId,
        voucherNumber,
        voucherType: input.adjustmentType,
        voucherDate,
        // The writer derives the header total from the persisted lines.
        totalAmount: "0",
        description: typeof header.description === "string" && header.description.trim() ? header.description : null,
        optional: header.optional === true,
        // The writer sets the company's native currency on the header (voucherHeader below).
        currency: "USD",
        exchangeRate: exchangeRate == null ? undefined : String(exchangeRate),
        sourceModule: "ERP",
      },
      infrastructurePostingIdentity("stock-adjustment-voucher", `${companyId}:${voucherNumber}`, "create"),
      input.locationId,
      input.notes,
      input.items,
      { currency: nativeCurrency }
    );
    logger.info("stock adjustment create succeeded", {
      module: "stockAdjustment",
      action: "createWithVoucher",
      userId: req.session.userId,
      companyId,
      voucherId: created.voucher.id,
      adjustmentId: created.adjustment.id,
      durationMs: Date.now() - input.startedAt,
    });
    return res.status(201).json(created);
  } catch (error: unknown) {
    if (error instanceof DuplicateStockAdjustmentError) {
      return res.status(409).json({ code: error.code, message: "This voucher already has a stock adjustment" });
    }
    throw error;
  }
}

import type { Express, NextFunction, Request, Response } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { companies, voucherEntries, vouchers } from "@shared/schema";
import { db } from "../db";

/**
 * Retail-only HTTP boundary for manually constructed voucher types.
 *
 * System-created Retail sales, refund, inventory and tax journals are written
 * directly through the central posting engine and do not cross this HTTP
 * boundary. Read-only voucher and Daybook routes also remain accessible, as do
 * Payment, Receipt and Stock Transfer vouchers.
 */
const hiddenManualVoucherTypes = new Set([
  "journal",
  "creditnote",
  "debitnote",
  "adjustment",
  "stockadjustment",
  "consumption",
  "production",
  "mixed",
  "stocktransferorder",
  "transferorder",
]);

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Manual entry points whose every write creates or edits a hidden voucher type:
 * the Journal form, the Credit/Debit Note tab and the Stock Adjustment form.
 * Retail's own adjustment workflow lives under /api/pos/retail/adjustments.
 */
const ALWAYS_BLOCKED_WRITE_PATHS = [
  /^\/api\/vouchers\/journal\/?$/i,
  /^\/api\/credit-notes(?:\/|$)/i,
  /^\/api\/stock-adjustments(?:\/|$)/i,
];

const GUARDED_PATH = /^\/api\/(?:vouchers|voucher-entries|credit-notes|stock-adjustments)(?:\/|$)/i;

export function isRetailManualVoucherTypeBlocked(type: unknown): boolean {
  // The legacy API uses e.g. "Credit Note", "CreditNote" and "credit_note"
  // in different routes. All aliases must share the same Retail refusal.
  return (
    typeof type === "string" &&
    hiddenManualVoucherTypes.has(
      type
        .trim()
        .toLowerCase()
        .replace(/[\s_-]+/g, "")
    )
  );
}

function positiveId(value: unknown): number | null {
  const id = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

async function voucherTypesById(companyId: number, ids: number[]): Promise<string[]> {
  if (!ids.length) return [];
  const rows = await db
    .select({ voucherType: vouchers.voucherType })
    .from(vouchers)
    .where(and(inArray(vouchers.id, ids), eq(vouchers.companyId, companyId)));
  return rows.map((row) => row.voucherType);
}

/** Voucher types an HTTP write would touch, resolved without modifying data. */
async function targetedVoucherTypes(req: Request, path: string, companyId: number): Promise<string[]> {
  const voucherMatch = path.match(/^\/api\/vouchers\/(\d+)(?:\/|$)/i);
  if (voucherMatch) return voucherTypesById(companyId, [Number(voucherMatch[1])]);

  if (/^\/api\/vouchers\/bulk-delete\/?$/i.test(path)) {
    const raw: unknown[] = Array.isArray(req.body?.voucherIds) ? req.body.voucherIds : [];
    const ids = raw.map(positiveId).filter((id): id is number => id !== null);
    return voucherTypesById(companyId, ids);
  }

  // Admin bulk reclassification moves existing lines to another ledger account.
  if (/^\/api\/voucher-entries\/transfer-account\/?$/i.test(path)) {
    const raw: unknown[] = Array.isArray(req.body?.entryIds) ? req.body.entryIds : [];
    const ids = raw.map(positiveId).filter((id): id is number => id !== null);
    if (!ids.length) return [];
    const rows = await db
      .select({ voucherType: vouchers.voucherType })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
      .where(and(inArray(voucherEntries.id, ids), eq(vouchers.companyId, companyId)));
    return rows.map((row) => row.voucherType);
  }

  if (/^\/api\/voucher-entries\/?$/i.test(path)) {
    const voucherId = positiveId(req.body?.voucherId);
    return voucherId ? voucherTypesById(companyId, [voucherId]) : [];
  }

  const entryMatch = path.match(/^\/api\/voucher-entries\/(\d+)(?:\/|$)/i);
  if (entryMatch) {
    const rows = await db
      .select({ voucherType: vouchers.voucherType })
      .from(voucherEntries)
      .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
      .where(and(eq(voucherEntries.id, Number(entryMatch[1])), eq(vouchers.companyId, companyId)));
    return rows.map((row) => row.voucherType);
  }

  return [];
}

export async function retailManualVoucherBoundary(req: Request, res: Response, next: NextFunction) {
  if (!WRITE_METHODS.has(req.method.toUpperCase())) return next();
  const path = req.originalUrl.split("?", 1)[0];
  if (!GUARDED_PATH.test(path)) return next();
  if (!req.session?.userId) return next(); // Existing handlers perform authentication.

  const companyId = Number(req.session.currentCompanyId);
  if (!Number.isSafeInteger(companyId) || companyId <= 0) return next();

  try {
    const [company] = await db
      .select({ companyType: companies.companyType })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    if (company?.companyType !== "retail") return next();

    const method = req.method.toUpperCase();
    const proposed = req.body?.voucher?.voucherType ?? req.body?.voucherType;
    const genericCreate = method === "POST" && /^\/api\/vouchers(?:\/with-entries)?\/?$/i.test(path);

    if (
      ALWAYS_BLOCKED_WRITE_PATHS.some((pattern) => pattern.test(path)) ||
      (genericCreate && isRetailManualVoucherTypeBlocked(proposed))
    ) {
      return res.status(403).json({
        code: "RETAIL_MANUAL_VOUCHER_TYPE_BLOCKED",
        message:
          "Retail system journals, adjustment/credit-note and Transfer Order vouchers cannot be created manually.",
      });
    }

    // Generic edit/update/delete routes must not change an existing Retail
    // system journal, even when the caller supplies a different voucherType.
    const targeted = await targetedVoucherTypes(req, path, companyId);
    if (
      targeted.some(isRetailManualVoucherTypeBlocked) ||
      (targeted.length > 0 && isRetailManualVoucherTypeBlocked(proposed))
    ) {
      return res.status(403).json({
        code: "RETAIL_SYSTEM_VOUCHER_READ_ONLY",
        message: "This Retail system voucher is read-only. Use the posted voucher detail and Daybook for audit.",
      });
    }
    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Must be installed before every voucher, voucher-entry, credit-note and
 * stock-adjustment write route (see applicationRoutes.ts).
 */
export function registerRetailManualVoucherBoundary(app: Express): void {
  app.use(retailManualVoucherBoundary);
}

import type { Express, NextFunction, Request, Response } from "express";
import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import { and, asc, desc, eq, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { userLocations, vouchers } from "@shared/schema";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function wantsStructuredPagination(req: Request): boolean {
  return (
    req.query.pagination === "1" ||
    req.query.page !== undefined ||
    req.query.limit !== undefined ||
    req.query.pageSize !== undefined ||
    req.query.offset !== undefined
  );
}

function parsePagination(req: Request): {
  page: number;
  limit: number;
  offset: number;
} {
  const limit = Math.min(MAX_PAGE_SIZE, parsePositiveInt(req.query.limit ?? req.query.pageSize, DEFAULT_PAGE_SIZE));
  if (req.query.offset !== undefined) {
    const offset = Math.max(0, Number.parseInt(String(req.query.offset), 10) || 0);
    return { page: Math.floor(offset / limit) + 1, limit, offset };
  }
  const page = parsePositiveInt(req.query.page, 1);
  return { page, limit, offset: (page - 1) * limit };
}

function normalizeDate(value: unknown): string | undefined {
  return typeof value === "string" && ISO_DATE.test(value) ? value : undefined;
}

function applyPaginationHeaders(res: Response, total: number, page: number, limit: number, totalPages: number): void {
  res.setHeader("X-Total-Count", String(total));
  res.setHeader("X-Page", String(page));
  res.setHeader("X-Page-Size", String(limit));
  res.setHeader("X-Total-Pages", String(totalPages));
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Count, X-Page, X-Page-Size, X-Total-Pages");
}

function sanitizeForPos(rows: Record<string, unknown>[]) {
  return rows.map((voucher) => {
    const voucherType = String(voucher.voucherType || "").toLowerCase();
    if (voucherType === "stock transfer" || voucherType === "stocktransfer" || voucherType.includes("stock transfer")) {
      return { ...voucher, totalAmount: "0" };
    }
    return voucher;
  });
}

export function registerVoucherPaginationRoutes(app: Express): void {
  app.get("/api/vouchers", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    // Compatibility callers still depend on the complete legacy array. Only
    // explicit pagination requests are intercepted by this native SQL reader.
    if (!wantsStructuredPagination(req)) return next();

    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      let startDate = normalizeDate(req.query.startDate);
      let endDate = normalizeDate(req.query.endDate);
      if (!startDate || !endDate) {
        const end = new Date();
        const start = new Date();
        start.setDate(start.getDate() - 90);
        startDate = start.toISOString().slice(0, 10);
        endDate = end.toISOString().slice(0, 10);
      }

      const conditions: (SQL | undefined)[] = [
        eq(vouchers.companyId, companyId),
        isNull(vouchers.deletedAt),
        sql`${vouchers.voucherDate} >= ${startDate}`,
        sql`${vouchers.voucherDate} <= ${endDate}`,
        sql`${vouchers.voucherNumber} NOT LIKE 'SP-OTW-REV-%'`,
        sql`${vouchers.voucherNumber} NOT LIKE 'SP-STOCK-%'`,
        sql`${vouchers.voucherNumber} NOT LIKE 'SP-OPNSTK-%'`,
      ];

      const voucherType = typeof req.query.voucherType === "string" ? req.query.voucherType.trim() : "";
      if (voucherType && voucherType !== "all") {
        conditions.push(eq(vouchers.voucherType, voucherType));
      }

      const statusFilter = typeof req.query.statusFilter === "string" ? req.query.statusFilter : "all";
      if (statusFilter === "active") conditions.push(eq(vouchers.optional, false));
      else if (statusFilter === "optional") conditions.push(eq(vouchers.optional, true));

      const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
      if (search) {
        conditions.push(
          or(
            punctuationInsensitiveSearch(vouchers.voucherNumber, search),
            punctuationInsensitiveSearch(vouchers.description, search)
          )
        );
      }

      const minAmount = Number.parseFloat(String(req.query.minAmount ?? ""));
      const maxAmount = Number.parseFloat(String(req.query.maxAmount ?? ""));
      if (Number.isFinite(minAmount)) {
        conditions.push(sql`${vouchers.totalAmount}::numeric >= ${minAmount}`);
      }
      if (Number.isFinite(maxAmount)) {
        conditions.push(sql`${vouchers.totalAmount}::numeric <= ${maxAmount}`);
      }

      const isPos = req.session.currentRole === "POS";
      if (isPos && req.user?.id) {
        const assignedLocations = await db
          .select({ locationId: userLocations.locationId })
          .from(userLocations)
          .where(and(eq(userLocations.userId, req.user.id), eq(userLocations.companyId, companyId)));
        const allowedLocationIds = assignedLocations.map((row) => row.locationId);
        if (allowedLocationIds.length > 0) {
          conditions.push(or(isNull(vouchers.locationId), inArray(vouchers.locationId, allowedLocationIds)));
        }
      }

      const { page, limit, offset } = parsePagination(req);
      const where = and(...conditions);
      const dateSort = sql`COALESCE(${vouchers.effectiveDate}, ${vouchers.voucherDate})`;
      const ascending = req.query.sortOrder === "asc";

      const [countRows, data] = await Promise.all([
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(vouchers)
          .where(where),
        db
          .select()
          .from(vouchers)
          .where(where)
          .orderBy(ascending ? asc(dateSort) : desc(dateSort), ascending ? asc(vouchers.id) : desc(vouchers.id))
          .limit(limit)
          .offset(offset),
      ]);

      const total = countRows[0]?.total ?? 0;
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      const items = isPos ? sanitizeForPos(data) : data;
      applyPaginationHeaders(res, total, page, limit, totalPages);
      return res.json({
        items,
        total,
        page,
        limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1 && totalPages > 0,
      });
    } catch (error: unknown) {
      return res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

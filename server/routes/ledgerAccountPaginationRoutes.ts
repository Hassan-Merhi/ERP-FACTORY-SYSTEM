import type { Express, NextFunction, Request, Response } from "express";
import { and, asc, eq, isNull, or, sql, type SQL } from "drizzle-orm";
import { requireAuth } from "../auth";
import { db } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { ledgerAccounts } from "@shared/schema";
import { punctuationInsensitiveSearch } from "../lib/searchNormalization";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;

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

function applyPaginationHeaders(res: Response, total: number, page: number, limit: number, totalPages: number): void {
  res.setHeader("X-Total-Count", String(total));
  res.setHeader("X-Page", String(page));
  res.setHeader("X-Page-Size", String(limit));
  res.setHeader("X-Total-Pages", String(totalPages));
  res.setHeader("Access-Control-Expose-Headers", "X-Total-Count, X-Page, X-Page-Size, X-Total-Pages");
}

export function registerLedgerAccountPaginationRoutes(app: Express): void {
  app.get("/api/ledger-accounts", requireAuth, async (req: Request, res: Response, next: NextFunction) => {
    // Forms and account pickers still rely on the complete legacy array. The
    // native route owns only explicit page requests until each selector is upgraded.
    if (!wantsStructuredPagination(req)) return next();

    try {
      const sessionCompanyId = req.session.currentCompanyId;
      const requestedCompanyId =
        typeof req.query.companyId === "string" ? Number.parseInt(req.query.companyId, 10) : undefined;
      const companyId = requestedCompanyId || sessionCompanyId;

      if (!companyId) return res.status(400).json({ message: "No company selected" });
      if (requestedCompanyId && sessionCompanyId && requestedCompanyId !== sessionCompanyId) {
        return res.status(403).json({ message: "Access denied for selected company" });
      }

      const conditions: (SQL | undefined)[] = [
        eq(ledgerAccounts.companyId, companyId),
        isNull(ledgerAccounts.deletedAt),
      ];
      if (req.query.includeHidden !== "true") {
        conditions.push(eq(ledgerAccounts.isHidden, false));
      }

      const accountType = typeof req.query.accountType === "string" ? req.query.accountType.trim() : "";
      if (accountType) conditions.push(eq(ledgerAccounts.accountType, accountType));

      const search = typeof req.query.search === "string" ? req.query.search.trim() : "";
      if (search) {
        conditions.push(
          or(
            punctuationInsensitiveSearch(ledgerAccounts.name, search),
            punctuationInsensitiveSearch(ledgerAccounts.code, search)
          )
        );
      }

      const { page, limit, offset } = parsePagination(req);
      const where = and(...conditions);
      const dataQuery =
        req.query.profile === "picker"
          ? db
              .select({
                id: ledgerAccounts.id,
                code: ledgerAccounts.code,
                name: ledgerAccounts.name,
                accountType: ledgerAccounts.accountType,
                subType: ledgerAccounts.subType,
                parentId: ledgerAccounts.parentId,
                active: ledgerAccounts.active,
                isHidden: ledgerAccounts.isHidden,
              })
              .from(ledgerAccounts)
              .where(where)
              .orderBy(asc(ledgerAccounts.code), asc(ledgerAccounts.id))
              .limit(limit)
              .offset(offset)
          : db
              .select()
              .from(ledgerAccounts)
              .where(where)
              .orderBy(asc(ledgerAccounts.code), asc(ledgerAccounts.id))
              .limit(limit)
              .offset(offset);

      const [countRows, data] = await Promise.all([
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(ledgerAccounts)
          .where(where),
        dataQuery,
      ]);

      const total = countRows[0]?.total ?? 0;
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      applyPaginationHeaders(res, total, page, limit, totalPages);
      return res.json({
        items: data,
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

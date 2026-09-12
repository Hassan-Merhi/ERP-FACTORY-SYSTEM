import type { Express, NextFunction, Request, Response } from "express";
import { and, asc, desc, eq, ne, sql } from "drizzle-orm";
import { requireAuth, requireNonPOS } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { containerSales, containers, customers } from "@shared/schema";

const DEFAULT_PAGE_SIZE = 250;
const MAX_PAGE_SIZE = 250;

function wantsPagination(req: Request): boolean {
  return (
    req.query.pagination === "1" ||
    req.query.page !== undefined ||
    req.query.limit !== undefined ||
    req.query.pageSize !== undefined ||
    req.query.offset !== undefined
  );
}

function parsePositiveInt(value: unknown, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parsePagination(req: Request): {
  page: number;
  limit: number;
  offset: number;
} {
  const limit = Math.min(
    MAX_PAGE_SIZE,
    parsePositiveInt(req.query.limit ?? req.query.pageSize, DEFAULT_PAGE_SIZE),
  );
  if (req.query.offset !== undefined) {
    const offset = Math.max(
      0,
      Number.parseInt(String(req.query.offset), 10) || 0,
    );
    return { page: Math.floor(offset / limit) + 1, limit, offset };
  }
  const page = parsePositiveInt(req.query.page, 1);
  return { page, limit, offset: (page - 1) * limit };
}

function sendPage(
  res: Response,
  items: unknown[],
  total: number,
  page: number,
  limit: number,
): Response {
  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  res.setHeader("X-Total-Count", String(total));
  res.setHeader("X-Page", String(page));
  res.setHeader("X-Page-Size", String(limit));
  res.setHeader("X-Total-Pages", String(totalPages));
  res.setHeader(
    "Access-Control-Expose-Headers",
    "X-Total-Count, X-Page, X-Page-Size, X-Total-Pages",
  );
  return res.json({
    items,
    total,
    page,
    limit,
    totalPages,
    hasNextPage: page < totalPages,
    hasPreviousPage: page > 1 && totalPages > 0,
  });
}

export function registerContainerListPaginationRoutes(app: Express): void {
  const guard =
    (handler: (req: Request, res: Response) => Promise<Response | void>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      if (!wantsPagination(req)) return next();
      try {
        await handler(req, res);
      } catch (error: unknown) {
        return res.status(500).json({ message: getErrorMessage(error) });
      }
    };

  app.get(
    "/api/containers/active",
    requireAuth,
    requireNonPOS,
    guard(async (req, res) => {
      const companyId = req.session.currentCompanyId;
      if (!companyId)
        return res.status(400).json({ message: "No company selected" });
      const { page, limit, offset } = parsePagination(req);
      const condition = and(
        eq(containers.companyId, companyId),
        ne(containers.status, "SOLD"),
      );
      const [countRows, items] = await Promise.all([
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(containers)
          .where(condition),
        db
          .select()
          .from(containers)
          .where(condition)
          .orderBy(asc(containers.containerNumber), asc(containers.id))
          .limit(limit)
          .offset(offset),
      ]);
      return sendPage(res, items, countRows[0]?.total ?? 0, page, limit);
    }),
  );

  app.get(
    "/api/containers/sold",
    requireAuth,
    requireNonPOS,
    guard(async (req, res) => {
      const companyId = req.session.currentCompanyId;
      if (!companyId)
        return res.status(400).json({ message: "No company selected" });
      const { page, limit, offset } = parsePagination(req);
      const condition = and(
        eq(containers.companyId, companyId),
        eq(containers.status, "SOLD"),
      );
      const [countRows, items] = await Promise.all([
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(containers)
          .where(condition),
        db
          .select({
            containerId: containers.id,
            containerNumber: containers.containerNumber,
            supplierId: containers.supplierId,
            status: containers.status,
            importDate: containers.importDate,
            itemsTotal: containers.itemsTotal,
            chargesTotal: containers.chargesTotal,
            grandTotal: containers.grandTotal,
            saleId: containerSales.id,
            customerId: containerSales.customerId,
            customerName: customers.legalName,
            saleDate: containerSales.saleDate,
            containerCost: containerSales.containerCost,
            commission: containerSales.commission,
            commissionAccountId: containerSales.commissionAccountId,
            totalAmount: containerSales.totalAmount,
            notes: containerSales.notes,
          })
          .from(containers)
          .innerJoin(
            containerSales,
            eq(containers.id, containerSales.containerId),
          )
          .innerJoin(customers, eq(containerSales.customerId, customers.id))
          .where(condition)
          .orderBy(desc(containerSales.saleDate), desc(containerSales.id))
          .limit(limit)
          .offset(offset),
      ]);
      return sendPage(res, items, countRows[0]?.total ?? 0, page, limit);
    }),
  );

  app.get(
    "/api/containers",
    requireAuth,
    requireNonPOS,
    guard(async (req, res) => {
      const companyId = req.session.currentCompanyId;
      if (!companyId)
        return res.status(400).json({ message: "No company selected" });
      const { page, limit, offset } = parsePagination(req);
      const condition = eq(containers.companyId, companyId);
      const [countRows, items] = await Promise.all([
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(containers)
          .where(condition),
        db
          .select()
          .from(containers)
          .where(condition)
          .orderBy(asc(containers.containerNumber), asc(containers.id))
          .limit(limit)
          .offset(offset),
      ]);
      return sendPage(res, items, countRows[0]?.total ?? 0, page, limit);
    }),
  );
}

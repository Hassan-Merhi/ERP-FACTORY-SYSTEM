import type { Express, Request } from "express";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { authorizeCompanyIdParam } from "../helpers/supplierBalanceHelpers";
import { companies, containers, purchaseOrders } from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { parsePositiveInt } from "../../lib/listPagination";

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 250;

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

export function registerSupplierPurchaseOrderPaginationRoutes(app: Express): void {
  app.get("/api/suppliers/:supplierId/purchase-orders", requireAuth, async (req, res) => {
    try {
      const supplierId = Number.parseInt(req.params.supplierId, 10);
      if (!Number.isInteger(supplierId)) {
        return res.status(400).json({ message: "Invalid supplier ID" });
      }
      const requestedCompanyId =
        typeof req.query.companyId === "string"
          ? Number.parseInt(req.query.companyId, 10)
          : req.session.currentCompanyId;
      const companyId = await authorizeCompanyIdParam(req, requestedCompanyId);
      if (companyId === null) {
        return res.status(403).json({ message: "No access to this company" });
      }

      const [supplier] = await db
        .select({ id: companyScopedSuppliers.id })
        .from(companyScopedSuppliers)
        .where(
          and(
            eq(companyScopedSuppliers.id, supplierId),
            eq(companyScopedSuppliers.companyId, companyId),
            isNull(companyScopedSuppliers.deletedAt)
          )
        )
        .limit(1);
      if (!supplier) return res.status(404).json({ message: "Supplier not found" });

      const { page, limit, offset } = parsePagination(req);
      const condition = and(eq(purchaseOrders.supplierId, supplierId), eq(purchaseOrders.companyId, companyId));
      const [countRows, rows] = await Promise.all([
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(purchaseOrders)
          .where(condition),
        db
          .select({
            id: purchaseOrders.id,
            poNumber: purchaseOrders.poNumber,
            companyId: purchaseOrders.companyId,
            companyName: companies.name,
            containerId: purchaseOrders.containerId,
            containerNumber: containers.containerNumber,
            importDate: containers.importDate,
            itemsTotal: purchaseOrders.itemsTotal,
            freight: purchaseOrders.freight,
            surcharge: purchaseOrders.surcharge,
            fumigation: purchaseOrders.fumigation,
            documentCharges: purchaseOrders.documentCharges,
            discount: purchaseOrders.discount,
            otherCharges: purchaseOrders.otherCharges,
            currency: purchaseOrders.currency,
            createdAt: purchaseOrders.createdAt,
            voucherId: purchaseOrders.voucherId,
          })
          .from(purchaseOrders)
          .leftJoin(containers, eq(purchaseOrders.containerId, containers.id))
          .leftJoin(companies, eq(purchaseOrders.companyId, companies.id))
          .where(condition)
          .orderBy(desc(purchaseOrders.createdAt), desc(purchaseOrders.id))
          .limit(limit)
          .offset(offset),
      ]);

      const total = countRows[0]?.total ?? 0;
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      res.setHeader("X-Total-Count", String(total));
      res.setHeader("X-Page", String(page));
      res.setHeader("X-Page-Size", String(limit));
      res.setHeader("X-Total-Pages", String(totalPages));
      res.setHeader("Access-Control-Expose-Headers", "X-Total-Count, X-Page, X-Page-Size, X-Total-Pages");

      if (!wantsStructuredPagination(req)) return res.json(rows);
      return res.json({
        items: rows,
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

/**
 * Retail Wave 2, Track A — customers for the retail POS.
 *
 * Retail staff do not need the ERP `canAccessCustomers` permission: these endpoints
 * are retail-company scoped and reuse the existing ERP customer records where they
 * exist. Walk-in stays the default — a sale only stores a customer when the cashier
 * picked one.
 */
import type { Express } from "express";
import { and, desc, eq, gte, inArray, isNull, lte, or } from "drizzle-orm";
import { z } from "zod";
import {
  customers,
  locations,
  retailBrands,
  retailPosReturnItems,
  retailPosReturns,
  retailPosSaleItems,
  retailPosSales,
  retailProductVariants,
  retailProducts,
  retailStockOperations,
} from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import { loadSaleResponse } from "../../services/retail/retailSaleService";
import { ensureCompanyLocation, requireRetailCompany } from "./retailPosContext";

const customerCreateSchema = z.object({
  legalName: z.string().trim().min(1).max(240),
  phone: z.string().trim().max(60).optional(),
});

const saleSearchSchema = z.object({
  receipt: z.string().trim().max(40).optional(),
  customerId: z.coerce.number().int().positive().optional(),
  barcode: z.string().trim().max(191).optional(),
  search: z.string().trim().max(191).optional(),
  dateFrom: z.string().trim().max(40).optional(),
  dateTo: z.string().trim().max(40).optional(),
  locationId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

function parseDate(value: string | undefined, endOfDay: boolean): Date | null {
  if (!value) return null;
  const parsed = new Date(value.length <= 10 ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Accepts `123`, `#123` and `R-000123` and returns the sale id. */
export function normalizeRetailReceiptNumber(value: string): number | null {
  const cleaned = value.trim().replace(/^#/, "").replace(/^r-?/i, "");
  if (!/^\d+$/.test(cleaned)) return null;
  const parsed = Number(cleaned);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export function registerRetailCustomerRoutes(app: Express): void {
  /** Search customers by name, phone or code (empty search lists the most recent ones). */
  app.get("/api/pos/retail/customers", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const search = String(req.query.search ?? "").trim();
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 50);
      const rows = await db
        .select({
          id: customers.id,
          code: customers.code,
          legalName: customers.legalName,
          phone: customers.phone,
          active: customers.active,
        })
        .from(customers)
        .where(
          and(
            eq(customers.companyId, companyId),
            isNull(customers.deletedAt),
            search
              ? or(
                  punctuationInsensitiveSearch(customers.legalName, search),
                  punctuationInsensitiveSearch(customers.phone, search),
                  punctuationInsensitiveSearch(customers.code, search)
                )
              : undefined
          )
        )
        .orderBy(desc(customers.createdAt))
        .limit(limit);
      res.json(rows);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /** Quick-create a customer from the POS (name required, phone optional). */
  app.post("/api/pos/retail/customers", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const body = customerCreateSchema.parse(req.body);
      const usedCodes = new Set(
        (
          await db
            .select({ code: customers.code })
            .from(customers)
            .where(and(eq(customers.companyId, companyId), isNull(customers.deletedAt)))
        ).map((row) => row.code)
      );
      let suffix = 1;
      for (const code of usedCodes) {
        const parsed = Number(String(code).replace(/^CUST/i, ""));
        if (Number.isFinite(parsed)) suffix = Math.max(suffix, parsed + 1);
      }
      let code = `CUST${String(suffix).padStart(3, "0")}`;
      while (usedCodes.has(code)) {
        suffix += 1;
        code = `CUST${String(suffix).padStart(3, "0")}`;
      }
      const [customer] = await db
        .insert(customers)
        .values({
          companyId,
          code,
          legalName: body.legalName,
          phone: body.phone?.trim() ? body.phone.trim() : null,
          openingBalance: "0",
          openingBalanceSide: "Dr",
          active: true,
        })
        .returning({
          id: customers.id,
          code: customers.code,
          legalName: customers.legalName,
          phone: customers.phone,
          active: customers.active,
        });
      res.status(201).json(customer);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /** Purchase, receipt, return and exchange history for one customer. */
  app.get("/api/pos/retail/customers/:id/history", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const customerId = Number(req.params.id);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        return res.status(400).json({ message: "Invalid customer" });
      }
      const limit = Math.min(Math.max(Number(req.query.limit) || 25, 1), 100);
      const [customer] = await db
        .select({
          id: customers.id,
          code: customers.code,
          legalName: customers.legalName,
          phone: customers.phone,
          active: customers.active,
          createdAt: customers.createdAt,
        })
        .from(customers)
        .where(and(eq(customers.id, customerId), eq(customers.companyId, companyId), isNull(customers.deletedAt)))
        .limit(1);
      if (!customer) return res.status(404).json({ message: "Customer not found" });

      const saleRows = await db
        .select({ id: retailPosSales.id })
        .from(retailPosSales)
        .where(and(eq(retailPosSales.companyId, companyId), eq(retailPosSales.customerId, customerId)))
        .orderBy(desc(retailPosSales.createdAt))
        .limit(limit);
      const saleIds = saleRows.map((row) => row.id);
      const sales = (await Promise.all(saleIds.map((saleId) => loadSaleResponse(companyId, saleId)))).filter(Boolean);

      const returnRows = saleIds.length
        ? await db
            .select({
              id: retailPosReturns.id,
              saleId: retailPosReturns.saleId,
              refundAmount: retailPosReturns.refundAmount,
              refundTaxAmount: retailPosReturns.refundTaxAmount,
              notes: retailPosReturns.notes,
              createdAt: retailPosReturns.createdAt,
              itemId: retailPosReturnItems.id,
              variantId: retailPosReturnItems.variantId,
              quantity: retailPosReturnItems.quantity,
              grossUnitPrice: retailPosReturnItems.grossUnitPrice,
              productName: retailProducts.name,
              color: retailProductVariants.color,
              size: retailProductVariants.size,
            })
            .from(retailPosReturns)
            .leftJoin(retailPosReturnItems, eq(retailPosReturnItems.returnId, retailPosReturns.id))
            .leftJoin(retailProductVariants, eq(retailProductVariants.id, retailPosReturnItems.variantId))
            .leftJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
            .where(and(eq(retailPosReturns.companyId, companyId), inArray(retailPosReturns.saleId, saleIds)))
            .orderBy(desc(retailPosReturns.createdAt))
        : [];
      const returnsById = new Map<number, Record<string, unknown>>();
      for (const row of returnRows) {
        const entry = returnsById.get(row.id) ?? {
          id: row.id,
          saleId: row.saleId,
          refundAmount: Number(row.refundAmount ?? 0),
          refundTaxAmount: Number(row.refundTaxAmount ?? 0),
          notes: row.notes ?? null,
          createdAt: row.createdAt,
          items: [] as Array<Record<string, unknown>>,
        };
        if (row.itemId) {
          (entry.items as Array<Record<string, unknown>>).push({
            id: row.itemId,
            variantId: row.variantId,
            productName: row.productName,
            color: row.color,
            size: row.size,
            quantity: Number(row.quantity ?? 0),
            grossUnitPrice: Number(row.grossUnitPrice ?? 0),
          });
        }
        returnsById.set(row.id, entry);
      }

      const exchangeRows = saleIds.length
        ? await db
            .select({
              id: retailStockOperations.id,
              referenceId: retailStockOperations.referenceId,
              metadata: retailStockOperations.metadata,
              createdAt: retailStockOperations.createdAt,
            })
            .from(retailStockOperations)
            .where(
              and(
                eq(retailStockOperations.companyId, companyId),
                eq(retailStockOperations.operationType, "exchange"),
                inArray(
                  retailStockOperations.referenceId,
                  saleIds.map((id) => String(id))
                )
              )
            )
            .orderBy(desc(retailStockOperations.createdAt))
        : [];

      const totalSpent = sales.reduce((sum, sale) => sum + Number(sale?.totalAmount ?? 0), 0);
      const totalRefunded = [...returnsById.values()].reduce((sum, entry) => sum + Number(entry.refundAmount ?? 0), 0);
      res.json({
        customer,
        sales,
        returns: [...returnsById.values()],
        exchanges: exchangeRows.map((row) => ({
          id: row.id,
          originalSaleId: Number(row.referenceId ?? 0),
          newSaleId: Number((row.metadata as Record<string, unknown>)?.newSaleId ?? 0),
          returnId: Number((row.metadata as Record<string, unknown>)?.returnId ?? 0),
          refundValue: Number((row.metadata as Record<string, unknown>)?.refundValue ?? 0),
          createdAt: row.createdAt,
        })),
        summary: {
          saleCount: sales.length,
          totalSpent,
          totalRefunded,
          lastPurchaseAt: sales[0]?.createdAt ?? null,
        },
      });
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /** Historic sale search: receipt number, customer, item/barcode, date, location. */
  app.get("/api/pos/retail/sales/search", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const query = saleSearchSchema.parse({
        receipt: req.query.receipt,
        customerId: req.query.customerId,
        barcode: req.query.barcode,
        search: req.query.search,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
        locationId: req.query.locationId,
        limit: req.query.limit,
      });
      const limit = query.limit ?? 25;
      if (query.locationId) await ensureCompanyLocation(companyId, query.locationId);

      const conditions = [eq(retailPosSales.companyId, companyId)];
      if (query.customerId) conditions.push(eq(retailPosSales.customerId, query.customerId));
      if (query.locationId) conditions.push(eq(retailPosSales.locationId, query.locationId));
      const from = parseDate(query.dateFrom, false);
      const to = parseDate(query.dateTo, true);
      if (from) conditions.push(gte(retailPosSales.createdAt, from));
      if (to) conditions.push(lte(retailPosSales.createdAt, to));

      if (query.receipt) {
        const receiptId = normalizeRetailReceiptNumber(query.receipt);
        if (receiptId) conditions.push(eq(retailPosSales.id, receiptId));
        else return res.json([]);
      }

      if (query.barcode || query.search) {
        const itemConditions = [eq(retailPosSaleItems.companyId, companyId)];
        if (query.barcode) itemConditions.push(eq(retailProductVariants.barcode, query.barcode));
        if (query.search) {
          itemConditions.push(
            or(
              punctuationInsensitiveSearch(retailProducts.name, query.search),
              punctuationInsensitiveSearch(retailProducts.code, query.search),
              punctuationInsensitiveSearch(retailProductVariants.sku, query.search),
              punctuationInsensitiveSearch(retailProductVariants.barcode, query.search),
              punctuationInsensitiveSearch(retailProductVariants.color, query.search),
              punctuationInsensitiveSearch(retailProductVariants.size, query.search),
              punctuationInsensitiveSearch(retailBrands.name, query.search)
            )!
          );
        }
        const matchingSales = await db
          .selectDistinct({ saleId: retailPosSaleItems.saleId })
          .from(retailPosSaleItems)
          .innerJoin(retailProductVariants, eq(retailProductVariants.id, retailPosSaleItems.variantId))
          .innerJoin(retailProducts, eq(retailProducts.id, retailProductVariants.productId))
          .leftJoin(retailBrands, eq(retailBrands.id, retailProducts.brandId))
          .where(and(...itemConditions))
          .limit(500);
        const saleIds = matchingSales.map((row) => row.saleId);
        if (!saleIds.length) return res.json([]);
        conditions.push(inArray(retailPosSales.id, saleIds));
      }

      const rows = await db
        .select({ id: retailPosSales.id })
        .from(retailPosSales)
        .leftJoin(locations, eq(locations.id, retailPosSales.locationId))
        .where(and(...conditions))
        .orderBy(desc(retailPosSales.createdAt))
        .limit(limit);
      const results = (await Promise.all(rows.map((row) => loadSaleResponse(companyId, row.id)))).filter(Boolean);
      res.json(results);
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  /** Attach (or clear) a customer on an existing sale — used to correct a walk-in receipt. */
  app.post("/api/pos/retail/sales/:saleId/customer", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const saleId = Number(req.params.saleId);
      if (!Number.isInteger(saleId) || saleId <= 0) return res.status(400).json({ message: "Invalid sale" });
      const body = z.object({ customerId: z.coerce.number().int().positive().nullable() }).parse(req.body ?? {});
      const [sale] = await db
        .select({ id: retailPosSales.id })
        .from(retailPosSales)
        .where(and(eq(retailPosSales.id, saleId), eq(retailPosSales.companyId, companyId)))
        .limit(1);
      if (!sale) return res.status(404).json({ message: "Retail sale not found" });
      let customerName = "Walk-in";
      if (body.customerId) {
        const [customer] = await db
          .select({ legalName: customers.legalName })
          .from(customers)
          .where(
            and(eq(customers.id, body.customerId), eq(customers.companyId, companyId), isNull(customers.deletedAt))
          )
          .limit(1);
        if (!customer) return res.status(404).json({ message: "Customer not found" });
        customerName = customer.legalName;
      }
      await db
        .update(retailPosSales)
        .set({ customerId: body.customerId, customerName, updatedAt: new Date() })
        .where(and(eq(retailPosSales.id, saleId), eq(retailPosSales.companyId, companyId)));
      res.json(await loadSaleResponse(companyId, saleId));
    } catch (error) {
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}

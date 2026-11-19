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
  retailPosPayments,
  retailPosSaleItems,
  retailPosSales,
  retailProductVariants,
  retailProducts,
} from "@shared/schema";
import { requireAuth } from "../../auth";
import { db } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
import { loadSaleResponse } from "../../services/retail/retailSaleService";
import { ensureCompanyLocation, requireRetailCompany } from "./retailPosContext";
import { registerRetailCustomerRoutesPart1 } from "./registerRetailCustomerRoutesPart1";

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
  // retail_pos_sales.id is a PostgreSQL 32-bit integer. A scanned 13-digit
  // item barcode in the receipt field must never be sent as a sale ID.
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= 2147483647 ? parsed : null;
}

export function registerRetailCustomerRoutes(app: Express): void {
  registerRetailCustomerRoutesPart1(app);

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
        .select({ id: retailPosSales.id, customerId: retailPosSales.customerId })
        .from(retailPosSales)
        .where(and(eq(retailPosSales.id, saleId), eq(retailPosSales.companyId, companyId)))
        .limit(1);
      if (!sale) return res.status(404).json({ message: "Retail sale not found" });
      // Customer receivable journal entries are immutable. Once a sale has posted to the
      // customer's ledger (an on-account tender, or a refund credited to their account),
      // changing its customer needs a supervised reversal/repost, not a name update.
      if (body.customerId !== sale.customerId) {
        const [creditTender] = await db
          .select({ id: retailPosPayments.id })
          .from(retailPosPayments)
          .where(
            and(
              eq(retailPosPayments.companyId, companyId),
              eq(retailPosPayments.saleId, saleId),
              inArray(retailPosPayments.method, ["credit", "store_credit"])
            )
          )
          .limit(1);
        if (creditTender)
          return res.status(409).json({
            code: "RETAIL_CREDIT_CUSTOMER_LOCKED",
            message: "Cannot change the customer on a posted credit sale; use an accounting reversal instead",
          });
      }
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

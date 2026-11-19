// Extracted from ./retailCustomerRoutes.ts
import type { Express } from "express";
import { and, desc, eq, inArray, isNull, or } from "drizzle-orm";
import { z } from "zod";
import {
  customers,
  retailPosReturnItems,
  retailPosReturns,
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
import { getCustomerBalance } from "../../storage/accounting/customer-balances";
import { customerService } from "../customers/customerService";
import { getCustomerAuditActor } from "../customers/customerRequestContext";
import { requireRetailCompany } from "./retailPosContext";

const customerCreateSchema = z.object({
  legalName: z.string().trim().min(1).max(240),
  phone: z.string().trim().max(60).optional(),
});

export function registerRetailCustomerRoutesPart1(app: Express) {
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

  /** Signed balance from the canonical ERP customer ledger (debit = amount owed). */
  app.get("/api/pos/retail/customers/:id/balance", requireAuth, async (req, res) => {
    try {
      const companyId = await requireRetailCompany(req, res);
      if (!companyId) return;
      const customerId = Number(req.params.id);
      if (!Number.isInteger(customerId) || customerId <= 0) {
        return res.status(400).json({ message: "Invalid customer" });
      }
      const [owned] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(and(eq(customers.id, customerId), eq(customers.companyId, companyId), isNull(customers.deletedAt)))
        .limit(1);
      if (!owned) return res.status(404).json({ message: "Customer not found" });
      res.json({ customerId, balance: await getCustomerBalance(customerId, companyId) });
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
      // Use the canonical ERP creation path so the customer and their
      // Accounts Receivable ledger are created and linked atomically.
      // Retail POS users are authorized here by requireRetailCompany; they
      // do not need access to Accounting -> Parties to add a customer.
      const customer = await customerService.create(
        companyId,
        {
          legalName: body.legalName,
          phone: body.phone?.trim() || null,
          openingBalance: "0",
          openingBalanceSide: "Dr",
          active: true,
        },
        getCustomerAuditActor(req)
      );
      res.status(201).json({
        id: customer.id,
        code: customer.code,
        legalName: customer.legalName,
        phone: customer.phone,
        active: customer.active,
      });
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
}

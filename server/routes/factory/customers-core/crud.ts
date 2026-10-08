/**
 * factoryCustomersRoutes: FactoryCustomerCrud endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  customerOrders,
  customerBalances,
  customers,
  insertCustomerSchema,
  ledgerAccounts,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { eq, and, asc, desc, sql, inArray, isNull, or } from "drizzle-orm";
import { postedVoucherInCompany } from "../../../storage/accounting/customer-ledger-balance";
import type Decimal from "decimal.js";
import { signedOpeningBalance, toMoney } from "../../../lib/money";
import { registerFactoryDaybookRoutes } from "../factoryDaybookRoutes";

export function registerFactoryCustomerCrudRoutes(app: Express) {
  registerFactoryDaybookRoutes(app);
  app.get("/api/factory/customers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const allCustomers = await db
        .select()
        .from(customers)
        .where(and(eq(customers.companyId, companyId), sql`${customers.deletedAt} IS NULL`))
        .orderBy(asc(customers.legalName));

      if (allCustomers.length === 0) {
        return res.json([]);
      }

      const customerIds = allCustomers.map((c) => c.id);

      // ── Balance calculation — mirrors the statement endpoint exactly ──────────
      // The statement runs a ledger: opening + Σ(customerBalances debit-credit),
      // with INVOICE rows for FINALIZED orders corrected to the live grandTotal.
      // We replicate that here in two bulk queries so both pages always agree.

      // 1. Net of ALL customerBalances rows (includes INVOICE type as stored)
      const cbNetRows = await db
        .select({
          customerId: customerBalances.customerId,
          net: sql<string>`COALESCE(SUM(CAST(${customerBalances.debitAmount} AS numeric) - CAST(${customerBalances.creditAmount} AS numeric)), 0)`,
        })
        .from(customerBalances)
        .where(and(inArray(customerBalances.customerId, customerIds), eq(customerBalances.companyId, companyId)))
        .groupBy(customerBalances.customerId);

      // 2. Correction for INVOICE rows: replace stored debitAmount with the live
      //    grandTotal of FINALIZED orders (same correction the statement makes).
      const invCorrRows = await db
        .select({
          customerId: customerBalances.customerId,
          correction: sql<string>`COALESCE(SUM(CAST(${customerOrders.grandTotal} AS numeric) - CAST(${customerBalances.debitAmount} AS numeric)), 0)`,
        })
        .from(customerBalances)
        .innerJoin(
          customerOrders,
          and(
            eq(customerOrders.id, customerBalances.referenceId),
            eq(customerOrders.companyId, companyId),
            eq(customerOrders.status, "FINALIZED")
          )
        )
        .where(
          and(
            inArray(customerBalances.customerId, customerIds),
            eq(customerBalances.companyId, companyId),
            sql`${customerBalances.referenceType} = 'INVOICE'`
          )
        )
        .groupBy(customerBalances.customerId);

      // Fetch net voucher entries — two passes to match what the statement page shows:
      // 1. Entries linked via the customer's ledgerAccountId
      // 2. Entries linked directly via customerId (e.g. receipt vouchers)
      // Exclude CHARGE-* vouchers: those amounts are already in salesTotal via grandTotal.
      const ledgerAccountIds = allCustomers.filter((c) => c.ledgerAccountId).map((c) => c.ledgerAccountId!);

      // net = debit - credit in Dr-positive convention (customer is an asset / receivable)
      const voucherNetByLedger = new Map<number, Decimal>();
      if (ledgerAccountIds.length > 0) {
        const voucherNetRows = await db
          .select({
            ledgerAccountId: voucherEntries.ledgerAccountId,
            net: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric) - CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
          })
          .from(voucherEntries)
          .innerJoin(
            vouchers,
            and(
              eq(voucherEntries.voucherId, vouchers.id),
              postedVoucherInCompany(companyId),
              sql`${vouchers.voucherNumber} NOT LIKE 'CHARGE-%'`,
              sql`${vouchers.voucherNumber} NOT LIKE 'INV-%'`
            )
          )
          .where(inArray(voucherEntries.ledgerAccountId, ledgerAccountIds))
          .groupBy(voucherEntries.ledgerAccountId);

        for (const row of voucherNetRows) {
          if (row.ledgerAccountId) {
            voucherNetByLedger.set(row.ledgerAccountId, toMoney(row.net));
          }
        }
      }

      // Net from entries tagged with the customer: with no ledger for any
      // customer, and on any ledger for a customer with no linked ledger (the
      // shared rule in storage/accounting/customer-ledger-balance.ts, which the
      // statement endpoint applies too).
      const unlinkedCustomerIds = allCustomers.filter((c) => !c.ledgerAccountId).map((c) => c.id);
      const voucherNetByCustomerId = new Map<number, Decimal>();
      if (customerIds.length > 0) {
        const directRows = await db
          .select({
            customerId: voucherEntries.customerId,
            net: sql<string>`COALESCE(SUM(CAST(${voucherEntries.debitAmount} AS numeric) - CAST(${voucherEntries.creditAmount} AS numeric)), 0)`,
          })
          .from(voucherEntries)
          .innerJoin(
            vouchers,
            and(
              eq(voucherEntries.voucherId, vouchers.id),
              postedVoucherInCompany(companyId),
              sql`${vouchers.voucherNumber} NOT LIKE 'CHARGE-%'`,
              sql`${vouchers.voucherNumber} NOT LIKE 'INV-%'`
            )
          )
          .where(
            and(
              inArray(voucherEntries.customerId, customerIds),
              unlinkedCustomerIds.length > 0
                ? or(isNull(voucherEntries.ledgerAccountId), inArray(voucherEntries.customerId, unlinkedCustomerIds))
                : isNull(voucherEntries.ledgerAccountId)
            )
          )
          .groupBy(voucherEntries.customerId);

        for (const row of directRows) {
          if (row.customerId) {
            voucherNetByCustomerId.set(row.customerId, toMoney(row.net));
          }
        }
      }

      const cbNetMap = new Map(cbNetRows.map((r) => [r.customerId, toMoney(r.net)]));
      const invCorrMap = new Map(invCorrRows.map((r) => [r.customerId, toMoney(r.correction)]));

      const customersWithBalances = allCustomers.map((customer) => {
        const ledgerNet = customer.ledgerAccountId ? voucherNetByLedger.get(customer.ledgerAccountId) : undefined;
        const totalBalance = signedOpeningBalance(customer.openingBalance, customer.openingBalanceSide || "Dr")
          .plus(cbNetMap.get(customer.id) ?? 0)
          .plus(invCorrMap.get(customer.id) ?? 0)
          .plus(ledgerNet ?? 0)
          .plus(voucherNetByCustomerId.get(customer.id) ?? 0);
        return {
          ...customer,
          balance: totalBalance.abs().toNumber(),
          balanceSide: totalBalance.isNegative() && !totalBalance.isZero() ? "Cr" : "Dr",
        };
      });

      res.json(customersWithBalances);
    } catch (error: unknown) {
      logger.error("Error fetching factory customers:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/factory/customers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const dataWithCompany = { ...req.body, companyId };
      const parsed = insertCustomerSchema.parse(dataWithCompany);
      if (parsed.ledgerAccountId !== undefined) {
        const [linkedLedger] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.id, parsed.ledgerAccountId), eq(ledgerAccounts.companyId, companyId)))
          .limit(1);
        if (!linkedLedger) {
          return res.status(400).json({ message: "Linked ledger account must belong to the customer company" });
        }
      }

      let suffix = 1;
      const allExisting = await db.select().from(customers).where(eq(customers.companyId, companyId));

      const existingCodes = allExisting
        .map((c) => c.code)
        .filter((c) => c.startsWith("CUST"))
        .map((c) => parseInt(c.replace("CUST", "")))
        .filter((n) => !isNaN(n));

      if (existingCodes.length > 0) {
        suffix = Math.max(...existingCodes) + 1;
      }
      let code = `CUST${suffix.toString().padStart(3, "0")}`;

      let codeExists = true;
      while (codeExists) {
        const [dup] = await db
          .select()
          .from(customers)
          .where(and(eq(customers.code, code), eq(customers.companyId, companyId)));
        if (dup) {
          suffix++;
          code = `CUST${suffix.toString().padStart(3, "0")}`;
        } else {
          codeExists = false;
        }
      }

      const [customer] = await db
        .insert(customers)
        .values({ ...parsed, code })
        .returning();

      res.status(201).json(customer);
    } catch (error: unknown) {
      logger.error("Error creating factory customer:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.put("/api/factory/customers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customer ID" });

      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const [existing] = await db.select().from(customers).where(eq(customers.id, customerId));
      if (!existing) return res.status(404).json({ message: "Customer not found" });
      if (existing.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

      if (req.body.code && req.body.code !== existing.code) {
        const [dup] = await db
          .select()
          .from(customers)
          .where(and(eq(customers.code, req.body.code), eq(customers.companyId, companyId)));
        if (dup) return res.status(400).json({ message: "Customer code already exists" });
      }

      const parsed = insertCustomerSchema.partial().parse(req.body);
      if (parsed.ledgerAccountId !== undefined) {
        const [linkedLedger] = await db
          .select({ id: ledgerAccounts.id })
          .from(ledgerAccounts)
          .where(and(eq(ledgerAccounts.id, parsed.ledgerAccountId), eq(ledgerAccounts.companyId, companyId)))
          .limit(1);
        if (!linkedLedger) {
          return res.status(400).json({ message: "Linked ledger account must belong to the customer company" });
        }
      }
      const [updated] = await db.update(customers).set(parsed).where(eq(customers.id, customerId)).returning();

      res.json(updated);
    } catch (error: unknown) {
      logger.error("Error updating factory customer:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  app.delete("/api/factory/customers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customer ID" });

      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const [existing] = await db.select().from(customers).where(eq(customers.id, customerId));
      if (!existing) return res.status(404).json({ message: "Customer not found" });
      if (existing.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

      const [deleted] = await db
        .update(customers)
        .set({ deletedAt: new Date() })
        .where(eq(customers.id, customerId))
        .returning();

      res.json(deleted);
    } catch (error: unknown) {
      logger.error("Error deleting factory customer:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // RESTORE DELETED CUSTOMER
  app.post("/api/factory/customers/:id/restore", requireAuth, async (req: Request, res: Response) => {
    try {
      const customerId = parseInt(req.params.id);
      if (isNaN(customerId)) return res.status(400).json({ message: "Invalid customer ID" });
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const [existing] = await db.select().from(customers).where(eq(customers.id, customerId));
      if (!existing) return res.status(404).json({ message: "Customer not found" });
      if (existing.companyId !== companyId) return res.status(403).json({ message: "Access denied" });

      const [restored] = await db
        .update(customers)
        .set({ deletedAt: null })
        .where(eq(customers.id, customerId))
        .returning();

      res.json(restored);
    } catch (error: unknown) {
      logger.error("Error restoring factory customer:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });

  // LIST DELETED CUSTOMERS
  app.get("/api/factory/customers/deleted", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const deletedCustomers = await db
        .select()
        .from(customers)
        .where(and(eq(customers.companyId, companyId), sql`${customers.deletedAt} IS NOT NULL`))
        .orderBy(desc(customers.deletedAt));

      res.json(deletedCustomers);
    } catch (error: unknown) {
      logger.error("Error fetching deleted factory customers:", { error: error });
      res.status(400).json({ message: getErrorMessage(error) });
    }
  });
}

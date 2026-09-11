/**
 * deletedItemsRoutes: DeletedItemsList endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth, requireNonPOS } from "../../../auth";
import {
  factoryCategories,
  factoryBaleProducts,
  factoryContainers,
  factoryRawStock,
  factoryRawMaterialAdjustments,
  factoryMixBatches,
  factoryBales,
  customerProformas,
  customerOrders,
  stockItems,
  stockGroups,
  bankAccounts,
  vouchers,
  suppliers,
  customers,
  locations,
  employees,
  ledgerAccounts,
} from "@shared/schema";
import { eq, and, or, desc, isNull, isNotNull } from "drizzle-orm";

export function registerDeletedItemsListRoutes(app: Express) {
  // Get all deleted items (soft-deleted records)
  app.get("/api/deleted-items", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      // Get deleted locations
      const deletedLocations = await db
        .select()
        .from(locations)
        .where(and(eq(locations.companyId, companyId), isNotNull(locations.deletedAt)))
        .orderBy(desc(locations.deletedAt));

      // Get deleted stock items
      const deletedStockItems = await db
        .select()
        .from(stockItems)
        .where(and(eq(stockItems.companyId, companyId), isNotNull(stockItems.deletedAt)))
        .orderBy(desc(stockItems.deletedAt));

      // Get deleted stock groups
      const deletedStockGroups = await db
        .select()
        .from(stockGroups)
        .where(and(eq(stockGroups.companyId, companyId), isNotNull(stockGroups.deletedAt)))
        .orderBy(desc(stockGroups.deletedAt));

      // Get deleted ledger accounts
      const deletedLedgerAccounts = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.companyId, companyId), isNotNull(ledgerAccounts.deletedAt)))
        .orderBy(desc(ledgerAccounts.deletedAt));

      // Get deleted employees
      const deletedEmployees = await db
        .select()
        .from(employees)
        .where(and(eq(employees.companyId, companyId), isNotNull(employees.deletedAt)))
        .orderBy(desc(employees.deletedAt));

      // Get deleted customers
      const deletedCustomers = await db
        .select()
        .from(customers)
        .where(and(eq(customers.companyId, companyId), isNotNull(customers.deletedAt)))
        .orderBy(desc(customers.deletedAt));

      // Note: Vouchers are not included in deleted items because they are hard-deleted
      // with inventory reversal due to complex business logic. They cannot be recovered.

      // Get deleted suppliers (suppliers are global, not company-specific)
      const deletedSuppliers = await db
        .select()
        .from(suppliers)
        .where(isNotNull(suppliers.deletedAt))
        .orderBy(desc(suppliers.deletedAt));

      // Get deleted bank accounts
      const deletedBankAccounts = await db
        .select()
        .from(bankAccounts)
        .where(and(eq(bankAccounts.companyId, companyId), isNotNull(bankAccounts.deletedAt)))
        .orderBy(desc(bankAccounts.deletedAt));

      // Get deleted vouchers (payments, receipts, journals, stock transfers, POS sales, etc.)
      const deletedVouchers = await db
        .select()
        .from(vouchers)
        .where(and(eq(vouchers.companyId, companyId), isNotNull(vouchers.deletedAt)))
        .orderBy(desc(vouchers.deletedAt));

      // === Wave 1: Factory + Customer Order soft-deleted records ===
      const [
        deletedFactoryCategories,
        deletedFactoryBaleProducts,
        deletedFactoryContainers,
        deletedFactoryRawStock,
        deletedFactoryRawMaterialAdjustments,
        deletedFactoryMixBatches,
        deletedFactoryBales,
        deletedCustomerProformas,
        deletedCustomerOrders,
      ] = await Promise.all([
        db
          .select()
          .from(factoryCategories)
          .where(and(eq(factoryCategories.companyId, companyId), isNotNull(factoryCategories.deletedAt)))
          .orderBy(desc(factoryCategories.deletedAt)),
        db
          .select()
          .from(factoryBaleProducts)
          .where(and(eq(factoryBaleProducts.companyId, companyId), isNotNull(factoryBaleProducts.deletedAt)))
          .orderBy(desc(factoryBaleProducts.deletedAt)),
        db
          .select()
          .from(factoryContainers)
          .where(and(eq(factoryContainers.companyId, companyId), isNotNull(factoryContainers.deletedAt)))
          .orderBy(desc(factoryContainers.deletedAt)),
        db
          .select()
          .from(factoryRawStock)
          .where(and(eq(factoryRawStock.companyId, companyId), isNotNull(factoryRawStock.deletedAt)))
          .orderBy(desc(factoryRawStock.deletedAt)),
        db
          .select()
          .from(factoryRawMaterialAdjustments)
          .where(
            and(
              eq(factoryRawMaterialAdjustments.companyId, companyId),
              isNotNull(factoryRawMaterialAdjustments.deletedAt)
            )
          )
          .orderBy(desc(factoryRawMaterialAdjustments.deletedAt)),
        db
          .select()
          .from(factoryMixBatches)
          .where(and(eq(factoryMixBatches.companyId, companyId), isNotNull(factoryMixBatches.deletedAt)))
          .orderBy(desc(factoryMixBatches.deletedAt)),
        db
          .select()
          .from(factoryBales)
          .where(and(eq(factoryBales.companyId, companyId), isNotNull(factoryBales.deletedAt)))
          .orderBy(desc(factoryBales.deletedAt)),
        db
          .select()
          .from(customerProformas)
          .where(and(eq(customerProformas.companyId, companyId), isNotNull(customerProformas.deletedAt)))
          .orderBy(desc(customerProformas.deletedAt)),
        db
          .select()
          .from(customerOrders)
          .where(and(eq(customerOrders.companyId, companyId), isNotNull(customerOrders.deletedAt)))
          .orderBy(desc(customerOrders.deletedAt)),
      ]);

      // Get orphaned POS sales - vouchers with locationId pointing to deleted or non-existent locations
      // Wrap in try-catch to prevent breaking the entire endpoint if this query fails
      let orphanedPosSales: {
        id: number;
        voucherNumber: string;
        voucherType: string;
        date: string;
        totalAmount: string;
        locationId: number | null;
        locationName: string | null;
        locationDeletedAt: Date | null;
      }[] = [];
      try {
        orphanedPosSales = await db
          .select({
            id: vouchers.id,
            voucherNumber: vouchers.voucherNumber,
            voucherType: vouchers.voucherType,
            date: vouchers.voucherDate,
            totalAmount: vouchers.totalAmount,
            locationId: vouchers.locationId,
            locationName: locations.name,
            locationDeletedAt: locations.deletedAt,
          })
          .from(vouchers)
          .leftJoin(locations, eq(vouchers.locationId, locations.id))
          .where(
            and(
              eq(vouchers.companyId, companyId),
              isNull(vouchers.deletedAt),
              isNotNull(vouchers.locationId),
              or(
                isNull(locations.name), // Location doesn't exist (null from left join)
                isNotNull(locations.deletedAt) // Location is soft-deleted
              )
            )
          )
          .orderBy(desc(vouchers.voucherDate));
      } catch (err) {
        logger.error("Error fetching orphaned POS sales:", { error: err });
        orphanedPosSales = [];
      }

      res.json({
        locations: deletedLocations.map((l) => ({
          id: l.id,
          type: "location",
          name: l.name,
          code: l.code,
          deletedAt: l.deletedAt,
        })),
        stockItems: deletedStockItems.map((s) => ({
          id: s.id,
          type: "stockItem",
          name: s.name,
          code: s.code,
          deletedAt: s.deletedAt,
        })),
        stockGroups: deletedStockGroups.map((g) => ({
          id: g.id,
          type: "stockGroup",
          name: g.name,
          code: g.code,
          deletedAt: g.deletedAt,
        })),
        ledgerAccounts: deletedLedgerAccounts.map((a) => ({
          id: a.id,
          type: "ledgerAccount",
          name: a.name,
          code: a.code,
          accountType: a.accountType,
          deletedAt: a.deletedAt,
        })),
        employees: deletedEmployees.map((e) => ({
          id: e.id,
          type: "employee",
          name: `${e.firstName} ${e.lastName}`,
          code: e.code,
          deletedAt: e.deletedAt,
        })),
        customers: deletedCustomers.map((c) => ({
          id: c.id,
          type: "customer",
          name: c.legalName,
          code: c.code,
          deletedAt: c.deletedAt,
        })),
        suppliers: deletedSuppliers.map((s) => ({
          id: s.id,
          type: "supplier",
          name: s.legalName,
          code: s.code,
          deletedAt: s.deletedAt,
        })),
        bankAccounts: deletedBankAccounts.map((b) => ({
          id: b.id,
          type: "bankAccount",
          name: b.name,
          code: b.code,
          deletedAt: b.deletedAt,
        })),
        vouchers: deletedVouchers.map((v) => ({
          id: v.id,
          type: "voucher",
          name: v.voucherNumber || "Unknown Voucher",
          code: v.voucherType || "-",
          voucherType: v.voucherType,
          amount: v.totalAmount != null ? Number(v.totalAmount) : 0,
          date: v.voucherDate,
          locationName: v.locationName || null,
          deletedAt: v.deletedAt,
        })),
        orphanedPosSales: (orphanedPosSales || []).map((v) => ({
          id: v.id,
          type: "orphanedPosSale",
          name: v.voucherNumber || "Unknown Voucher",
          code: v.voucherType || "-",
          amount: v.totalAmount != null ? Number(v.totalAmount) : 0,
          date: v.date != null ? v.date : null,
          locationName: v.locationName ? `${v.locationName} (Deleted)` : "(Location Missing)",
          deletedAt: v.locationDeletedAt != null ? v.locationDeletedAt : v.date != null ? v.date : null,
        })),
        // Wave 1
        factoryCategories: deletedFactoryCategories.map((r) => ({
          id: r.id,
          type: "factoryCategory",
          name: r.name,
          code: r.id.toString(),
          deletedAt: r.deletedAt,
        })),
        factoryBaleProducts: deletedFactoryBaleProducts.map((r) => ({
          id: r.id,
          type: "factoryBaleProduct",
          name: r.name,
          code: r.articleCode || r.code || "-",
          deletedAt: r.deletedAt,
        })),
        factoryContainers: deletedFactoryContainers.map((r) => ({
          id: r.id,
          type: "factoryContainer",
          name: r.containerNumber || `Container #${r.id}`,
          code: r.containerNumber || "-",
          deletedAt: r.deletedAt,
        })),
        factoryRawStock: deletedFactoryRawStock.map((r) => ({
          id: r.id,
          type: "factoryRawStock",
          name: `Raw stock receipt #${r.id}`,
          code: String(r.id),
          deletedAt: r.deletedAt,
        })),
        factoryRawMaterialAdjustments: deletedFactoryRawMaterialAdjustments.map((r) => ({
          id: r.id,
          type: "factoryRawMaterialAdjustment",
          name: `${r.type || "Adj"} ${r.kg || 0} kg`,
          code: String(r.id),
          deletedAt: r.deletedAt,
        })),
        factoryMixBatches: deletedFactoryMixBatches.map((r) => ({
          id: r.id,
          type: "factoryMixBatch",
          name: r.batchCode || `Mix batch #${r.id}`,
          code: r.batchCode || "-",
          deletedAt: r.deletedAt,
        })),
        factoryBales: deletedFactoryBales.map((r) => ({
          id: r.id,
          type: "factoryBale",
          name: r.baleCode || r.referenceNumber || `Bale #${r.id}`,
          code: r.baleCode || "-",
          deletedAt: r.deletedAt,
        })),
        customerProformas: deletedCustomerProformas.map((r) => ({
          id: r.id,
          type: "customerProforma",
          name: r.name || `Proforma #${r.id}`,
          code: r.name || "-",
          deletedAt: r.deletedAt,
        })),
        customerOrders: deletedCustomerOrders.map((r) => ({
          id: r.id,
          type: "customerOrder",
          name: r.invoiceNumber || `Order #${r.id}`,
          code: r.invoiceNumber || "DRAFT",
          amount: r.grandTotal != null ? Number(r.grandTotal) : 0,
          deletedAt: r.deletedAt,
        })),
        totalCount:
          deletedLocations.length +
          deletedStockItems.length +
          deletedStockGroups.length +
          deletedVouchers.length +
          deletedLedgerAccounts.length +
          deletedEmployees.length +
          deletedCustomers.length +
          deletedSuppliers.length +
          deletedBankAccounts.length +
          (orphanedPosSales || []).length +
          deletedFactoryCategories.length +
          deletedFactoryBaleProducts.length +
          deletedFactoryContainers.length +
          deletedFactoryRawStock.length +
          deletedFactoryRawMaterialAdjustments.length +
          deletedFactoryMixBatches.length +
          deletedFactoryBales.length +
          deletedCustomerProformas.length +
          deletedCustomerOrders.length,
      });
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

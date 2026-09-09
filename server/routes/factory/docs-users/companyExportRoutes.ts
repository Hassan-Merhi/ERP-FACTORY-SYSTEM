/**
 * factoryDocsUsersRoutes: FactoryCompanyExport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { getClientDate } from "../../../lib/dateUtils";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth } from "../../../auth";
import {
  factorySuppliers,
  factoryCategories,
  factoryBaleProducts,
  factoryContainers,
  factoryRawStock,
  factoryMixBatches,
  factoryMixBatchSources,
  factoryDailyUsages,
  factoryPressingBatches,
  factoryBales,
  factoryBaleSequences,
  factoryContainerCommissions,
  stockItems,
  stockGroups,
  customerProformas,
  customerProformaLines,
  customerOrders,
  customerOrderLines,
  customerOrderBales,
  customerOrderCharges,
  customerInvoiceSequences,
  customerBalances,
  customers,
  ledgerAccounts,
  voucherEntries,
  locations,
  factoryFxRates,
  factoryDaybookEntries,
  factoryDaybookEntryEdits,
  factoryDutyAuditLog,
  factoryOffloadAdditionalCharges,
  companySettings,
  factorySettings,
  factoryWorkers,
  factoryPayrolls,
  factoryWorkerDocuments,
  factoryAlerts,
  factoryWasteEntries,
  factoryBalePhotos,
  factoryDailyKpiSnapshots,
  factorySupplierScoreSnapshots,
  factoryBaleCostSnapshots,
  factoryContainerProfitSnapshots,
  bankAccounts,
  inventory,
  exchangeRates,
  vouchers,
} from "@shared/schema";
import { eq, inArray } from "drizzle-orm";
import type { CompanyScopedTable } from "../../../types/companyScopedTable";

export function registerFactoryCompanyExportRoutes(app: Express) {
  app.get("/api/factory/export-company-data", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = req.session.factoryCompanyId || req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      // CompanyScopedTable constrains the argument to a table that actually
      // carries a companyId column, so a table without one is a compile error
      // rather than a silently unscoped export.
      const byCompany = (table: CompanyScopedTable) => eq(table.companyId, companyId);

      const data: Record<string, unknown[]> = {};

      data.locations = await db.select().from(locations).where(byCompany(locations));
      data.ledger_accounts = await db.select().from(ledgerAccounts).where(byCompany(ledgerAccounts));
      data.bank_accounts = await db.select().from(bankAccounts).where(byCompany(bankAccounts));
      data.stock_groups = await db.select().from(stockGroups).where(byCompany(stockGroups));
      data.stock_items = await db.select().from(stockItems).where(byCompany(stockItems));
      data.inventory = await db.select().from(inventory).where(byCompany(inventory));
      data.company_settings = await db.select().from(companySettings).where(eq(companySettings.companyId, companyId));
      data.exchange_rates = await db.select().from(exchangeRates).where(byCompany(exchangeRates));
      data.customers = await db.select().from(customers).where(byCompany(customers));
      data.customer_balances = await db.select().from(customerBalances).where(byCompany(customerBalances));
      const voucherRows = await db.select().from(vouchers).where(byCompany(vouchers));
      data.vouchers = voucherRows;

      const voucherIds = voucherRows.map((v) => v.id);
      if (voucherIds.length > 0) {
        data.voucher_entries = await db
          .select()
          .from(voucherEntries)
          .where(inArray(voucherEntries.voucherId, voucherIds));
      } else {
        data.voucher_entries = [];
      }

      data.factory_settings = await db.select().from(factorySettings).where(eq(factorySettings.companyId, companyId));
      data.factory_suppliers = await db.select().from(factorySuppliers).where(byCompany(factorySuppliers));
      data.factory_categories = await db.select().from(factoryCategories).where(byCompany(factoryCategories));
      data.factory_bale_products = await db.select().from(factoryBaleProducts).where(byCompany(factoryBaleProducts));
      data.factory_fx_rates = await db.select().from(factoryFxRates).where(byCompany(factoryFxRates));
      data.factory_bale_sequences = await db
        .select()
        .from(factoryBaleSequences)
        .where(eq(factoryBaleSequences.companyId, companyId));
      data.factory_containers = await db.select().from(factoryContainers).where(byCompany(factoryContainers));
      data.factory_raw_stock = await db.select().from(factoryRawStock).where(byCompany(factoryRawStock));
      data.factory_container_commissions = await db
        .select()
        .from(factoryContainerCommissions)
        .where(byCompany(factoryContainerCommissions));
      data.factory_offload_additional_charges = await db
        .select()
        .from(factoryOffloadAdditionalCharges)
        .where(byCompany(factoryOffloadAdditionalCharges));
      data.factory_duty_audit_log = await db.select().from(factoryDutyAuditLog).where(byCompany(factoryDutyAuditLog));
      const mixBatchRows = await db.select().from(factoryMixBatches).where(byCompany(factoryMixBatches));
      data.factory_mix_batches = mixBatchRows;

      const mixBatchIds = mixBatchRows.map((b) => b.id);
      if (mixBatchIds.length > 0) {
        data.factory_mix_batch_sources = await db
          .select()
          .from(factoryMixBatchSources)
          .where(inArray(factoryMixBatchSources.mixBatchId, mixBatchIds));
        data.factory_daily_usages = await db
          .select()
          .from(factoryDailyUsages)
          .where(inArray(factoryDailyUsages.mixBatchId, mixBatchIds));
      } else {
        data.factory_mix_batch_sources = [];
        data.factory_daily_usages = [];
      }

      data.factory_pressing_batches = await db
        .select()
        .from(factoryPressingBatches)
        .where(byCompany(factoryPressingBatches));
      data.factory_bales = await db.select().from(factoryBales).where(byCompany(factoryBales));
      data.factory_workers = await db.select().from(factoryWorkers).where(byCompany(factoryWorkers));
      data.factory_payrolls = await db.select().from(factoryPayrolls).where(byCompany(factoryPayrolls));
      data.factory_worker_documents = await db
        .select()
        .from(factoryWorkerDocuments)
        .where(byCompany(factoryWorkerDocuments));
      const daybookRows = await db.select().from(factoryDaybookEntries).where(byCompany(factoryDaybookEntries));
      data.factory_daybook_entries = daybookRows;

      const daybookIds = daybookRows.map((e) => e.id);
      if (daybookIds.length > 0) {
        data.factory_daybook_entry_edits = await db
          .select()
          .from(factoryDaybookEntryEdits)
          .where(inArray(factoryDaybookEntryEdits.daybookEntryId, daybookIds));
      } else {
        data.factory_daybook_entry_edits = [];
      }

      data.factory_waste_entries = await db.select().from(factoryWasteEntries).where(byCompany(factoryWasteEntries));
      data.factory_bale_photos = await db.select().from(factoryBalePhotos).where(byCompany(factoryBalePhotos));
      data.factory_alerts = await db.select().from(factoryAlerts).where(byCompany(factoryAlerts));
      data.factory_daily_kpi_snapshots = await db
        .select()
        .from(factoryDailyKpiSnapshots)
        .where(byCompany(factoryDailyKpiSnapshots));
      data.factory_supplier_score_snapshots = await db
        .select()
        .from(factorySupplierScoreSnapshots)
        .where(byCompany(factorySupplierScoreSnapshots));
      data.factory_bale_cost_snapshots = await db
        .select()
        .from(factoryBaleCostSnapshots)
        .where(byCompany(factoryBaleCostSnapshots));
      data.factory_container_profit_snapshots = await db
        .select()
        .from(factoryContainerProfitSnapshots)
        .where(byCompany(factoryContainerProfitSnapshots));

      const proformaRows = await db.select().from(customerProformas).where(byCompany(customerProformas));
      data.customer_proformas = proformaRows;
      const proformaIds = proformaRows.map((p) => p.id);
      if (proformaIds.length > 0) {
        data.customer_proforma_lines = await db
          .select()
          .from(customerProformaLines)
          .where(inArray(customerProformaLines.proformaId, proformaIds));
      } else {
        data.customer_proforma_lines = [];
      }

      data.customer_invoice_sequences = await db
        .select()
        .from(customerInvoiceSequences)
        .where(eq(customerInvoiceSequences.companyId, companyId));
      const orderRows = await db.select().from(customerOrders).where(byCompany(customerOrders));
      data.customer_orders = orderRows;
      const orderIds = orderRows.map((o) => o.id);
      if (orderIds.length > 0) {
        data.customer_order_lines = await db
          .select()
          .from(customerOrderLines)
          .where(inArray(customerOrderLines.orderId, orderIds));
        data.customer_order_bales = await db
          .select()
          .from(customerOrderBales)
          .where(inArray(customerOrderBales.orderId, orderIds));
        data.customer_order_charges = await db
          .select()
          .from(customerOrderCharges)
          .where(inArray(customerOrderCharges.orderId, orderIds));
      } else {
        data.customer_order_lines = [];
        data.customer_order_bales = [];
        data.customer_order_charges = [];
      }

      const exportPayload = {
        version: 1,
        sourceCompanyId: companyId,
        exportedAt: new Date().toISOString(),
        tables: data,
      };

      const jsonStr = JSON.stringify(exportPayload, null, 2);
      res.setHeader("Content-Type", "application/json");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="company_${companyId}_export_${getClientDate(req)}.json"`
      );
      res.send(jsonStr);
    } catch (error: unknown) {
      logger.error("Export company data error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

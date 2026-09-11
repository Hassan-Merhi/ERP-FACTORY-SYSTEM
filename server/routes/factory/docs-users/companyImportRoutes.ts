/**
 * factoryDocsUsersRoutes: FactoryCompanyImport endpoints.
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
import { eq, sql } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

type DynamicTable = PgTable & { id: PgColumn };
type ImportRow = Record<string, unknown> & { id?: number };
type CompanyExportPayload = { sourceCompanyId: number; tables: Record<string, ImportRow[]> };

/** Export payloads are untyped JSON, so a row object cannot be checked against the target
 *  table's insert type — the payload format itself is validated before import starts. */
const asDynamicInsert = (rec: ImportRow): never => rec as never;
/** `inserted.id` is `unknown` when the table is only known as a dynamic `PgTable`. */
const insertedIdOf = (inserted: { id: unknown } | undefined): number | null =>
  inserted && typeof inserted.id === "number" ? inserted.id : null;

export function registerFactoryCompanyImportRoutes(app: Express) {
  app.post("/api/factory/import-company-data", requireAuth, async (req: Request, res: Response) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 200 * 1024 * 1024 } });

      upload.single("file")(req, res, async (err) => {
        if (err) return res.status(400).json({ message: "File upload error: " + err.message });
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        try {
          const targetCompanyId = req.session.currentCompanyId;
          if (!targetCompanyId) return res.status(400).json({ message: "No company selected" });

          const jsonStr = req.file.buffer.toString("utf-8");
          let payload: CompanyExportPayload;
          try {
            payload = JSON.parse(jsonStr) as CompanyExportPayload;
          } catch {
            return res.status(400).json({ message: "Uploaded file is not valid JSON" });
          }

          if (!payload || typeof payload !== "object" || !payload.tables || !payload.sourceCompanyId) {
            return res.status(400).json({ message: "Invalid export file format" });
          }

          if (payload.sourceCompanyId === targetCompanyId) {
            return res.status(400).json({
              message: "Cannot import into the same company that was exported. Switch to a different company first.",
            });
          }

          const [existingBales] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(factoryBales)
            .where(eq(factoryBales.companyId, targetCompanyId));
          const [existingContainers] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(factoryContainers)
            .where(eq(factoryContainers.companyId, targetCompanyId));
          const [existingVouchers] = await db
            .select({ count: sql<number>`count(*)::int` })
            .from(vouchers)
            .where(eq(vouchers.companyId, targetCompanyId));
          if (
            (existingBales?.count || 0) > 0 ||
            (existingContainers?.count || 0) > 0 ||
            (existingVouchers?.count || 0) > 0
          ) {
            return res.status(400).json({
              message:
                "Target company already has data (bales, containers, or vouchers). Import should only be done on a new/empty company to avoid duplicates.",
            });
          }

          await db.delete(factorySettings).where(eq(factorySettings.companyId, targetCompanyId));
          await db.delete(factoryBaleSequences).where(eq(factoryBaleSequences.companyId, targetCompanyId));
          await db.delete(customerInvoiceSequences).where(eq(customerInvoiceSequences.companyId, targetCompanyId));
          await db.delete(companySettings).where(eq(companySettings.companyId, targetCompanyId));

          const t = payload.tables;
          const summary: Record<string, number> = {};
          let totalRecords = 0;
          const importSuffix = `_C${targetCompanyId}`;

          const remap: Record<string, Map<number, number>> = {};
          const initRemap = (key: string) => {
            remap[key] = new Map();
          };
          const r = (key: string, oldId: number | null | undefined): number | null => {
            if (oldId == null) return null;
            const mapped = remap[key]?.get(oldId);
            return mapped ?? null;
          };

          async function makeUniqueCode(
            tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
            table: DynamicTable,
            field: PgColumn,
            baseValue: string
          ): Promise<string> {
            const [existing] = await tx.select({ id: table.id }).from(table).where(eq(field, baseValue)).limit(1);
            if (!existing) return baseValue;
            const attempt = baseValue + importSuffix;
            const [existing2] = await tx.select({ id: table.id }).from(table).where(eq(field, attempt)).limit(1);
            if (!existing2) return attempt;
            let counter = 2;
            while (counter < 1000) {
              const val = `${baseValue}${importSuffix}_${counter}`;
              const [ex] = await tx.select({ id: table.id }).from(table).where(eq(field, val)).limit(1);
              if (!ex) return val;
              counter++;
            }
            return baseValue + importSuffix + "_" + Date.now();
          }

          const tables = [
            "locations",
            "ledger_accounts",
            "bank_accounts",
            "stock_groups",
            "stock_items",
            "inventory",
            "company_settings",
            "exchange_rates",
            "customers",
            "customer_balances",
            "factory_settings",
            "factory_suppliers",
            "factory_categories",
            "factory_bale_products",
            "factory_fx_rates",
            "factory_bale_sequences",
            "factory_containers",
            "factory_raw_stock",
            "factory_container_commissions",
            "factory_offload_additional_charges",
            "factory_duty_audit_log",
            "factory_daily_usages",
            "factory_mix_batches",
            "factory_mix_batch_sources",
            "factory_pressing_batches",
            "factory_bales",
            "factory_workers",
            "factory_payrolls",
            "factory_worker_documents",
            "factory_daybook_entries",
            "factory_daybook_entry_edits",
            "factory_waste_entries",
            "factory_bale_photos",
            "factory_alerts",
            "factory_daily_kpi_snapshots",
            "factory_supplier_score_snapshots",
            "factory_bale_cost_snapshots",
            "factory_container_profit_snapshots",
            "customer_proformas",
            "customer_proforma_lines",
            "customer_invoice_sequences",
            "customer_orders",
            "customer_order_lines",
            "customer_order_bales",
            "customer_order_charges",
            "vouchers",
            "voucher_entries",
          ];
          tables.forEach(initRemap);

          const dateFieldNames = new Set([
            "createdAt",
            "updatedAt",
            "deletedAt",
            "offloadedAt",
            "pressedAt",
            "finalizedAt",
            "paidAt",
            "generatedAt",
            "approvedAt",
            "uploadedAt",
            "editedAt",
            "readAt",
            "logoUpdatedAt",
            "verifiedAt",
            "loadingStartedAt",
            "loadingFinalizedAt",
            "lastUpdated",
          ]);
          function fixDates(rec: ImportRow): ImportRow {
            for (const key of Object.keys(rec)) {
              if (rec[key] == null) continue;
              if (dateFieldNames.has(key) && typeof rec[key] === "string") {
                rec[key] = new Date(rec[key]);
              }
            }
            return rec;
          }

          await db.transaction(async (tx) => {
            async function insertAndMap(
              tableName: string,
              drizzleTable: DynamicTable,
              rows: ImportRow[],
              fkRemaps: Record<string, string>,
              opts?: { hasCompanyId?: boolean; nullifyFields?: string[] }
            ) {
              const hasCompanyId = opts?.hasCompanyId !== false;
              const nullifyFields = opts?.nullifyFields || [];
              let count = 0;
              for (const row of rows) {
                const oldId = row.id;
                const rec = fixDates({ ...row });
                delete rec.id;
                if (hasCompanyId) rec.companyId = targetCompanyId;
                for (const [fkField, remapKey] of Object.entries(fkRemaps)) {
                  rec[fkField] = r(remapKey, rec[fkField] as number | null | undefined);
                }
                for (const field of nullifyFields) {
                  rec[field] = null;
                }
                const [inserted] = await tx.insert(drizzleTable).values(rec).returning({ id: drizzleTable.id });
                const insertedId = insertedIdOf(inserted);
                if (insertedId != null && oldId != null) {
                  remap[tableName].set(oldId, insertedId);
                }
                count++;
              }
              summary[tableName] = count;
              totalRecords += count;
            }

            async function insertSelfReferencing(
              tableName: string,
              drizzleTable: DynamicTable,
              rows: ImportRow[],
              parentField: string,
              fkRemaps: Record<string, string>,
              opts?: { hasCompanyId?: boolean }
            ) {
              const hasCompanyId = opts?.hasCompanyId !== false;
              const roots = rows.filter((r) => r[parentField] == null);
              const children = rows.filter((r) => r[parentField] != null);
              let count = 0;

              for (const row of roots) {
                const oldId = row.id;
                const rec = fixDates({ ...row });
                delete rec.id;
                if (hasCompanyId) rec.companyId = targetCompanyId;
                rec[parentField] = null;
                for (const [fkField, remapKey] of Object.entries(fkRemaps)) {
                  rec[fkField] = r(remapKey, rec[fkField] as number | null | undefined);
                }
                const [inserted] = await tx.insert(drizzleTable).values(rec).returning({ id: drizzleTable.id });
                const insertedId = insertedIdOf(inserted);
                if (insertedId != null && oldId != null) remap[tableName].set(oldId, insertedId);
                count++;
              }

              let remaining = [...children];
              let maxPasses = 20;
              while (remaining.length > 0 && maxPasses > 0) {
                const nextRemaining: ImportRow[] = [];
                for (const row of remaining) {
                  const parentMapped = r(tableName, row[parentField] as number | null | undefined);
                  if (parentMapped != null) {
                    const oldId = row.id;
                    const rec = fixDates({ ...row });
                    delete rec.id;
                    if (hasCompanyId) rec.companyId = targetCompanyId;
                    rec[parentField] = parentMapped;
                    for (const [fkField, remapKey] of Object.entries(fkRemaps)) {
                      rec[fkField] = r(remapKey, rec[fkField] as number | null | undefined);
                    }
                    const [inserted] = await tx.insert(drizzleTable).values(rec).returning({ id: drizzleTable.id });
                    const insertedId = insertedIdOf(inserted);
                    if (insertedId != null && oldId != null) remap[tableName].set(oldId, insertedId);
                    count++;
                  } else {
                    nextRemaining.push(row);
                  }
                }
                remaining = nextRemaining;
                maxPasses--;
              }

              if (remaining.length > 0) {
                for (const row of remaining) {
                  const oldId = row.id;
                  const rec = fixDates({ ...row });
                  delete rec.id;
                  if (hasCompanyId) rec.companyId = targetCompanyId;
                  rec[parentField] = null;
                  for (const [fkField, remapKey] of Object.entries(fkRemaps)) {
                    rec[fkField] = r(remapKey, rec[fkField] as number | null | undefined);
                  }
                  const [inserted] = await tx.insert(drizzleTable).values(rec).returning({ id: drizzleTable.id });
                  const insertedId = insertedIdOf(inserted);
                  if (insertedId != null && oldId != null) remap[tableName].set(oldId, insertedId);
                  count++;
                }
              }

              summary[tableName] = count;
              totalRecords += count;
            }

            if (t.locations?.length) {
              for (const row of t.locations) {
                const oldId = row.id;
                const rec = fixDates({ ...row });
                delete rec.id;
                rec.companyId = targetCompanyId;
                rec.code = await makeUniqueCode(tx, locations, locations.code, String(rec.code));
                const [inserted] = await tx.insert(locations).values(asDynamicInsert(rec)).returning({ id: locations.id });
                if (inserted && oldId != null) remap["locations"].set(oldId, inserted.id);
              }
              summary["locations"] = t.locations.length;
              totalRecords += t.locations.length;
            }

            if (t.ledger_accounts?.length) {
              await insertSelfReferencing("ledger_accounts", ledgerAccounts, t.ledger_accounts, "parentId", {});
            }

            if (t.bank_accounts?.length) {
              for (const row of t.bank_accounts) {
                const oldId = row.id;
                const rec = fixDates({ ...row });
                delete rec.id;
                rec.companyId = targetCompanyId;
                rec.linkedLedgerId = r("ledger_accounts", rec.linkedLedgerId as number | null | undefined);
                rec.code = await makeUniqueCode(tx, bankAccounts, bankAccounts.code, String(rec.code));
                const [inserted] = await tx.insert(bankAccounts).values(asDynamicInsert(rec)).returning({ id: bankAccounts.id });
                if (inserted && oldId != null) remap["bank_accounts"].set(oldId, inserted.id);
              }
              summary["bank_accounts"] = t.bank_accounts.length;
              totalRecords += t.bank_accounts.length;
            }

            if (t.stock_groups?.length) {
              await insertSelfReferencing("stock_groups", stockGroups, t.stock_groups, "parentId", {});
            }

            if (t.stock_items?.length) {
              await insertAndMap("stock_items", stockItems, t.stock_items, { stockGroupId: "stock_groups" });
            }

            if (t.inventory?.length) {
              await insertAndMap("inventory", inventory, t.inventory, {
                locationId: "locations",
                stockItemId: "stock_items",
              });
            }

            if (t.company_settings?.length) {
              await insertAndMap("company_settings", companySettings, t.company_settings, {
                parentCreditAccountId: "ledger_accounts",
              });
            }

            if (t.exchange_rates?.length) {
              await insertAndMap("exchange_rates", exchangeRates, t.exchange_rates, {});
            }

            if (t.customers?.length) {
              await insertAndMap("customers", customers, t.customers, { ledgerAccountId: "ledger_accounts" });
            }

            if (t.customer_balances?.length) {
              await insertAndMap("customer_balances", customerBalances, t.customer_balances, {
                customerId: "customers",
              });
            }

            if (t.factory_settings?.length) {
              await insertAndMap("factory_settings", factorySettings, t.factory_settings, {});
            }

            if (t.factory_suppliers?.length) {
              await insertAndMap("factory_suppliers", factorySuppliers, t.factory_suppliers, {});
            }

            if (t.factory_categories?.length) {
              await insertAndMap("factory_categories", factoryCategories, t.factory_categories, {});
            }

            if (t.factory_bale_products?.length) {
              await insertAndMap("factory_bale_products", factoryBaleProducts, t.factory_bale_products, {
                categoryId: "factory_categories",
              });
            }

            if (t.factory_fx_rates?.length) {
              await insertAndMap("factory_fx_rates", factoryFxRates, t.factory_fx_rates, {});
            }

            if (t.factory_bale_sequences?.length) {
              await insertAndMap("factory_bale_sequences", factoryBaleSequences, t.factory_bale_sequences, {});
            }

            if (t.factory_containers?.length) {
              await insertAndMap("factory_containers", factoryContainers, t.factory_containers, {
                supplierId: "factory_suppliers",
                freightAccountId: "ledger_accounts",
                otherChargesAccountId: "ledger_accounts",
                dutyAccountId: "ledger_accounts",
              });
            }

            if (t.factory_raw_stock?.length) {
              await insertAndMap("factory_raw_stock", factoryRawStock, t.factory_raw_stock, {
                containerId: "factory_containers",
              });
            }

            if (t.factory_container_commissions?.length) {
              await insertAndMap(
                "factory_container_commissions",
                factoryContainerCommissions,
                t.factory_container_commissions,
                {
                  containerId: "factory_containers",
                  ledgerAccountId: "ledger_accounts",
                }
              );
            }

            if (t.factory_offload_additional_charges?.length) {
              await insertAndMap(
                "factory_offload_additional_charges",
                factoryOffloadAdditionalCharges,
                t.factory_offload_additional_charges,
                {
                  containerId: "factory_containers",
                  ledgerAccountId: "ledger_accounts",
                }
              );
            }

            if (t.factory_duty_audit_log?.length) {
              await insertAndMap(
                "factory_duty_audit_log",
                factoryDutyAuditLog,
                t.factory_duty_audit_log,
                {
                  containerId: "factory_containers",
                },
                { nullifyFields: ["updatedByUserId"] }
              );
            }

            if (t.factory_mix_batches?.length) {
              await insertAndMap("factory_mix_batches", factoryMixBatches, t.factory_mix_batches, {
                carryForwardFromId: "factory_mix_batches",
              });
            }

            if (t.factory_mix_batch_sources?.length) {
              await insertAndMap(
                "factory_mix_batch_sources",
                factoryMixBatchSources,
                t.factory_mix_batch_sources,
                {
                  mixBatchId: "factory_mix_batches",
                  containerId: "factory_containers",
                  supplierId: "factory_suppliers",
                  sourceBatchId: "factory_mix_batches",
                },
                { hasCompanyId: false }
              );
            }

            if (t.factory_daily_usages?.length) {
              await insertAndMap("factory_daily_usages", factoryDailyUsages, t.factory_daily_usages, {
                mixBatchId: "factory_mix_batches",
              });
            }

            if (t.factory_pressing_batches?.length) {
              await insertAndMap(
                "factory_pressing_batches",
                factoryPressingBatches,
                t.factory_pressing_batches,
                {
                  mixBatchId: "factory_mix_batches",
                  productId: "factory_bale_products",
                  finalizedLocationId: "locations",
                },
                { nullifyFields: ["createdBy"] }
              );
            }

            if (t.factory_bales?.length) {
              await insertAndMap(
                "factory_bales",
                factoryBales,
                t.factory_bales,
                {
                  mixBatchId: "factory_mix_batches",
                  productId: "factory_bale_products",
                  pressingBatchId: "factory_pressing_batches",
                  erpLocationId: "locations",
                },
                { nullifyFields: ["finalizedBy"] }
              );
            }

            if (t.factory_workers?.length) {
              await insertAndMap("factory_workers", factoryWorkers, t.factory_workers, {});
            }

            if (t.factory_payrolls?.length) {
              await insertAndMap(
                "factory_payrolls",
                factoryPayrolls,
                t.factory_payrolls,
                {
                  workerId: "factory_workers",
                  cashAccountId: "ledger_accounts",
                },
                { nullifyFields: ["approvedBy"] }
              );
            }

            if (t.factory_worker_documents?.length) {
              await insertAndMap("factory_worker_documents", factoryWorkerDocuments, t.factory_worker_documents, {
                workerId: "factory_workers",
              });
            }

            if (t.factory_daybook_entries?.length) {
              await insertAndMap(
                "factory_daybook_entries",
                factoryDaybookEntries,
                t.factory_daybook_entries,
                {},
                { nullifyFields: ["createdBy"] }
              );
            }

            if (t.factory_daybook_entry_edits?.length) {
              await insertAndMap(
                "factory_daybook_entry_edits",
                factoryDaybookEntryEdits,
                t.factory_daybook_entry_edits,
                {
                  daybookEntryId: "factory_daybook_entries",
                },
                { hasCompanyId: false, nullifyFields: ["editedBy"] }
              );
            }

            if (t.factory_waste_entries?.length) {
              await insertAndMap(
                "factory_waste_entries",
                factoryWasteEntries,
                t.factory_waste_entries,
                {
                  mixBatchId: "factory_mix_batches",
                  supplierId: "factory_suppliers",
                  containerId: "factory_containers",
                },
                { nullifyFields: ["createdBy"] }
              );
            }

            if (t.factory_bale_photos?.length) {
              await insertAndMap(
                "factory_bale_photos",
                factoryBalePhotos,
                t.factory_bale_photos,
                {
                  baleId: "factory_bales",
                },
                { nullifyFields: ["uploadedBy"] }
              );
            }

            if (t.factory_alerts?.length) {
              await insertAndMap("factory_alerts", factoryAlerts, t.factory_alerts, {});
            }

            if (t.customer_proformas?.length) {
              await insertAndMap("customer_proformas", customerProformas, t.customer_proformas, {
                customerId: "customers",
              });
            }

            if (t.customer_proforma_lines?.length) {
              await insertAndMap(
                "customer_proforma_lines",
                customerProformaLines,
                t.customer_proforma_lines,
                {
                  proformaId: "customer_proformas",
                },
                { hasCompanyId: false }
              );
            }

            if (t.customer_invoice_sequences?.length) {
              await insertAndMap(
                "customer_invoice_sequences",
                customerInvoiceSequences,
                t.customer_invoice_sequences,
                {}
              );
            }

            if (t.customer_orders?.length) {
              await insertAndMap(
                "customer_orders",
                customerOrders,
                t.customer_orders,
                {
                  customerId: "customers",
                  proformaIdUsed: "customer_proformas",
                  locationId: "locations",
                },
                { nullifyFields: ["verifiedByUserId"] }
              );
            }

            if (t.customer_order_lines?.length) {
              await insertAndMap(
                "customer_order_lines",
                customerOrderLines,
                t.customer_order_lines,
                {
                  orderId: "customer_orders",
                },
                { hasCompanyId: false }
              );
            }

            if (t.customer_order_bales?.length) {
              await insertAndMap(
                "customer_order_bales",
                customerOrderBales,
                t.customer_order_bales,
                {
                  orderId: "customer_orders",
                  baleId: "factory_bales",
                  locationId: "locations",
                },
                { hasCompanyId: false }
              );
            }

            if (t.customer_order_charges?.length) {
              await insertAndMap(
                "customer_order_charges",
                customerOrderCharges,
                t.customer_order_charges,
                {
                  orderId: "customer_orders",
                },
                { hasCompanyId: false }
              );
            }

            if (t.vouchers?.length) {
              for (const row of t.vouchers) {
                const oldId = row.id;
                const rec = fixDates({ ...row });
                delete rec.id;
                rec.companyId = targetCompanyId;
                rec.locationId = r("locations", rec.locationId as number | null | undefined);
                rec.voucherNumber = await makeUniqueCode(tx, vouchers, vouchers.voucherNumber, String(rec.voucherNumber));
                const [inserted] = await tx.insert(vouchers).values(asDynamicInsert(rec)).returning({ id: vouchers.id });
                if (inserted && oldId != null) remap["vouchers"].set(oldId, inserted.id);
              }
              summary["vouchers"] = t.vouchers.length;
              totalRecords += t.vouchers.length;
            }

            if (t.voucher_entries?.length) {
              await insertAndMap(
                "voucher_entries",
                voucherEntries,
                t.voucher_entries,
                {
                  voucherId: "vouchers",
                  ledgerAccountId: "ledger_accounts",
                  bankAccountId: "bank_accounts",
                },
                { hasCompanyId: false, nullifyFields: ["supplierId", "employeeId", "fixedAssetId"] }
              );
            }

            if (t.factory_daily_kpi_snapshots?.length) {
              await insertAndMap(
                "factory_daily_kpi_snapshots",
                factoryDailyKpiSnapshots,
                t.factory_daily_kpi_snapshots,
                {
                  topWorkerId: "factory_workers",
                }
              );
            }

            if (t.factory_supplier_score_snapshots?.length) {
              await insertAndMap(
                "factory_supplier_score_snapshots",
                factorySupplierScoreSnapshots,
                t.factory_supplier_score_snapshots,
                {
                  supplierId: "factory_suppliers",
                }
              );
            }

            if (t.factory_bale_cost_snapshots?.length) {
              await insertAndMap(
                "factory_bale_cost_snapshots",
                factoryBaleCostSnapshots,
                t.factory_bale_cost_snapshots,
                {
                  baleId: "factory_bales",
                }
              );
            }

            if (t.factory_container_profit_snapshots?.length) {
              await insertAndMap(
                "factory_container_profit_snapshots",
                factoryContainerProfitSnapshots,
                t.factory_container_profit_snapshots,
                {
                  containerId: "factory_containers",
                }
              );
            }
          });

          res.json({
            success: true,
            message: `Successfully imported ${totalRecords} records across ${Object.keys(summary).length} tables`,
            totalRecords,
            details: summary,
          });
        } catch (importError: unknown) {
          logger.error("Import company data error:", { error: importError });
          res.status(500).json({ message: "Import failed: " + getErrorMessage(importError) });
        }
      });
    } catch (error: unknown) {
      logger.error("Import company data error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

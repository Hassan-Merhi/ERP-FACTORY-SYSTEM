/**
 * factoryDocsUsersRoutes: FactoryCompanyImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express, Request, Response } from "express";
import { FILE_SIZE_LIMITS } from "@shared/fileSizePolicy";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { db } from "../../../db";
import { requireAuth, requireRole } from "../../../auth";
import { sendStockImportRefusal } from "../../../services/factory/stockImportPolicy";
import {
  customerOrders,
  customerOrderLines,
  customerOrderBales,
  customerOrderCharges,
  voucherEntries,
  factoryDailyKpiSnapshots,
  factorySupplierScoreSnapshots,
  factoryBaleCostSnapshots,
  factoryContainerProfitSnapshots,
  vouchers,
} from "@shared/schema";
import { writeAuditEvent } from "../../../services/audit/auditService";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

export type DynamicTable = PgTable & { id: PgColumn };
export type ImportRow = Record<string, unknown> & { id?: number };
export type CompanyExportPayload = { sourceCompanyId: number; tables: Record<string, ImportRow[]> };

// Split out of this file (phase 19 C) to keep it under the god-file limit.
export { IMPORT_UNBALANCED_VOUCHERS_MESSAGE, unbalancedImportedVouchers } from "./companyImportValidation";
import { companyImportRoutesStep } from "./companyImportRoutesStep";
import { asDynamicInsert } from "./companyImportRoutesHelpers";
import { companyImportRoutesStep2 } from "./companyImportRoutesStep2";
import { companyImportRoutesStep3 } from "./companyImportRoutesStep3";

/** Phase 19 C (F7/DI10): Admin/Owner (Developer passes); the import was sign-in only. */
const adminOrOwner = requireRole("Admin", "Owner");

export function registerFactoryCompanyImportRoutes(app: Express) {
  app.post("/api/factory/import-company-data", requireAuth, adminOrOwner, async (req: Request, res: Response) => {
    try {
      const multer = (await import("multer")).default;
      const upload = multer({
        storage: multer.memoryStorage(),
        limits: { fileSize: FILE_SIZE_LIMITS.privilegedSpreadsheetImport, files: 1 },
      });

      upload.single("file")(req, res, async (err) => {
        if (err)
          return res.status(err.code === "LIMIT_FILE_SIZE" ? 413 : 400).json({
            code: err.code === "LIMIT_FILE_SIZE" ? "UPLOAD_FILE_TOO_LARGE" : "INVALID_UPLOAD",
            message:
              err.code === "LIMIT_FILE_SIZE"
                ? "Company data import exceeds the 100 MB administrator limit"
                : "File upload error: " + err.message,
          });
        if (!req.file) return res.status(400).json({ message: "No file uploaded" });

        try {
          const ci1 = await companyImportRoutesStep({ req, res });
          if (ci1.done) return ci1.value;
          const { t, fixDates, targetCompanyId, makeUniqueCode, remap, summary, payload, r } = ci1;

          await db.transaction(async (tx) => {
            const ci2 = await companyImportRoutesStep2({ tx, ci1, r });
            const { insertAndMap } = ci2;
            await companyImportRoutesStep3({ ci1, ci2 });

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
                rec.voucherNumber = await makeUniqueCode(
                  tx,
                  vouchers,
                  vouchers.voucherNumber,
                  String(rec.voucherNumber)
                );
                const [inserted] = await tx
                  .insert(vouchers)
                  .values(asDynamicInsert(rec))
                  .returning({ id: vouchers.id });
                if (inserted && oldId != null) remap["vouchers"].set(oldId, inserted.id);
              }
              summary["vouchers"] = t.vouchers.length;
              ci1.totalRecords += t.vouchers.length;
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
            // Audited inside the import transaction (wave 12): no audit row, no import.
            await writeAuditEvent(
              {
                userId: req.session.userId,
                username: req.session.username || "unknown",
                companyId: targetCompanyId,
                action: "import",
                tableName: "companies",
                recordId: targetCompanyId,
                recordIdentifier: "company-data-import",
                changes: {
                  sourceCompanyId: { new: payload.sourceCompanyId },
                  fileName: { new: req.file?.originalname ?? null },
                  totalRecords: { new: ci1.totalRecords },
                  tables: { new: summary },
                },
              },
              tx
            );
          });

          res.json({
            success: true,
            message: `Successfully imported ${ci1.totalRecords} records across ${Object.keys(summary).length} tables`,
            totalRecords: ci1.totalRecords,
            details: summary,
          });
        } catch (importError: unknown) {
          if (sendStockImportRefusal(res, importError)) return;
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

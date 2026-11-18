// Extracted from ./companyImportRoutes.ts: a stage of companyImportRoutes.
import { db } from "../../../db";
import { factoryContainers, factoryBales, vouchers } from "@shared/schema";
import { eq, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { unbalancedImportedVouchers, IMPORT_UNBALANCED_VOUCHERS_MESSAGE } from "./companyImportValidation";
import type { Request, Response } from "express";
import type { CompanyExportPayload, DynamicTable, ImportRow } from "./companyImportRoutes";

export async function companyImportRoutesStep({ req, res }: { req: Request; res: Response }) {
  const targetCompanyId = req.session.currentCompanyId;
  if (!targetCompanyId) return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };

  const jsonStr = req.file.buffer.toString("utf-8");
  let payload: CompanyExportPayload;
  try {
    payload = JSON.parse(jsonStr) as CompanyExportPayload;
  } catch {
    return { done: true as const, value: res.status(400).json({ message: "Uploaded file is not valid JSON" }) };
  }

  if (!payload || typeof payload !== "object" || !payload.tables || !payload.sourceCompanyId) {
    return { done: true as const, value: res.status(400).json({ message: "Invalid export file format" }) };
  }

  if (payload.sourceCompanyId === targetCompanyId) {
    return {
      done: true as const,
      value: res.status(400).json({
        message: "Cannot import into the same company that was exported. Switch to a different company first.",
      }),
    };
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
  if ((existingBales?.count || 0) > 0 || (existingContainers?.count || 0) > 0 || (existingVouchers?.count || 0) > 0) {
    return {
      done: true as const,
      value: res.status(400).json({
        message:
          "Target company already has data (bales, containers, or vouchers). Import should only be done on a new/empty company to avoid duplicates.",
      }),
    };
  }

  // Wave 12: every posted voucher in the file must balance. The balance
  // guard would refuse them at commit anyway (an imported voucher is never
  // history, whatever created_at the file carries), and the file has no stock
  // adjustment documents, so a one-sided stock voucher is refused as well.
  const unbalancedVouchers = unbalancedImportedVouchers(payload.tables);
  if (unbalancedVouchers.length > 0) {
    return {
      done: true as const,
      value: res.status(400).json({
        message: IMPORT_UNBALANCED_VOUCHERS_MESSAGE,
        code: "IMPORT_UNBALANCED_VOUCHERS",
        vouchers: unbalancedVouchers.slice(0, 50),
        count: unbalancedVouchers.length,
      }),
    };
  }

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

  return {
    done: false as const,
    targetCompanyId,
    payload,
    t,
    summary,
    totalRecords,
    remap,
    r,
    makeUniqueCode,
    fixDates,
  };
}

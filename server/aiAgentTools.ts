/**
 * AI Agent Tool Registry
 *
 * Defines all tools available to the AI Command Center. Each tool declares:
 *  - type: "read" (safe, runs immediately) | "draft" (builds preview, needs approval) | "write" (requires approval)
 *  - requiresApproval: true → creates an ai_agent_approvals row before executing
 *
 * runTool() is the single entry point — routes call it with companyId + tool name + params.
 */

import { db } from "./db";
import { getErrorMessage } from "./lib/httpHandlers";
import * as schema from "@shared/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import {
  searchStockItems,
  searchSuppliers,
  searchCustomers,
  searchLedgerAccounts,
  searchVouchers,
  getLowStockItems,
  getPricingHealth,
  getBusinessSummary,
} from "./aiTools";
import { lineAmount, plusMoney, toMoney } from "./lib/money";

export type ToolType = "read" | "draft" | "write";

export interface ToolDef {
  name: string;
  label: string;
  description: string;
  type: ToolType;
  requiresApproval: boolean;
  paramSchema?: Record<string, string>;
}

export interface ToolResult {
  ok: boolean;
  data?: unknown;
  error?: string;
  requiresApproval?: boolean;
  previewJson?: unknown;
  payloadJson?: unknown;
  actionType?: string;
  actionLabel?: string;
}

// ── Registry (also drives the AI plan prompt) ─────────────────────────────────

export const TOOL_REGISTRY: ToolDef[] = [
  // ── Read tools ─────────────────────────────────────────────────────────────
  {
    name: "searchStockItems",
    label: "Search Stock Items",
    description: "Search stock items by name or code and show current quantities",
    type: "read",
    requiresApproval: false,
    paramSchema: { query: "Search term (name or code)" },
  },
  {
    name: "searchSuppliers",
    label: "Search Suppliers",
    description: "Search suppliers by name or code and show contact info",
    type: "read",
    requiresApproval: false,
    paramSchema: { query: "Supplier name or code" },
  },
  {
    name: "searchCustomers",
    label: "Search Customers",
    description: "Search customers by name or code",
    type: "read",
    requiresApproval: false,
    paramSchema: { query: "Customer name or code" },
  },
  {
    name: "searchLedgerAccounts",
    label: "Search Ledger Accounts",
    description: "Search accounting/ledger accounts by name or code",
    type: "read",
    requiresApproval: false,
    paramSchema: { query: "Account name or code" },
  },
  {
    name: "searchVouchers",
    label: "Search Vouchers",
    description: "Search vouchers and transactions by description or voucher number",
    type: "read",
    requiresApproval: false,
    paramSchema: { query: "Voucher description or number" },
  },
  {
    name: "validateItemCodes",
    label: "Validate Item Codes",
    description: "Check which item codes exist in the ERP system (useful before imports)",
    type: "read",
    requiresApproval: false,
    paramSchema: { codes: "Comma-separated list of item codes to validate" },
  },
  {
    name: "getBusinessAlerts",
    label: "Get Business Alerts",
    description: "Get today & month sales summary, low-stock alerts, and pricing health",
    type: "read",
    requiresApproval: false,
  },
  {
    name: "validateImportJob",
    label: "Validate Import Job",
    description: "Check the status and validation results of an AI import job",
    type: "read",
    requiresApproval: false,
    paramSchema: { jobId: "AI import job ID" },
  },

  // ── Draft tools — build a preview row and request human approval ───────────
  {
    name: "prepareVoucherDraft",
    label: "Prepare Voucher Draft",
    description: "Build a journal / receipt / payment voucher and request approval before posting",
    type: "draft",
    requiresApproval: true,
    paramSchema: {
      voucherType: "Receipt | Payment | Journal",
      date: "YYYY-MM-DD",
      description: "Voucher memo",
      debitAccountId: "Debit ledger account ID",
      creditAccountId: "Credit ledger account ID",
      amount: "Decimal amount",
    },
  },
  {
    name: "preparePurchaseOrderDraft",
    label: "Prepare Purchase Order Draft",
    description: "Build a purchase order for a supplier and request approval before creating",
    type: "draft",
    requiresApproval: true,
    paramSchema: {
      supplierId: "Supplier ID",
      description: "PO description or reference",
      items: "JSON array of {stockItemId, quantity, rate}",
    },
  },
  {
    name: "preparePriceUpdateDraft",
    label: "Prepare Price Update Draft",
    description: "Build a batch selling-price update and request approval before applying",
    type: "draft",
    requiresApproval: true,
    paramSchema: {
      updates: "JSON array of {stockItemId, newSellingPrice}",
    },
  },
  {
    name: "prepareStockAdjustmentDraft",
    label: "Prepare Stock Adjustment Draft",
    description: "Prepare an inventory quantity adjustment and request approval before posting",
    type: "draft",
    requiresApproval: true,
    paramSchema: {
      stockItemId: "Stock item ID",
      locationId: "Warehouse/location ID",
      quantity: "Quantity delta (positive = add, negative = remove)",
      reason: "Reason for adjustment",
    },
  },
  {
    name: "compareExcelFiles",
    label: "Compare Excel Datasets",
    description: "Compare two uploaded Excel files and report differences (items added, removed, changed)",
    type: "read",
    requiresApproval: false,
    paramSchema: {
      description: "What comparison to perform",
    },
  },
];

export const TOOL_REGISTRY_MAP = new Map(TOOL_REGISTRY.map((t) => [t.name, t]));

// ── Executor ──────────────────────────────────────────────────────────────────

export async function runTool(
  companyId: number,
  _userId: string,
  toolName: string,
  params: Record<string, unknown>
): Promise<ToolResult> {
  try {
    switch (toolName) {
      // ── Read tools ────────────────────────────────────────────────────────
      case "searchStockItems": {
        const items = await searchStockItems(companyId, String(params.query || ""), 15);
        return { ok: true, data: { items, count: items.length } };
      }

      case "searchSuppliers": {
        const suppliers = await searchSuppliers(companyId, String(params.query || ""), 15);
        return { ok: true, data: { suppliers, count: suppliers.length } };
      }

      case "searchCustomers": {
        const customers = await searchCustomers(companyId, String(params.query || ""), 15);
        return { ok: true, data: { customers, count: customers.length } };
      }

      case "searchLedgerAccounts": {
        const accounts = await searchLedgerAccounts(companyId, String(params.query || ""), 15);
        return { ok: true, data: { accounts, count: accounts.length } };
      }

      case "searchVouchers": {
        const vouchers = await searchVouchers(companyId, String(params.query || ""), 20);
        return { ok: true, data: { vouchers, count: vouchers.length } };
      }

      case "validateItemCodes": {
        const rawCodes = String(params.codes || "")
          .split(/[,\n;]/)
          .map((c) => c.trim())
          .filter(Boolean);

        if (rawCodes.length === 0) {
          return { ok: true, data: { valid: [], invalid: [], message: "No codes provided" } };
        }

        const found = await db
          .select({
            id: schema.stockItems.id,
            code: schema.stockItems.code,
            name: schema.stockItems.name,
          })
          .from(schema.stockItems)
          .where(
            and(
              eq(schema.stockItems.companyId, companyId),
              eq(schema.stockItems.active, true),
              isNull(schema.stockItems.deletedAt),
              inArray(schema.stockItems.code, rawCodes)
            )
          );

        const foundCodes = new Set(found.map((f) => f.code));
        return {
          ok: true,
          data: {
            valid: found.map((f) => ({ code: f.code, name: f.name, id: f.id })),
            invalid: rawCodes.filter((c) => !foundCodes.has(c)),
            totalChecked: rawCodes.length,
            validCount: found.length,
            invalidCount: rawCodes.filter((c) => !foundCodes.has(c)).length,
          },
        };
      }

      case "getBusinessAlerts": {
        const [summary, lowStock, pricing] = await Promise.all([
          getBusinessSummary(companyId),
          getLowStockItems(companyId, 10),
          getPricingHealth(companyId, 10),
        ]);
        return {
          ok: true,
          data: {
            today: summary.today,
            thisMonth: summary.thisMonth,
            openPOs: summary.openPurchaseOrders,
            topItems: summary.topItemsThisMonth,
            lowStock,
            pricingIssues: pricing.filter((i) => i.status === "LOSING"),
          },
        };
      }

      case "validateImportJob": {
        const jobId = parseInt(String(params.jobId || "0"), 10);
        if (!jobId) return { ok: false, error: "jobId is required" };

        const [job] = await db
          .select({
            id: schema.aiImportJobs.id,
            status: schema.aiImportJobs.status,
            importType: schema.aiImportJobs.importType,
            totalRows: schema.aiImportJobs.totalRows,
            validRows: schema.aiImportJobs.validRows,
            errorRows: schema.aiImportJobs.errorRows,
          })
          .from(schema.aiImportJobs)
          .where(and(eq(schema.aiImportJobs.id, jobId), eq(schema.aiImportJobs.companyId, companyId)));

        if (!job) return { ok: false, error: `Import job ${jobId} not found` };
        return { ok: true, data: job };
      }

      case "compareExcelFiles": {
        return {
          ok: true,
          data: {
            message:
              "File comparison is available via the AI Import page. Upload both Excel files there to compare datasets.",
            suggestion: "/ai-import",
          },
        };
      }

      // ── Draft tools ───────────────────────────────────────────────────────
      case "prepareVoucherDraft": {
        const preview = {
          voucherType: params.voucherType || "Journal",
          date: params.date || new Date().toISOString().split("T")[0],
          description: params.description || "",
          debitAccountId: params.debitAccountId ?? null,
          creditAccountId: params.creditAccountId ?? null,
          amount: toMoney(String(params.amount ?? "")).toFixed(2),
        };
        return {
          ok: true,
          requiresApproval: true,
          actionType: "post_voucher",
          actionLabel: `Post ${preview.voucherType} voucher — ${preview.description || "No description"} (${preview.amount})`,
          previewJson: preview,
          payloadJson: preview,
          data: { message: "Voucher draft prepared — awaiting your approval." },
        };
      }

      case "preparePurchaseOrderDraft": {
        const items = Array.isArray(params.items) ? params.items : [];
        const totalAmount = items.reduce((s, i) => plusMoney(s, lineAmount(i.rate, i.quantity)), 0);
        const preview = {
          supplierId: params.supplierId ?? null,
          description: params.description || "",
          items,
          totalAmount: totalAmount.toFixed(2),
          itemCount: items.length,
        };
        return {
          ok: true,
          requiresApproval: true,
          actionType: "create_purchase_order",
          actionLabel: `Create Purchase Order — ${items.length} item(s), total ${totalAmount.toFixed(2)}`,
          previewJson: preview,
          payloadJson: preview,
          data: { message: "Purchase order draft prepared — awaiting your approval." },
        };
      }

      case "preparePriceUpdateDraft": {
        const updates = Array.isArray(params.updates) ? params.updates : [];
        const preview = { updates, count: updates.length };
        return {
          ok: true,
          requiresApproval: true,
          actionType: "update_prices",
          actionLabel: `Update selling prices for ${updates.length} item(s)`,
          previewJson: preview,
          payloadJson: preview,
          data: { message: `Price update draft for ${updates.length} items — awaiting your approval.` },
        };
      }

      case "prepareStockAdjustmentDraft": {
        const qty = toMoney(String(params.quantity ?? "")).toNumber();
        const preview = {
          stockItemId: params.stockItemId ?? null,
          locationId: params.locationId ?? null,
          quantity: qty,
          reason: params.reason || "",
        };
        return {
          ok: true,
          requiresApproval: true,
          actionType: "post_stock_adjustment",
          actionLabel: `${qty >= 0 ? "Add" : "Remove"} ${Math.abs(qty)} units${params.reason ? ` — ${params.reason}` : ""}`,
          previewJson: preview,
          payloadJson: preview,
          data: { message: "Stock adjustment draft prepared — awaiting your approval." },
        };
      }

      default:
        return { ok: false, error: `Unknown tool: ${toolName}` };
    }
  } catch (err: unknown) {
    return { ok: false, error: String(getErrorMessage(err) ?? err) };
  }
}

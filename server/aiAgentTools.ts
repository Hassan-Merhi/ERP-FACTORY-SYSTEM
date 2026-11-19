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
import { TOOL_REGISTRY, type ToolResult } from "./aiAgentToolsModel";
export { TOOL_REGISTRY, type ToolType, type ToolDef, type ToolResult } from "./aiAgentToolsModel";

// ── Registry (also drives the AI plan prompt) ─────────────────────────────────

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

// Extracted from ./prompts.ts
import { type AISnapshotData } from "../lib/aiSnapshots";
import { searchStockItems, getStockByLocation, searchSuppliers, searchCustomers, getSalesForItem } from "../aiTools";

// Extract meaningful search keywords from a user message, dropping stop words
export function extractSearchTerm(message: string): string {
  const STOP = new Set([
    "what",
    "how",
    "much",
    "many",
    "is",
    "are",
    "was",
    "were",
    "the",
    "for",
    "about",
    "do",
    "we",
    "have",
    "show",
    "me",
    "find",
    "get",
    "list",
    "all",
    "any",
    "can",
    "you",
    "our",
    "in",
    "at",
    "of",
    "and",
    "or",
    "a",
    "an",
    "to",
    "from",
    "with",
    "this",
    "that",
    "stock",
    "items",
    "item",
    "supply",
    "supplies",
    "customer",
    "customers",
    "supplier",
    "suppliers",
    "voucher",
    "vouchers",
    "account",
    "accounts",
    "inventory",
    "balance",
    "please",
    "tell",
    "give",
    "price",
    "prices",
  ]);
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 4)
    .join(" ");
}

export type ToolDataByIntent = {
  inventory_query: {
    items: Awaited<ReturnType<typeof searchStockItems>>;
    lowStock: AISnapshotData<"low_stock">["items"];
    locationBreakdown: Awaited<ReturnType<typeof getStockByLocation>>;
  };
  supplier_query: {
    suppliers: Awaited<ReturnType<typeof searchSuppliers>>;
    supplierBalances: AISnapshotData<"supplier_balances">["balances"];
  };
  customer_query: {
    customers: Awaited<ReturnType<typeof searchCustomers>>;
  };
  sales_query: {
    summary: AISnapshotData<"business_summary">;
    matchedItems: Awaited<ReturnType<typeof searchStockItems>>;
    salesHistory: Awaited<ReturnType<typeof getSalesForItem>>;
  };
  business_summary: {
    summary: AISnapshotData<"business_summary">;
    lowStock: AISnapshotData<"low_stock">["items"];
    pricingHealth: AISnapshotData<"pricing_health">["items"];
  };
};

export type ToolData = ToolDataByIntent[keyof ToolDataByIntent] | Record<never, never>;

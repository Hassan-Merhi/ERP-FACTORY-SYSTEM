// Extracted from ./aiAgentTools.ts

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

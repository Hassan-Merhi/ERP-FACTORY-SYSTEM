import { z } from "zod";

export interface LedgerAccount {
  id: number;
  code: string;
  name: string;
  accountType: string;
}

export interface BankAccount {
  id: number;
  code: string;
  name: string;
  accountNumber: string;
  bankName: string;
}

export interface Supplier {
  id: number;
  code: string;
  legalName: string;
}

export interface Employee {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
}

export interface FixedAsset {
  id: number;
  assetCode: string;
  assetName: string;
}

export const newEntryRowSchema = z.object({
  accountType: z.enum(["ledger", "bank", "supplier", "employee", "fixedAsset"]),
  accountId: z.number().min(1, "Please select an account"),
  accountName: z.string(),
  debitAmount: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, {
    message: "Must be a valid number",
  }),
  creditAmount: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, {
    message: "Must be a valid number",
  }),
  narration: z.string().optional(),
});

export const createVoucherSchema = z
  .object({
    voucherType: z.enum(["Journal", "Payment", "Receipt", "Stock Transfer", "Sales", "Purchase", "Contra"], {
      error: "Voucher type is required",
    }),
    voucherDate: z.string().min(1, "Voucher date is required"),
    description: z.string().optional(),
    optional: z.boolean().default(false),
    entries: z.array(newEntryRowSchema).min(2, "At least 2 entries required"),
  })
  .refine(
    (data) => {
      const totalDebits = data.entries.reduce((sum, entry) => sum + parseFloat(entry.debitAmount || "0"), 0);
      const totalCredits = data.entries.reduce((sum, entry) => sum + parseFloat(entry.creditAmount || "0"), 0);
      return Math.abs(totalDebits - totalCredits) < 0.01;
    },
    {
      message: "Total debits must equal total credits",
      path: ["entries"],
    }
  );

export type CreateVoucherForm = z.infer<typeof createVoucherSchema>;
export type EditVoucherForm = CreateVoucherForm;

export interface Voucher {
  id: number;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  description: string | null;
  totalAmount: string;
  optional: boolean;
  createdAt: string;
  locationName?: string;
}

export interface OffloadListItem {
  id: number;
  containerId: number;
  containerNumber: string;
  locationId: number;
  locationName: string | null;
  duties: string;
  officeCharges: string;
  transferCharges: string;
  transportFees: string;
  totalCharges: string;
  totalBales: string;
  additionalCostPerBale: string;
  offloadedAt: string;
  itemsTotal: string;
}

export interface OffloadDetail extends OffloadListItem {
  items: Array<{
    id: number;
    stockItemId: number;
    stockItemName: string | null;
    stockItemCode: string | null;
    quantity: string;
    rate: string;
    totalValue: string;
  }>;
}

export type DaybookRow = { _type: "voucher"; data: Voucher } | { _type: "offload"; data: OffloadListItem };

export interface VoucherEntry {
  id: number;
  voucherId: number;
  accountType: string;
  accountId: number;
  accountCode: string;
  accountName: string;
  debitAmount: string;
  creditAmount: string;
  narration: string | null;
  // ── Multi-currency fields (Phase 1) ──────────────────────────────────────
  transactionCurrency?: string | null;
  transactionDebitAmount?: string | null;
  transactionCreditAmount?: string | null;
  baseDebitAmount?: string | null;
  baseCreditAmount?: string | null;
  historicalExchangeRate?: string | null;
  rateConvention?: string | null;
}

export interface ViewVoucherEntry {
  id: number;
  accountName: string;
  debitAmount: string;
  creditAmount: string;
  narration: string | null;
  isStockItem?: boolean;
  stockItemId?: number;
  stockItemCode?: string;
  stockItemName?: string;
  ledgerAccountId?: number;
  bankAccountId?: number;
  employeeId?: number;
  supplierId?: number;
  customerId?: number;
  factorySupplierId?: number;
  isPurchaseItem?: boolean;
  quantity?: string;
  rate?: string;
  totalAmount?: string;
  sellingPrice?: string;
  totalSales?: string;
  costPrice?: string | null;
  profit?: string | null;
  hassansPrice?: string | null;
  hassansProfit?: string | null;
  hassansPercentage?: string | null;
  adjustmentType?: string;
  // ── Multi-currency fields (Phase 1) ──────────────────────────────────────
  /** ISO currency code of the original transaction (e.g. "CFA", "USD"). */
  transactionCurrency?: string | null;
  /** Original transaction-currency debit amount (6 dp). */
  transactionDebitAmount?: string | null;
  /** Original transaction-currency credit amount (6 dp). */
  transactionCreditAmount?: string | null;
  /** Historical base-currency (USD) debit amount (6 dp). */
  baseDebitAmount?: string | null;
  /** Historical base-currency (USD) credit amount (6 dp). */
  baseCreditAmount?: string | null;
  /** Exchange rate at time of posting. */
  historicalExchangeRate?: string | null;
  /** Rate convention (IDENTITY | TRANSACTION_PER_BASE). */
  rateConvention?: string | null;
  /** Present on stock-transfer item rows from /api/vouchers/:id/view-entries. */
  sourceLocationName?: string | null;
}

/** User fields the Daybook surfaces read; ErpRoutes passes its narrow route user. */
export interface DaybookUser {
  role?: string | null;
  currentRole?: string | null;
  canDeleteRecords?: boolean;
}

/** Purchase-order header returned in the view-entries envelope for Purchase vouchers. */
export interface DaybookPurchaseOrderData {
  id: number;
  poNumber: string;
  supplierId: number;
  supplierName: string;
  supplierCode: string;
  containerId: number;
  containerNumber: string;
  currency: string;
  itemsTotal: string | null;
  status: string;
  freight: string | null;
  fumigation: string | null;
  surcharge: string | null;
  documentCharges: string | null;
  otherCharges: string | null;
  discount: string | null;
}

/**
 * /api/vouchers/:id/view-entries returns either a plain row array or, for
 * Purchase vouchers with line items, an `{ entries, purchaseOrder }` envelope.
 */
export interface DaybookViewEntriesEnvelope {
  entries: ViewVoucherEntry[];
  purchaseOrder: DaybookPurchaseOrderData;
}

export type DaybookViewEntriesResponse = ViewVoucherEntry[] | DaybookViewEntriesEnvelope;

/** Stock-transfer detail block returned inside GET /api/vouchers/:id as transferData. */
export interface TransferDetailData {
  id: number;
  voucherId: number;
  sourceLocationId: number | null;
  destinationLocationId: number | null;
  sourceLocationName: string;
  destinationLocationName: string;
  notes: string | null;
  items: Array<{
    id: number;
    stockItemId: number;
    quantity: string;
    rate: string | null;
    totalAmount: string | null;
    stockItemCode?: string;
    stockItemName?: string;
    stockItemUom?: string;
    sourceLocationName?: string;
  }>;
}

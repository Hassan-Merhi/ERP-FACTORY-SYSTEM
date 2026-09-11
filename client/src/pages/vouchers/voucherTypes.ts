import { z } from "zod";

export interface BankAccount {
  id: number;
  accountNumber: string;
  bankName: string;
  accountName: string;
  balance: string;
}

export interface LedgerAccount {
  id: number;
  code: string;
  name: string;
  accountType: string;
}

export interface Supplier {
  id: number;
  code: string;
  legalName: string;
}

export interface Customer {
  id: number;
  code: string;
  legalName: string;
  openingBalance?: string;
}

export interface Employee {
  id: number;
  code: string;
  firstName: string;
  lastName: string;
  openingBalance?: string;
}

export interface FixedAsset {
  id: number;
  code: string;
  name: string;
  openingBalance?: string;
}

export interface FactorySupplierBasic {
  id: number;
  name: string;
  parentId: number | null;
}

export interface StockItem {
  id: number;
  code: string;
  name: string;
  uom: string;
}

export interface Location {
  id: number;
  code?: string;
  name: string;
}

export const voucherEntrySchema = z.object({
  accountType: z.enum(["ledger", "bank", "supplier", "employee", "fixedAsset", "customer", "factorySupplier"]),
  accountId: z.number().min(1, "Please select an account"),
  accountName: z.string(),
  amount: z
    .string()
    .min(1, "Amount required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
      message: "Amount must be a positive number",
    }),
  narration: z.string().optional(),
});

export const voucherFormSchema = z.object({
  paymentAccountType: z.enum(["ledger", "bank", "supplier", "employee", "fixedAsset", "customer", "factorySupplier"]),
  paymentAccountId: z.number().min(1, "Please select an account"),
  paymentAccountName: z.string(),
  voucherDate: z.date(),
  entries: z.array(voucherEntrySchema).min(1, "Add at least one entry"),
  paymentAccountNarration: z.string().optional(),
  notes: z.string().optional(),
  optional: z.boolean().default(false),
});

export type VoucherFormData = z.infer<typeof voucherFormSchema>;

export const journalEntrySchema = z.object({
  type: z.enum(["DR", "CR"]),
  accountType: z.enum(["ledger", "bank", "supplier", "employee", "fixedAsset", "customer", "factorySupplier"]),
  accountId: z.number().min(1, "Please select an account"),
  accountName: z.string(),
  amount: z
    .string()
    .min(1, "Amount required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
      message: "Amount must be a positive number",
    }),
  narration: z.string().optional(),
});

export const journalFormSchema = z.object({
  voucherDate: z.date(),
  entries: z.array(journalEntrySchema).min(1, "Add at least one entry"),
  notes: z.string().optional(),
  optional: z.boolean().default(false),
});

export const stockTransferEntrySchema = z.object({
  sourceLocationId: z.coerce.number(),
  sourceLocationName: z.string(),
  stockItemId: z.coerce.number(),
  stockItemCode: z.string().default(""),
  stockItemName: z.string(),
  quantity: z.string(),
  rate: z.string(),
});

export const stockTransferFormSchema = z.object({
  voucherDate: z.date(),
  destinationLocationId: z.number(),
  entries: z.array(stockTransferEntrySchema),
  notes: z.string().optional(),
  optional: z.boolean().default(false),
});

export const stockAdjustmentEntrySchema = z.object({
  type: z.enum(["CONSUME", "PRODUCE"]),
  stockItemId: z.number().min(1, "Please select a stock item"),
  stockItemCode: z.string().default(""),
  stockItemName: z.string(),
  quantity: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) !== 0, "Quantity cannot be zero"),
  rate: z.string().refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) >= 0, "Rate must be non-negative"),
});

export const stockAdjustmentFormSchema = z.object({
  voucherDate: z.date(),
  locationId: z.number().min(1, "Location required"),
  entries: z.array(stockAdjustmentEntrySchema).min(1, "At least one entry is required"),
  notes: z.string().optional(),
  optional: z.boolean().default(false),
});

export type JournalFormData = z.infer<typeof journalFormSchema>;
export type StockTransferFormData = z.infer<typeof stockTransferFormSchema>;
export type StockAdjustmentFormData = z.infer<typeof stockAdjustmentFormSchema>;

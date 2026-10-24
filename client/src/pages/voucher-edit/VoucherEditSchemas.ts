import { z } from "zod";

export const voucherEntrySchema = z.object({
  id: z.number().optional(),
  accountType: z.enum(["ledger", "bank", "supplier", "employee", "factorySupplier"]),
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

export const journalEntrySchema = z.object({
  id: z.number().optional(),
  type: z.enum(["DR", "CR"]),
  accountType: z.enum(["ledger", "bank", "supplier", "employee", "factorySupplier"]),
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

export const salesLineItemSchema = z.object({
  id: z.number().optional(),
  stockItemId: z.number().min(1, "Please select a stock item"),
  stockItemName: z.string(),
  quantity: z
    .string()
    .min(1, "Quantity required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
      message: "Quantity must be a positive number",
    }),
  sellingPrice: z
    .string()
    .min(1, "Selling price required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
      message: "Selling price must be a positive number",
    }),
});

export const purchaseLineItemSchema = z.object({
  id: z.number().optional(),
  stockItemId: z.number().min(1, "Please select a stock item"),
  stockItemName: z.string(),
  quantity: z
    .string()
    .min(1, "Quantity required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
      message: "Quantity must be a positive number",
    }),
  rate: z
    .string()
    .min(1, "Rate required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
      message: "Rate must be a positive number",
    }),
});

export const adjustmentLineItemSchema = z.object({
  id: z.number().optional(),
  stockItemId: z.number().min(1, "Please select a stock item"),
  stockItemName: z.string(),
  quantity: z
    .string()
    .min(1, "Quantity required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
      message: "Quantity must be a positive number",
    }),
  rate: z
    .string()
    .min(1, "Rate required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
      message: "Rate must be a positive number",
    }),
});

export const transferLineItemSchema = z.object({
  id: z.number().optional(),
  stockItemId: z.number().min(1, "Please select a stock item"),
  stockItemName: z.string(),
  quantity: z
    .string()
    .min(1, "Quantity required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
      message: "Quantity must be a positive number",
    }),
  rate: z
    .string()
    .min(1, "Rate required")
    .refine((val) => !isNaN(parseFloat(val)) && parseFloat(val) > 0, {
      message: "Rate must be a positive number",
    }),
});

export const voucherFormSchema = z.object({
  paymentAccountType: z.enum(["ledger", "bank", "supplier", "employee", "factorySupplier"]),
  paymentAccountId: z.number().min(1, "Please select an account"),
  paymentAccountName: z.string(),
  voucherDate: z.date(),
  currency: z.enum(["USD", "CFA", "ZMW"]).default("USD"),
  entries: z.array(voucherEntrySchema).min(1, "Add at least one entry"),
  paymentAccountNarration: z.string().optional(),
  notes: z.string().optional(),
});

export const journalFormSchema = z.object({
  voucherDate: z.date(),
  currency: z.enum(["USD", "CFA", "ZMW"]).default("USD"),
  entries: z.array(journalEntrySchema).min(1, "Add at least one entry"),
  notes: z.string().default(""),
});

export const salesFormSchema = z.object({
  voucherDate: z.date(),
  currency: z.enum(["USD", "CFA", "ZMW"]).default("USD"),
  locationId: z.number().min(1, "Location is required"),
  items: z.array(salesLineItemSchema).min(1, "Add at least one item"),
  notes: z.string().optional(),
});

export const purchaseFormSchema = z.object({
  voucherDate: z.date(),
  currency: z.enum(["USD", "CFA", "ZMW"]).default("USD"),
  items: z.array(purchaseLineItemSchema).min(1, "Add at least one item"),
  notes: z.string().optional(),
});

export const adjustmentFormSchema = z.object({
  voucherDate: z.date(),
  currency: z.enum(["USD", "CFA", "ZMW"]).default("USD"),
  locationId: z.number().min(1, "Location is required"),
  items: z.array(adjustmentLineItemSchema).min(1, "Add at least one item"),
  notes: z.string().optional(),
});

export const transferFormSchema = z.object({
  voucherDate: z.date(),
  currency: z.enum(["USD", "CFA", "ZMW"]).default("USD"),
  sourceLocationId: z.number().min(1, "Source location is required"),
  destinationLocationId: z.number().min(1, "Destination location is required"),
  items: z.array(transferLineItemSchema).min(1, "Add at least one item"),
  notes: z.string().optional(),
});

export type VoucherFormData = z.infer<typeof voucherFormSchema>;
export type JournalFormData = z.infer<typeof journalFormSchema>;
export type SalesFormData = z.infer<typeof salesFormSchema>;
export type PurchaseFormData = z.infer<typeof purchaseFormSchema>;
export type AdjustmentFormData = z.infer<typeof adjustmentFormSchema>;
export type TransferFormData = z.infer<typeof transferFormSchema>;

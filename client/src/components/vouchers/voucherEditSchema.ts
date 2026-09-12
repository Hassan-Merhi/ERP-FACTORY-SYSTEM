/**
 * Reference-data types and form schema for the voucher edit dialog.
 *
 * Extracted from VoucherEditDialog.tsx during the P1 god-file split so the
 * multi-currency field contract (which fields are preserved on the edit
 * round-trip) has one typed home that the mapping tests can import.
 */

import { z } from "zod";

export interface LedgerAccount {
  id: number;
  code: string;
  name: string;
  accountType: string;
}

export interface BankAccount {
  id: number;
  accountNumber: string;
  bankName: string;
}

export interface Supplier {
  id: number;
  code: string;
  name: string;
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

export interface VoucherEntry {
  ledgerAccountId: number | null;
  bankAccountId: number | null;
  fixedAssetId: number | null;
  supplierId: number | null;
  employeeId: number | null;
  debitAmount: string;
  creditAmount: string;
  narration: string;
  // Multi-currency fields (read-only during edit — preserved from stored entry)
  transactionCurrency?: string | null;
  transactionDebitAmount?: string | null;
  transactionCreditAmount?: string | null;
  historicalExchangeRate?: string | null;
  rateConvention?: string | null;
}

export const voucherEntrySchema = z.object({
  ledgerAccountId: z.number().nullable(),
  bankAccountId: z.number().nullable(),
  fixedAssetId: z.number().nullable(),
  supplierId: z.number().nullable(),
  employeeId: z.number().nullable(),
  debitAmount: z.string(),
  creditAmount: z.string(),
  narration: z.string(),
  // ── Multi-currency fields (read-only — preserved from stored entry) ────────
  // These are carried through the form state and re-submitted on save so the
  // server can keep them consistent when the user edits USD amounts.
  transactionCurrency: z.string().nullable().optional(),
  transactionDebitAmount: z.string().nullable().optional(),
  transactionCreditAmount: z.string().nullable().optional(),
  historicalExchangeRate: z.string().nullable().optional(),
  rateConvention: z.string().nullable().optional(),
});

export const voucherSchema = z.object({
  voucherNumber: z.string().min(1, "Voucher number is required"),
  voucherType: z.string().min(1, "Voucher type is required"),
  voucherDate: z.date(),
  description: z.string(),
  optional: z.boolean(),
  entries: z.array(voucherEntrySchema).min(1, "At least one entry is required"),
});

export type VoucherFormData = z.infer<typeof voucherSchema>;

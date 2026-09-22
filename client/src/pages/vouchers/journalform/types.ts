/**
 * Types for the JournalForm page.
 *
 * Extracted from JournalForm.tsx during the Phase 4 god-file split.
 */
import { z } from "zod";
import { journalFormSchema } from "./utils";

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

export interface Account {
  id: number;
  name: string;
  type: "ledger" | "bank" | "supplier" | "employee" | "fixedAsset" | "customer" | "factorySupplier";
  code?: string;
  balance?: number;
}

export interface JournalVoucherEntry {
  bankAccountId?: number | null;
  ledgerAccountId?: number | null;
  supplierId?: number | null;
  factorySupplierId?: number | null;
  employeeId?: number | null;
  fixedAssetId?: number | null;
  customerId?: number | null;
  debitAmount?: string | number | null;
  creditAmount?: string | number | null;
  narration?: string | null;
}

export interface JournalVoucherToEdit {
  id: number;
  voucherNumber?: string | null;
  voucherType: string;
  voucherDate: string;
  entries?: JournalVoucherEntry[];
  description?: string | null;
  notes?: string | null;
  optional?: boolean;
  effectiveDate?: string | null;
}

export interface CreatedLedgerAccount {
  id: number;
  name: string;
  code?: string | null;
}

export type JournalFormData = z.infer<typeof journalFormSchema>;

export interface JournalFormProps {
  voucherIdToEdit: number | null;
  isPOS: boolean;
}

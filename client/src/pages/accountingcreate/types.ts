/**
 * Types for the AccountingCreate page.
 *
 * Extracted from AccountingCreate.tsx during the Phase 4 god-file split.
 */
import type { LucideIcon } from "lucide-react";
import type { FieldValues, UseFormReturn } from "react-hook-form";

export type EntityType = "location" | "ledger" | "employee" | "supplier" | "stockGroup" | "stockItem";

/** The accounting-create forms share one dynamic wrapper, so their values are
 * intentionally represented by react-hook-form's field-value boundary. The
 * active entity schema still validates each payload before it is submitted. */
export type AccountingFormValues = FieldValues;
export type AccountingForm = UseFormReturn<AccountingFormValues>;
export type AccountingFormSubmit = (data: AccountingFormValues, saveAndNew?: boolean) => void;

export interface CompanyOption {
  id: number;
  name: string;
}

export interface LedgerAccountOption {
  id: number;
  name: string;
  code?: string;
  accountType?: string;
  subType?: string | null;
}

export interface StockGroupOption {
  id: number;
  name: string;
  code: string;
}

export interface SidebarItem {
  key: EntityType;
  label: string;
  icon: LucideIcon;
}

export interface SidebarGroup {
  label: string;
  items: SidebarItem[];
}

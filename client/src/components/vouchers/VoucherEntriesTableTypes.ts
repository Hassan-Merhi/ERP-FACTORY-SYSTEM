// Extracted from ./VoucherEntriesTable.tsx to keep that module under the source-size cap.
import { UseFieldArrayReturn, UseFormReturn } from "react-hook-form";
import type { VoucherFormData } from "@/pages/vouchers/voucherTypes";
import type { Account } from "@/components/AccountSidebar";

export const ENTRY_TYPE_BADGE: Record<string, { label: string; cls: string }> = {
  bank: { label: "Bank", cls: "bg-blue-100 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300" },
  ledger: { label: "Ledger", cls: "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300" },
  supplier: { label: "Supplier", cls: "bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-300" },
  employee: { label: "Staff", cls: "bg-purple-100 text-purple-700 dark:bg-purple-950/60 dark:text-purple-300" },
  fixedAsset: { label: "Asset", cls: "bg-orange-100 text-orange-700 dark:bg-orange-950/60 dark:text-orange-300" },
  customer: { label: "Customer", cls: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300" },
  factorySupplier: { label: "F.Supp", cls: "bg-teal-100 text-teal-700 dark:bg-teal-950/60 dark:text-teal-300" },
};

/**
 * One row of the entries table, derived from the voucher form's own Zod schema
 * so the table and the form cannot drift apart.
 */
export type VoucherEntry = VoucherFormData["entries"][number];

export interface VoucherEntriesTableProps {
  form: UseFormReturn<VoucherFormData>;
  fieldArray: UseFieldArrayReturn<VoucherFormData, "entries", "id">;
  entries: VoucherEntry[];
  total: number;
  /** Native EUR voucher amounts must never pass through the USD display conversion. */
  amountCurrencyOverride?: "EUR";
  mode: "payment" | "receipt";
  onAmountCommit?: (rowIndex: number) => void;
  activeRow: number | null;
  filteredSidebarAccounts: Account[];
  sidebarHighlightedIndex: number;
  setSidebarHighlightedIndex: (index: number) => void;
  setSidebarSearchValue: (value: string) => void;
  handleSidebarAccountSelect: (account: Account) => void;
  sidebarAccounts?: Account[];
  onRowFocus: (rowIndex: number, fieldName: string) => void;
  onRowBlur: () => void;
  isFactoryCompany?: boolean;
  onAutoCreateAccount?: (name: string) => Promise<Account | null>;
  isAutoCreating?: boolean;
}

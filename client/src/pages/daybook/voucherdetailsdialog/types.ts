/**
 * Types for the VoucherDetailsDialog page.
 *
 * Extracted from VoucherDetailsDialog.tsx during the Phase 4 god-file split.
 */
import type { AuthMe } from "@shared/apiTypes";
import { Voucher, ViewVoucherEntry, Employee, LedgerAccount, BankAccount } from ".././types";

export type VoucherRevisionItem = {
  stockItemName?: string;
  originalQuantity?: string | number;
  newQuantity?: string | number;
  delta?: string | number;
};

export type VoucherRevision = {
  id: number;
  revisionNumber?: number;
  optional?: boolean;
  _mergedCount?: number;
  createdAt?: string;
  note?: string | null;
  items?: VoucherRevisionItem[];
};

export type PurchaseOrderDialogData = {
  id?: number;
  supplierName?: string | null;
  supplierId?: number;
  containerNumber?: string | null;
  containerId?: number;
  itemsTotal?: string | number;
  freight?: string | number;
  fumigation?: string | number;
  surcharge?: string | number;
  documentCharges?: string | number;
  otherCharges?: string | number;
  discount?: string | number;
};

export interface VoucherDetailsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedVoucher: Voucher | null;
  viewEntriesLoading: boolean;
  viewVoucherEntries: ViewVoucherEntry[];
  isStockTransferVoucher: boolean;
  voucherRevisions: VoucherRevision[];
  revisionsLoading: boolean;
  revisionsError: boolean;
  revisionsErrorMessage?: string;
  retryVoucherRevisions: () => void;
  formatAmount: (amt: string | number | null | undefined) => string;
  formatDisplayDate: (date: string | Date) => string;
  formatDisplayTime: (date: string) => string;
  cashAccountBalance: string;
  entryBalances: Record<number, string>;
  purchaseOrderData: PurchaseOrderDialogData | null;
  poSupplierBalance: string | null;
  selectedDialogRow: number | null;
  setSelectedDialogRow: (n: number | null) => void;
  employees?: Employee[];
  ledgerAccounts?: LedgerAccount[];
  bankAccounts?: BankAccount[];
  viewProfitFilter: "all" | "gain" | "loss" | "even";
  setViewProfitFilter: (v: "all" | "gain" | "loss" | "even") => void;
  user?: AuthMe | null;
  handleEdit: (v: Voucher) => void;
  canEdit: (v: Voucher) => boolean;
  navigate: (path: string) => void;
}

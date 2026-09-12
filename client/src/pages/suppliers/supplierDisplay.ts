/**
 * Display models and pure presentation helpers for the Suppliers page.
 *
 * Extracted from Suppliers.tsx during the god-file split so the page stays
 * under the repository size limit. Nothing here touches React state or JSX.
 */

export interface SupplierWithStats {
  id: number;
  code: string;
  legalName: string;
  email: string;
  phone: string | null;
  address: string | null;
  taxId: string | null;
  paymentTerms: string | null;
  active: boolean;
  containerCount: number;
  balance: number;
  balancesByCurrency?: Record<string, { debit: number; credit: number; net: number }>;
  historicalBaseBalance?: number;
}

export interface SupplierLedgerRow {
  type: string;
  date: string | null;
  companyId: number | null;
  companyName: string;
  docNumber: string;
  voucherId: number | null;
  description: string;
  voucherType: string;
  debit: number;
  credit: number;
  balance: number;
  currency?: string | null;
  transactionCurrency?: string | null;
  transactionDebitAmount?: number | string | null;
  transactionCreditAmount?: number | string | null;
  debitAmount?: number | string | null;
  creditAmount?: number | string | null;
  baseDebitAmount?: number | string | null;
  baseCreditAmount?: number | string | null;
  historicalExchangeRate?: number | string | null;
  historicalBaseBalance?: number | string | null;
  currencyStatus?: string | null;
  containerNumber?: string | null;
  containerId?: number | null;
}

export interface SupplierPurchaseOrder {
  id: number;
  companyId: number;
  containerId: number | null;
  containerNumber: string | null;
  companyName: string;
  importDate: string | null;
  createdAt: string;
  itemsTotal: number | string | null;
  freight: number | string | null;
  surcharge: number | string | null;
  fumigation: number | string | null;
  documentCharges: number | string | null;
  discount: number | string | null;
  otherCharges: number | string | null;
}

export const isPaymentRow = (t: SupplierLedgerRow) =>
  t.debit > 0 || t.voucherType === "Payment" || t.voucherType === "Receipt";

export const typeBadgeClass: Record<string, string> = {
  Payment: "bg-green-500/10 text-green-600 dark:text-green-400",
  Receipt: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
  Journal: "bg-purple-500/10 text-purple-600 dark:text-purple-400",
  "Credit Note": "bg-amber-500/10 text-amber-600 dark:text-amber-400",
  "Debit Note": "bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

export const getInitials = (name: string) =>
  name
    .split(" ")
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

const avatarColors = [
  "bg-blue-500/20 text-blue-600 dark:text-blue-400",
  "bg-violet-500/20 text-violet-600 dark:text-violet-400",
  "bg-emerald-500/20 text-emerald-600 dark:text-emerald-400",
  "bg-amber-500/20 text-amber-600 dark:text-amber-400",
  "bg-rose-500/20 text-rose-600 dark:text-rose-400",
  "bg-cyan-500/20 text-cyan-600 dark:text-cyan-400",
  "bg-orange-500/20 text-orange-600 dark:text-orange-400",
  "bg-indigo-500/20 text-indigo-600 dark:text-indigo-400",
];

export const getAvatarColor = (id: number) => avatarColors[id % avatarColors.length];

/**
 * Types for the FactoryNetPosition page.
 *
 * Extracted from FactoryNetPosition.tsx during the Phase 4 god-file split.
 */
import type { NotInLedgerSectionData } from "@/components/netposition/NotInLedgerCard";

export interface BrokerBreakdownLine {
  label: string;
  native: string;
  usd: number;
}

export interface AccountItem {
  id?: number;
  name: string;
  code: string;
  value: number;
  category: string;
  breakdown?: BrokerBreakdownLine[];
}

export interface BreakdownItem {
  name: string;
  value: number;
}

export interface OrderItem {
  id: number;
  customerName: string;
  orderDate: string;
  grandTotal: number;
  totalQtyBales: number;
}

export interface NetPositionData {
  forUsTotal: number;
  onUsTotal: number;
  netPosition: number;
  netPositionLabel: string;
  forUs: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  onUs: { total: number; breakdown: BreakdownItem[]; accounts: AccountItem[] };
  supplierLiabilities: number;
  supplierOverpayments?: number;
  inventoryValue: number;
  rawMaterialValue: number;
  ledgerAssets: number;
  ledgerLiabilities: number;
  pendingOrders: OrderItem[];
  verifiedOrders: OrderItem[];
  loadingOrders: OrderItem[];
  pendingTotal: number;
  verifiedTotal: number;
  loadingTotal: number;
  /** Amounts not yet in the ledger: shown separately, never in the totals. */
  notInLedger?: NotInLedgerSectionData;
}

export interface CustomViewAccount {
  key: string;
  name: string;
  code: string;
  category: string;
  value: number;
  side: "forUs" | "onUs";
}

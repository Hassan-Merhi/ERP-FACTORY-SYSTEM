// Extracted from ./ContainerListView.tsx
import type { FactorySupplier } from "@shared/schema";
import { type ContainerWithSupplier } from "./otwHelpers";

/** Container value in its own currency: goods, same-currency freight and every charge. */
export function containerTotalValue(c: ContainerWithSupplier): number {
  const ccy = c.currencyCode || "USD";
  const baseValue = parseFloat(c.totalKg || "0") * parseFloat(c.ratePerKg || "0");
  const freightAmt = parseFloat(c.freight || "0");
  const freightSameCcy = (c.freightCurrencyCode || ccy) === ccy;
  const legacyOtherAmt = parseFloat(c.otherCharges || "0");
  const charges = c as unknown as ContainerWithSupplier & {
    preRegisteredChargesSum?: string;
    additionalChargesSum?: string;
  };
  const preRegisteredAmt = parseFloat(charges.preRegisteredChargesSum || "0");
  const additionalAmt = parseFloat(charges.additionalChargesSum || "0");
  return baseValue + (freightSameCcy ? freightAmt : 0) + legacyOtherAmt + preRegisteredAmt + additionalAmt;
}

export interface ContainerListViewProps {
  containers: ContainerWithSupplier[] | undefined;
  filteredContainers: ContainerWithSupplier[] | undefined;
  suppliers: FactorySupplier[] | undefined;
  searchQuery: string;
  setSearchQuery: (v: string) => void;
  statusFilter: string;
  setStatusFilter: (v: string) => void;
  hasActiveFilters: boolean;
  onResetFilters: () => void;
  expandedSuppliers: Set<string>;
  setExpandedSuppliers: (fn: (prev: Set<string>) => Set<string>) => void;
  selectedIds: Set<number>;
  setSelectedIds: (fn: (prev: Set<number>) => Set<number>) => void;
  onView: (c: ContainerWithSupplier) => void;
  onEdit: (c: ContainerWithSupplier) => void;
  onDelete: (id: number) => void;
  onPostOffload: (c: ContainerWithSupplier) => void;
  onReverseOffload: (c: ContainerWithSupplier) => void;
  onNavigateOffload: () => void;
}

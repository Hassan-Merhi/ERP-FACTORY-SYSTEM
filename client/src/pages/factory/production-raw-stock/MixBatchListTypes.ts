// Extracted from ./MixBatchList.tsx to keep that module under the source-size cap.
import type { MixBatchSupplierCategory, MixBatchSupplierCategoryLink } from "./mixBatchCategoryTargets";
export interface MixBatchRow {
  id: number;
  batchCode: string;
  name: string | null;
  totalWeightKg: string;
  usedKg: string;
  remainingKg: string;
  costPerKg: string;
  totalCost: string;
  status: string;
  operatorUser: string | null;
  batchDate: string | null;
  carryForwardFromId: number | null;
  createdAt: string;
  displayTotalWeightKg?: string;
  displayTotalCost?: string;
  displayCostPerKg?: string;
}

export interface MixBatchSourceRow {
  id: number;
  sourceName: string;
  containerNumber: string | null;
  categoryId?: number | null;
  categoryName?: string | null;
  supplierId?: number | null;
  sourceBatchId?: number | null;
  weightKg: number;
  costPerKg: string | number;
  totalCost: number;
}

export interface MixBatchPrintRow {
  id: number;
  batchCode: string;
  name: string | null;
  status: string;
  totalWeightKg: number;
  totalCost: number;
  costPerKg: string;
  displayTotalCost?: number;
  displayCostPerKg?: string;
  sources?: MixBatchSourceRow[];
}

export interface MixBatchListProps {
  mixBatches: MixBatchRow[];
  isLoading: boolean;
  onEdit: (batch: MixBatchRow) => void;
  onDelete: (id: number) => void;
  onViewDetail: (batch: MixBatchRow) => void;
  onSendWhatsApp: () => void;
  isSendingWhatsApp: boolean;
  mixBatchDate: string;
  setMixBatchDate: (date: string) => void;
  mixBatchesByDate: MixBatchPrintRow[];
  mixBatchesByDateLoading: boolean;
  mixBatchPrintRef: React.RefObject<HTMLDivElement | null>;
  reportCategories: MixBatchSupplierCategory[];
  reportSuppliers: MixBatchSupplierCategoryLink[];
  reportAllocations: Record<string, number> | null;
  reportLoading: boolean;
  formatDisplayDate: (date: string) => string;
}

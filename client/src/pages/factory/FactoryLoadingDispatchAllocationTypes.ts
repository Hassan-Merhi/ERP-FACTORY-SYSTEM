// Extracted from ./FactoryLoadingDispatchAllocation.tsx to keep that module under the source-size cap.

interface ArticleRow {
  articleCode: string;
  productName: string;
  loadedQty: number;
  loadedWeightKg: number;
  reservedOtherQty: number;
  reservedHereQty: number;
  scannedHereQty: number;
  availableQty: number;
  expectedQty: number;
  priorityRank: number;
}

interface Candidate {
  baleId: number;
  baleReference: string;
  articleCode: string;
  productName: string;
  weightKg: number;
  orderIndex: number;
  assignedHere: boolean;
  scannedHere: boolean;
  assignedElsewhere: { dispatchId: string; dispatchNumber: number } | null;
}

export interface Allocation {
  orderId: number;
  dispatchId: number;
  status: string;
  priority: {
    orderPriority: number;
    color: string;
    enabled: boolean;
    source: string;
  } | null;
  articleOrdering: string;
  articles: ArticleRow[];
  candidates: Candidate[];
  expectedArticles: Array<{ articleCode: string; expectedQty: number; priorityRank: number | null }>;
  expectedBales: Array<{ baleId: number; baleReference: string; articleCode: string }>;
  otherTrips: Array<{ dispatchId: string; reservedArticles: Array<{ articleCode: string; reservedQty: number }> }>;
}

export interface Props {
  orderId: number;
  dispatchId: number;
  companyId: number | null | undefined;
  role: string;
  status: string;
  onChanged: () => void;
}

export const PAGE_SIZE = 75;

export function failMessage(e: unknown) {
  return e instanceof Error ? e.message : "Unable to save truck allocation";
}

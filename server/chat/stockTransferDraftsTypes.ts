// Extracted from ./stockTransferDrafts.ts to keep that module under the source-size cap.

/** One item inside a stock-transfer chat draft. */
type StockTransferDraftItem = {
  stockItemId: number;
  stockItemName?: string;
  stockItemCode?: string;
  quantity?: number;
  currentStock?: number;
  destinationQty?: number;
  reason?: string;
};

/** Stock-transfer draft payload produced by chat flows (also parsed back from JSON). */
export type StockTransferChatDraft = {
  date: string;
  sourceLocationId: number;
  sourceLocationName: string;
  destinationLocationId: number;
  destinationLocationName: string;
  notes?: string;
  optional?: boolean;
  analysisSummary?: string;
  items?: StockTransferDraftItem[];
  locationCandidates?: { id: number; name: string }[];
  analysisDateRange?: { from: string; to: string };
  aggressiveness?: string;
  comparedLocations?: string;
  oldTransferSummary?: string;
};

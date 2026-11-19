// Extracted from ./useFactoryLoadingDispatchReportState.tsx

interface Trip {
  id: string;
  dispatchNumber: number;
  status: string;
  truckPlate: string | null;
  driverName: string | null;
  destination: string | null;
  notes: string | null;
  containerNumberSnapshot: string | null;
  createdByUsername: string | null;
  createdAt: string | null;
  closedAt: string | null;
  closedByUsername: string | null;
}

interface Bale {
  baleReference: string;
  articleCode: string;
  productName: string;
  baleId: number;
  weightKg: number;
  dispatchId?: string;
  dispatchNumber?: number;
  expectedDispatchNumber?: number;
  reason?: string;
  scannedBy?: string;
  scannedAt?: string;
  scanId?: string;
}

interface Article {
  articleCode: string;
  productName: string;
  expectedQty: number | null;
  scannedQty: number;
  matchedQty: number;
  missingQty: number | null;
  extraQty: number;
  expectedWeightKg: number | null;
  scannedWeightKg: number;
  status: string;
}

interface Summary {
  loadedBales: number;
  loadedWeightKg: number;
  expectedBales: number | null;
  verifiedBales: number;
  expectedWeightKg: number | null;
  verifiedWeightKg: number;
  matchedBales: number;
  missingBales: number | null;
  unexpectedBales: number;
  crossTripMisplacedBales: number;
  duplicateBales: number;
  progressPercent: number | null;
  weightDifferenceKg: number | null;
}

export interface Report {
  source: "LIVE" | "CLOSURE";
  generatedAt: string;
  loading: {
    orderId: number;
    companyName: string;
    customerName: string | null;
    proformaName: string | null;
    containerNumber: string | null;
    status: string;
  };
  trip: Trip | null;
  closure: null | {
    id: string;
    revision: number;
    closedByUsername: string;
    closedAt: string;
    discrepancyReason: string | null;
    approvedWithDiscrepancies: boolean;
    reopenedAt: string | null;
    reopenReason: string | null;
  };
  comparison: {
    articles: Article[];
    missingBales: Bale[];
    unexpectedBales: Bale[];
    crossTripBales: Bale[];
    duplicateBales: Bale[];
    trips: Array<{
      id: string;
      dispatchNumber: number;
      truckPlate: string | null;
      status: string;
      scannedBales: number;
      scannedWeightKg: number;
    }>;
    summary: Summary;
  };
  scans: Bale[];
  manifestAvailable: boolean;
  notices: string[];
  audit: Array<{ id: string; dispatchId: string; eventType: string; actorUsername: string; createdAt: string }>;
  auditTruncated: boolean;
}

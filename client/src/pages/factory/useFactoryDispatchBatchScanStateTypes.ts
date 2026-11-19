// Extracted from ./useFactoryDispatchBatchScanState.tsx

export interface BatchDetail {
  batch: {
    id: number;
    batchNumber: string;
    batchDate: string;
    status: string;
    currency: string;
    priceMode: string;
    destination: string | null;
    proformaId: number | null;
  };
  customerName: string | null;
  proforma: { id: number; name: string } | null;
  proformaLines: {
    id: number;
    articleCode: string;
    productName: string;
    quantity: number;
    pricePerBale: string;
  }[];
  rides: {
    id: number;
    rideNumber: number;
    truckPlate: string | null;
    driverName: string | null;
    status: string;
    baleCount: number | string;
    totalWeightKg: string;
    totalAmount: string;
  }[];
  articleTotals: {
    articleCode: string;
    productName: string;
    scannedQty: number | string;
    scannedWeightKg: string;
    scannedAmount: string;
  }[];
}

export interface AuditScan {
  id: number;
  truckRideId: number;
  rideNumber: number;
  baleId: number;
  baleReference: string;
  articleCode: string | null;
  productName: string | null;
  weightKg: string;
  priceUsed: string;
  amount: string;
  scannedBy: string | null;
  scannedAt: string;
  removedAt: string | null;
}

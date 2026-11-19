// Extracted from ./FactoryPendingLoadings.tsx to keep that module under the source-size cap.

export const UNDO_TIMEOUT_MS = 8000;

export interface PendingLoad {
  id: number;
  customerId: number;
  customerName: string;
  orderDate: string;
  totalQtyBales: number;
  totalWeightKg: string | null;
  proformaIdUsed: number | null;
  proformaName: string | null;
  locationId: number | null;
  loadingStartedAt: string | null;
  status: string;
  containerNotes: string | null;
}

export interface UndoItem {
  load: PendingLoad;
  cancelledAt: number;
  timerId: ReturnType<typeof setTimeout>;
  elapsed: number;
}

export interface Proforma {
  id: number;
  name: string;
  status: string;
  customerId: number;
  createdAt: string;
  lines: Array<{ id: number; articleCode: string; productName: string; qty: number }>;
}

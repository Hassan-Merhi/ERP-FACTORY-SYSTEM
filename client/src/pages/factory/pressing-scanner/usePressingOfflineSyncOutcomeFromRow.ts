// Extracted from ./usePressingOfflineSync.ts
import type { PressingScanOutcome } from "../ContinuousPressingScanner";
import { type PressingQueuedScan } from "./pressingOfflineQueue";

export interface PressingQueueSnapshot {
  items: PressingQueuedScan[];
  pending: number;
  syncing: number;
  confirmed: number;
  rejected: number;
  error: string | null;
  online: boolean;
}

export const INITIAL: PressingQueueSnapshot = {
  items: [],
  pending: 0,
  syncing: 0,
  confirmed: 0,
  rejected: 0,
  error: null,
  online: true,
};

export function outcomeFromRow(row: PressingQueuedScan): PressingScanOutcome {
  if (row.state === "confirmed" && row.receipt) {
    const receipt = row.receipt;
    return {
      kind: "confirmed",
      message: receipt.replayed ? "Pressing confirmation recovered; counted once" : "Pressing completed and saved",
      confirmedAt: receipt.confirmedAt,
      referenceNumber: receipt.referenceNumber,
      confirmationId: receipt.id,
      machineName: receipt.machineName,
      weightKg: receipt.weightKg,
      productionDate: receipt.productionDate,
      timezoneName: receipt.timezoneName,
    };
  }
  if (row.state === "rejected") {
    return {
      kind: row.errorCode === "PRESSING_ALREADY_CONFIRMED" ? "duplicate" : "rejected",
      message: row.lastError || "Pressing confirmation was rejected by the server",
      scannedBy: row.previousScan?.operatorName?.trim(),
    };
  }
  return {
    kind: "queued",
    message: "Saved on this device. Waiting for server confirmation — NOT yet counted.",
  };
}

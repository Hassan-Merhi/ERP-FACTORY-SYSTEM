/**
 * Phase 4: submitted camera reads are server-confirmed physical pressing events.
 * No local optimistic increment and no automatic stock finalization.
 */
import { apiRequest } from "@/lib/queryClient";
import type { PressingScanCapture, PressingScanOutcome } from "../ContinuousPressingScanner";

type ServerPressingReceipt = {
  id: number;
  status: "PRESSING_COMPLETED";
  referenceNumber: string;
  weightKg: string;
  machineName: string;
  confirmedAt: string;
  productionDate: string;
  timezoneName: string;
  replayed: boolean;
  inventoryFinalized: false;
};

type ApiFailure = Error & { code?: string; status?: number };

export function isPressingDuplicate(code: string | undefined): boolean {
  return code === "PRESSING_ALREADY_CONFIRMED";
}

export async function submitPressingConfirmation(capture: PressingScanCapture): Promise<PressingScanOutcome> {
  // The request ID is generated once for this submission. Phase 5 will
  // persist the request ID and payload when implementing durable offline retry.
  const requestId = crypto.randomUUID();
  try {
    const response = await apiRequest("POST", "/api/factory/pressing-machines/confirm", {
      barcode: capture.barcode,
      deviceCapturedAt: capture.deviceCapturedAt,
      assignmentId: capture.assignmentId,
      machineId: capture.machineId,
      requestId,
    });
    const receipt = await response.json() as ServerPressingReceipt;
    if (receipt.status !== "PRESSING_COMPLETED" || !receipt.id || receipt.inventoryFinalized !== false) {
      return { kind: "rejected", message: "Unexpected confirmation response. Please check scan history." };
    }
    return {
      kind: "confirmed",
      message: receipt.replayed ? "Already received — confirmed original pressing record" : "Pressing completed and saved",
      confirmedAt: receipt.confirmedAt,
      productionDate: receipt.productionDate,
      timezoneName: receipt.timezoneName,
      referenceNumber: receipt.referenceNumber,
      weightKg: receipt.weightKg,
      machineName: receipt.machineName,
      confirmationId: receipt.id,
    };
  } catch (cause) {
    const error = cause as ApiFailure;
    const code = error.code;
    if (isPressingDuplicate(code)) {
      return {
        kind: "duplicate",
        message: error.message || "This bale has already been confirmed on another machine.",
      };
    }
    if (code === "PRESSING_ASSIGNMENT_CHANGED" || code === "PRESSING_MACHINE_INACTIVE" ||
        code === "PRESSING_USER_INACTIVE" || code === "PRESSING_WRITE_DENIED") {
      return { kind: "rejected", message: error.message || "Machine assignment is no longer valid. Refresh your page." };
    }
    if (code === "PRESSING_BALE_NOT_FOUND" || code === "PRESSING_BALE_NOT_PENDING" ||
        code === "PRESSING_NON_BALE_ITEM" || code === "INVALID_PRESSING_SCAN") {
      return { kind: "rejected", message: error.message || "This barcode is not eligible for pressing confirmation." };
    }
    // Unknown network/proxy failures are AMBIGUOUS: a transaction might have
    // committed before the response was lost. Never show success or a green
    // completed status. Durable retry with the SAME request ID is Phase 5.
    return {
      kind: "rejected",
      message: "Confirmation not verified. Check connection and scan history before scanning again.",
    };
  }
}

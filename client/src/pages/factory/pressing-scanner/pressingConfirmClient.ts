/**
 * HTTP transport for persisted pressing requests.
 * NEVER manufactures a new request ID or changes the original payload.
 * All receipts are authoritative server responses.
 */
import { apiRequest } from "@/lib/queryClient";
import type { PressingQueuedScan, PressingServerReceipt } from "./pressingOfflineQueue";

export type PressingTransportResult =
  | { kind: "confirmed"; receipt: PressingServerReceipt; message: string }
  | { kind: "rejected"; code: string; message: string }
  | { kind: "retry"; code: string; message: string; needsAuth?: boolean };

type ApiFailure = Error & { code?: string; status?: number };

export function isPressingDuplicate(code: string | undefined): boolean {
  return code === "PRESSING_ALREADY_CONFIRMED";
}
function validReceipt(value: unknown): value is PressingServerReceipt {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<PressingServerReceipt>;
  return item.status === "PRESSING_COMPLETED" &&
    Number.isSafeInteger(item.id) && (item.id ?? 0) > 0 &&
    item.inventoryFinalized === false &&
    typeof item.referenceNumber === "string" &&
    typeof item.confirmedAt === "string" &&
    Number.isFinite(Date.parse(item.confirmedAt)) &&
    typeof item.productionDate === "string" &&
    typeof item.timezoneName === "string" &&
    typeof item.weightKg === "string" &&
    typeof item.machineName === "string" &&
    Number.isSafeInteger(item.machineId) &&
    Number.isSafeInteger(item.assignmentId) &&
    typeof item.requestId === "string" &&
    typeof item.operatorUserId === "string";
}
export async function sendQueuedPressingScan(row: PressingQueuedScan): Promise<PressingTransportResult> {
  try {
    const response = await apiRequest(
      "POST", "/api/factory/pressing-machines/confirm", row.payload, false, 12000
    );
    const receipt: unknown = await response.json();
    if (!validReceipt(receipt) || receipt.referenceNumber !== row.barcode ||
        receipt.machineId !== row.payload.machineId ||
        receipt.assignmentId !== row.payload.assignmentId ||
        receipt.requestId !== row.requestId ||
        receipt.operatorUserId !== row.userId) {
      return {
        kind: "retry", code: "PRESSING_BAD_RECEIPT",
        message: "Server response could not be verified. Retrying with the same scan ID.",
      };
    }
    return {
      kind: "confirmed", receipt,
      message: receipt.replayed
        ? "Original pressing confirmation recovered — not counted twice"
        : "Pressing completed and saved",
    };
  } catch (cause) {
    const error = cause as ApiFailure;
    const status = typeof error.status === "number" ? error.status : 0;
    const code = error.code || "PRESSING_CONNECTION_UNCERTAIN";
    const message = error.message || "Unable to verify pressing scan";
    if (status === 401 || code === "SESSION_EXPIRED" || code === "CSRF_TOKEN_MISMATCH") {
      return {
        kind: "retry", code: "PRESSING_AUTH_REQUIRED",
        message: "Session expired. Reconnect as the original operator before syncing.",
        needsAuth: true,
      };
    }
    if (isPressingDuplicate(code)) {
      return { kind: "rejected", code, message };
    }
    if (status === 0 || status === 408 || status === 429 || status >= 500 || code === "OfflineQueued") {
      return {
        kind: "retry", code,
        message: "Connection or server unavailable. Scan remains saved locally for safe retry.",
      };
    }
    // 4xx errors (assignment revoked, bale invalid, voided, permission denied)
    // are terminal until supervisor review: never replay them indefinitely.
    return { kind: "rejected", code, message };
  }
}

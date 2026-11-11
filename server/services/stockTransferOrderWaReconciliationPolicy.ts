/** Pure, testable administrator evidence policy for approved WhatsApp Excel delivery. */
export type ReconciliationAction = "verify_delivered" | "authorize_retry";
export type DeliveryRecipientKind = "approval_group" | "destination";
type Verification = {
  action: ReconciliationAction;
  expectedStatus: "uncertain" | "failed";
  reason: string;
  checkedWhatsApp: boolean;
  checkedProvider: boolean;
  confirmedDelivered: boolean;
  confirmedNotDelivered: boolean;
  acknowledgeDuplicateRisk: boolean;
};

export class StockTransferOrderDeliveryReconciliationError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
    this.name = "StockTransferOrderDeliveryReconciliationError";
  }
}

const reject = (status: number, message: string): never => {
  throw new StockTransferOrderDeliveryReconciliationError(status, message);
};

export function parseStockTransferOrderDeliveryReconciliation(body: unknown): Verification {
  const value = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown> : {};
  const action = value.action;
  const expectedStatus = value.expectedStatus;
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if ((action !== "verify_delivered" && action !== "authorize_retry") ||
      (expectedStatus !== "uncertain" && expectedStatus !== "failed") ||
      reason.length < 20 || reason.length > 500 || /[\u0000-\u001f\u007f]/.test(reason)) {
    return reject(400,"Choose the exact failed/uncertain record and give a review note of 20–500 characters.");
  }
  if (value.checkedWhatsApp !== true || value.checkedProvider !== true) {
    return reject(400,"Verify the exact batch and recipient in WhatsApp AND GREEN API history.");
  }
  if ((action === "verify_delivered" && value.confirmedNotDelivered === true) ||
      (action === "authorize_retry" && value.confirmedDelivered === true)) {
    return reject(400,"The file cannot be both found and missing. Choose one verified outcome.");
  }
  if (action === "verify_delivered" && value.confirmedDelivered !== true) {
    return reject(400,"Confirm you personally verified that this exact file appears in the recipient chat.");
  }
  if (action === "authorize_retry" &&
      (value.confirmedNotDelivered !== true || value.acknowledgeDuplicateRisk !== true)) {
    return reject(400,"Confirm no matching message was found and acknowledge that duplicates remain possible.");
  }
  return {
    action,
    expectedStatus,
    reason,
    checkedWhatsApp: true,
    checkedProvider: true,
    confirmedDelivered: value.confirmedDelivered === true,
    confirmedNotDelivered: value.confirmedNotDelivered === true,
    acknowledgeDuplicateRisk: value.acknowledgeDuplicateRisk === true,
  };
}


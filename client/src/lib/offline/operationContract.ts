/** A fail-closed, versioned contract for Phase 1 offline writes. */
export type OfflineOutcome = "acknowledged" | "paused" | "retry" | "conflict" | "rejected";
export type OfflineOperationState =
  | "pending"
  | "sending"
  | "acknowledged"
  | "conflict"
  | "rejected"
  | "needs_review";

export type OfflineMode = "erp" | "factory" | "pos" | "properties";

export interface OfflineActor {
  companyId: number;
  userId: string;
}

export interface OfflineOperation extends OfflineActor {
  id: string;
  schemaVersion: 1;
  deviceId: string;
  mode: OfflineMode;
  entityType: string;
  method: string;
  url: string;
  payload: string;
  clientDate: string;
  dependencies: string[];
  createdAt: number;
  updatedAt: number;
  state: OfflineOperationState;
  attempts: number;
  nextAttemptAt: number;
  leaseOwner: string | null;
  leaseUntil: number;
  lastError: string | null;
  response: string | null;
  acknowledgedAt: number | null;
}

/**
 * Each entry must be proven idempotent on the server inside the transaction
 * committing the business write. The voucher-with-entries route already
 * builds the central posting identity from X-Idempotency-Key.
 * No generic inventory or factory writes are approved by this list.
 */
export function isAutoReplayAllowed(method: string, url: string): boolean {
  return method.toUpperCase() === "POST" && url === "/api/vouchers/with-entries";
}

/** Only central-posting-compatible voucher inputs may replay automatically. */
export function isVettedOfflineVoucherPayload(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const data = input as Record<string, unknown>;
  if (!data.voucher || typeof data.voucher !== "object" || Array.isArray(data.voucher)) return false;
  const voucher = data.voucher as Record<string, unknown>;
  if (voucher.optional === true || String(voucher.currency ?? "USD").toUpperCase() !== "USD") return false;
  if (!Array.isArray(data.entries) || data.entries.length < 2) return false;
  const dualCurrencyFields = [
    "transactionCurrency",
    "transactionDebitAmount",
    "transactionCreditAmount",
    "baseDebitAmount",
    "baseCreditAmount",
    "historicalExchangeRate",
    "rateConvention",
  ];
  return data.entries.every((entry: unknown) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const row = entry as Record<string, unknown>;
    if (dualCurrencyFields.some((field) => row[field] != null)) return false;
    const debit = Number(row.debitAmount ?? 0);
    const credit = Number(row.creditAmount ?? 0);
    if (!Number.isFinite(debit) || !Number.isFinite(credit) || debit < 0 || credit < 0) return false;
    const debitCents = debit * 100;
    const creditCents = credit * 100;
    return (
      Number.isSafeInteger(Math.round(debitCents)) &&
      Number.isSafeInteger(Math.round(creditCents)) &&
      Math.abs(debitCents - Math.round(debitCents)) < 1e-7 &&
      Math.abs(creditCents - Math.round(creditCents)) < 1e-7 &&
      (debit === 0) !== (credit === 0)
    );
  });
}

const SENSITIVE_KEY =
  /^(?:password|passwd|pwd|oldPassword|currentPassword|newPassword|confirmPassword|managerPassword|supervisorPassword|passwordHash|authorization|apiKey|apiToken|accessToken|refreshToken|clientSecret|secret|cvv|cardNumber|pin)$/i;

/** Only plain JSON, free from credentials or non-serializable values, may enter the outbox. */
export function validateOfflinePayload(value: unknown, depth = 0): boolean {
  if (depth > 20) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) {
    return value.length <= 10000 && value.every((item) => validateOfflinePayload(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (Object.getPrototypeOf(obj) !== Object.prototype && Object.getPrototypeOf(obj) !== null) return false;
  return Object.entries(obj).every(
    ([key, entry]) => !SENSITIVE_KEY.test(key) && validateOfflinePayload(entry, depth + 1)
  );
}

export function classifyOfflineResponse(status: number): OfflineOutcome {
  if (status >= 200 && status < 300) return "acknowledged";
  if (status === 401) return "paused";
  if (status === 409) return "conflict";
  if (status === 408 || status === 429 || status >= 500) return "retry";
  return "rejected";
}

export function offlineRetryDelay(attempts: number): number {
  return Math.min(3000 * 2 ** Math.min(Math.max(0, attempts - 1), 20), 300000);
}

export function isValidOfflineActor(actor: OfflineActor): boolean {
  return Number.isSafeInteger(actor.companyId) && actor.companyId > 0 && actor.userId.trim().length > 0;
}

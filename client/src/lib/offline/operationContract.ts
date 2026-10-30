/** A fail-closed, versioned contract for Phase 1 offline writes. */
export type OfflineOutcome = "acknowledged" | "paused" | "retry" | "conflict" | "rejected";
export type OfflineOperationState = "pending" | "sending" | "acknowledged" | "conflict" | "rejected" | "needs_review";

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

/**
 * Phase 9: match the LAN's narrow Phase 8 capture contract BEFORE storing an
 * offline request. Unsupported attachments, party/stock fields or unbalanced
 * entries must not poison the durable queue and block later valid writes.
 * The server remains authoritative and revalidates independently.
 */
const OFFLINE_JOURNAL_HEADER = new Set([
  "voucherType", "voucherDate", "currency", "optional", "voucherNumber",
  "description", "exchangeRate", "locationId", "effectiveDate",
]);
const OFFLINE_JOURNAL_LINE = new Set([
  "ledgerAccountId", "debitAmount", "creditAmount", "narration",
]);
const OFFLINE_JOURNAL_TOP = new Set(["voucher", "entries", "clientRequestId"]);
const OFFLINE_JOURNAL_MONEY = /^(?:0|[1-9][0-9]{0,14})(?:\\.[0-9]{1,2})?$/;

function offlineJournalCents(value: unknown): bigint | null {
  const text = String(value ?? "0");
  if (!OFFLINE_JOURNAL_MONEY.test(text)) return null;
  const [whole, fractional = ""] = text.split(".");
  return BigInt(whole) * 100n + BigInt((fractional + "00").slice(0, 2));
}

export function isVettedOfflineVoucherPayload(input: unknown): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) return false;
  const data = input as Record<string, unknown>;
  if (Object.keys(data).some((key) => !OFFLINE_JOURNAL_TOP.has(key))) return false;
  if (data.clientRequestId !== undefined &&
      (typeof data.clientRequestId !== "string" ||
       !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(data.clientRequestId))) return false;
  if (!data.voucher || typeof data.voucher !== "object" || Array.isArray(data.voucher)) return false;
  const voucher = data.voucher as Record<string, unknown>;
  if (Object.keys(voucher).some((key) => !OFFLINE_JOURNAL_HEADER.has(key)) ||
      voucher.voucherType !== "Journal" || voucher.optional === true ||
      String(voucher.currency ?? "USD") !== "USD" ||
      voucher.locationId != null || voucher.effectiveDate != null ||
      typeof voucher.voucherDate !== "string" ||
      !/^\\d{4}-\\d{2}-\\d{2}$/.test(voucher.voucherDate)) return false;
  const parsedDate = new Date(voucher.voucherDate + "T00:00:00Z");
  if (!Number.isFinite(parsedDate.getTime()) ||
      parsedDate.toISOString().slice(0, 10) !== voucher.voucherDate) return false;
  if (!Array.isArray(data.entries) || data.entries.length < 2 || data.entries.length > 100) return false;

  let debits = 0n;
  let credits = 0n;
  for (const entry of data.entries) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    const row = entry as Record<string, unknown>;
    if (Object.keys(row).some((key) => !OFFLINE_JOURNAL_LINE.has(key))) return false;
    const account = Number(row.ledgerAccountId);
    if (!Number.isSafeInteger(account) || account <= 0) return false;
    const debit = offlineJournalCents(row.debitAmount);
    const credit = offlineJournalCents(row.creditAmount);
    if (debit === null || credit === null || (debit === 0n) === (credit === 0n)) return false;
    debits += debit;
    credits += credit;
  }
  return debits > 0n && debits === credits;
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

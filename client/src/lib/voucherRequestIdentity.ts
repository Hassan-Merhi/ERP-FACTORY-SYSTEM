import { isPhase5OperationalVoucherRequest, type VoucherRequestPayload } from "@shared/voucherPathIdentityPolicy";
import { shouldReleaseAccountingRequestIdentity } from "./accountingRequestIdentity";

const STORAGE_KEY = "erp_pending_phase5_voucher_request_ids_v1";

type PendingIdentity = {
  requestId: string;
  createdAt: number;
  outcomeUncertain?: boolean;
};

const pending = new Map<string, PendingIdentity>();

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "clientRequestId")
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => [key, canonicalize(child)])
  );
}

function payloadKey(method: string, pathname: string, payload: VoucherRequestPayload): string {
  return `${method.toUpperCase()}:${pathname.split("?")[0]}:${JSON.stringify(canonicalize(payload))}`;
}

function createRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  return `voucher-op-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function persist(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...pending.entries()]));
  } catch {
    // In-memory identity reuse still protects the current tab when storage is unavailable.
  }
}

function hydrate(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, value] = entry;
      if (typeof key !== "string" || !value || typeof value !== "object") continue;
      const stored = value as Record<string, unknown>;
      if (typeof stored.requestId !== "string" || typeof stored.createdAt !== "number") continue;
      pending.set(key, {
        requestId: stored.requestId,
        createdAt: stored.createdAt,
        outcomeUncertain: stored.outcomeUncertain === true,
      });
    }
  } catch {
    // Ignore corrupt storage and continue with a fresh in-memory map.
  }
}

hydrate();

export function attachPhase5VoucherRequestIdentity(
  method: string,
  pathname: string,
  payload: VoucherRequestPayload
): VoucherRequestPayload {
  if (!isPhase5OperationalVoucherRequest(method, pathname)) return payload;
  if (typeof payload.clientRequestId === "string" && payload.clientRequestId.trim()) return payload;

  const key = payloadKey(method, pathname, payload);
  const existing = pending.get(key);
  const requestId = existing?.requestId || createRequestId();
  if (!existing) {
    pending.set(key, { requestId, createdAt: Date.now() });
    persist();
  }
  return { ...payload, clientRequestId: requestId };
}

export function markPhase5VoucherRequestOutcomeUncertain(
  method: string,
  pathname: string,
  payload: VoucherRequestPayload
): void {
  if (!isPhase5OperationalVoucherRequest(method, pathname)) return;
  const key = payloadKey(method, pathname, payload);
  const existing = pending.get(key);
  if (!existing) return;
  pending.set(key, { ...existing, outcomeUncertain: true });
  persist();
}

export function releasePhase5VoucherRequestIdentity(
  method: string,
  pathname: string,
  payload: VoucherRequestPayload,
  definiteOutcome = false
): void {
  if (!isPhase5OperationalVoucherRequest(method, pathname)) return;
  const key = payloadKey(method, pathname, payload);
  const existing = pending.get(key);
  if (existing?.outcomeUncertain && !definiteOutcome) return;
  pending.delete(key);
  persist();
}

export function shouldReleasePhase5VoucherRequestIdentity(status: number, responseCode?: string | number): boolean {
  return shouldReleaseAccountingRequestIdentity(status, responseCode);
}

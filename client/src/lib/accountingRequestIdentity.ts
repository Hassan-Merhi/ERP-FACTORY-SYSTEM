const ACCOUNTING_REQUEST_STORAGE_KEY = "erp_pending_accounting_request_ids_v2";
const ACCOUNTING_REQUEST_OUTCOME_UNCERTAIN = "ACCOUNTING_REQUEST_OUTCOME_UNCERTAIN";

const PHASE4_OPERATIONAL_POST_PATHS = new Set([
  "/api/salary-advances",
  "/api/payroll/bonus-employee",
  "/api/payroll/bulk-bonus-employees",
  "/api/payroll/bulk-withdraw-employees",
  "/api/payroll/deposit-employee",
  "/api/payroll/bulk-deposit-employees",
  "/api/payroll/withdraw-employee",
  "/api/payroll/pay-worker",
  "/api/payroll/bulk-pay-workers",
  "/api/factory/employees/bulk-payroll",
  "/api/factory/employees/bulk-withdraw",
  "/api/factory/employee-bonuses",
  "/api/factory/pos/sale",
  "/api/factory/supplier-payments",
  "/api/factory/advances/cash-adjustment",
  "/api/factory/advances/repay-by-month",
  "/api/factory/advances/post-repayment-vouchers",
  "/api/factory/payrolls/mark-paid-bulk",
]);

type PendingAccountingRequestIdentity = {
  requestId: string;
  createdAt: number;
  outcomeUncertain?: boolean;
};

const pendingAccountingRequestIds = new Map<string, PendingAccountingRequestIdentity>();

type AccountingRequestPayload = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isActiveManualJournal(method: string, pathname: string, data: unknown): data is AccountingRequestPayload {
  return (
    method.toUpperCase() === "POST" &&
    (pathname === "/api/vouchers/journal" || pathname === "/api/vouchers/journal-entries") &&
    isRecord(data) &&
    data.optional !== true
  );
}

function isActivePaymentReceipt(method: string, pathname: string, data: unknown): data is AccountingRequestPayload {
  return (
    method.toUpperCase() === "POST" &&
    pathname === "/api/vouchers/payment-receipt" &&
    isRecord(data) &&
    data.optional !== true &&
    (data.voucherType === "Payment" || data.voucherType === "Receipt")
  );
}

function isActiveDirectVoucher(method: string, pathname: string, data: unknown): data is AccountingRequestPayload {
  return method.toUpperCase() === "POST" && pathname === "/api/vouchers" && isRecord(data) && data.optional !== true;
}

function isActiveGenericVoucher(method: string, pathname: string, data: unknown): data is AccountingRequestPayload {
  if (
    method.toUpperCase() !== "POST" ||
    pathname !== "/api/vouchers/with-entries" ||
    !isRecord(data) ||
    !isRecord(data.voucher)
  ) {
    return false;
  }

  return data.voucher.optional !== true;
}

function isCompanyTransfer(method: string, pathname: string, data: unknown): data is AccountingRequestPayload {
  return (
    method.toUpperCase() === "POST" &&
    (pathname === "/api/simple-company-transfer" || pathname === "/api/inter-company-transfers") &&
    isRecord(data)
  );
}

function isActiveStockTransfer(method: string, pathname: string, data: unknown): data is AccountingRequestPayload {
  return (
    method.toUpperCase() === "POST" && pathname === "/api/stock-transfers" && isRecord(data) && data.voucherId == null
  );
}

function isPhase4OperationalAccountingRequest(
  method: string,
  pathname: string,
  data: unknown
): data is AccountingRequestPayload {
  if (!isRecord(data)) return false;
  const verb = method.toUpperCase();

  if (verb === "POST") {
    if (PHASE4_OPERATIONAL_POST_PATHS.has(pathname)) return true;
    if (/^\/api\/factory\/employees\/[^/]+\/(?:deposit|withdraw)$/.test(pathname)) return true;
    if (/^\/api\/factory\/worker-bonuses\/[^/]+\/pay$/.test(pathname)) return true;
    // Suspending/restoring a container offload moves stock and flips its charge
    // vouchers, so a retransmitted click has to carry the same identity and be
    // replayed by the server instead of being applied a second time.
    if (/^\/api\/offloads\/[^/]+\/toggle-optional$/.test(pathname)) return true;
    // Reversing a factory container offload deletes the offload's raw stock and
    // vouchers, corrects the supplier's locked cost rate and re-posts the
    // pre-offload freight voucher, so a retransmitted reversal must carry one
    // identity and be replayed rather than applied twice.
    if (/^\/api\/factory\/containers\/[^/]+\/reverse-offload$/.test(pathname)) return true;
    if (/^\/api\/factory\/workers\/[^/]+\/bulk-repay-advances$/.test(pathname)) return true;
    if (/^\/api\/factory\/advances\/[^/]+\/repayments$/.test(pathname)) return true;
    return false;
  }

  if (verb === "PATCH") {
    if (/^\/api\/payroll\/runs\/[^/]+$/.test(pathname)) return data.action === "pay";
    if (/^\/api\/factory\/payrolls\/[^/]+\/(?:mark-paid|fix-accounting)$/.test(pathname)) return true;
  }

  return false;
}

export function isProtectedAccountingRequest(
  method: string,
  url: string,
  data: unknown
): data is AccountingRequestPayload {
  const pathname = url.split("?")[0];
  return (
    isActiveManualJournal(method, pathname, data) ||
    isActivePaymentReceipt(method, pathname, data) ||
    isActiveDirectVoucher(method, pathname, data) ||
    isActiveGenericVoucher(method, pathname, data) ||
    isCompanyTransfer(method, pathname, data) ||
    isActiveStockTransfer(method, pathname, data) ||
    isPhase4OperationalAccountingRequest(method, pathname, data)
  );
}

function createClientRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `accounting-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function accountingPayloadKey(method: string, url: string, data: AccountingRequestPayload): string {
  const payload = { ...data };
  delete payload.clientRequestId;
  return `${method.toUpperCase()}:${url.split("?")[0]}:${JSON.stringify(payload)}`;
}

function persistPendingAccountingIdentities(): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(ACCOUNTING_REQUEST_STORAGE_KEY, JSON.stringify([...pendingAccountingRequestIds.entries()]));
  } catch {
    // Storage may be unavailable (privacy mode / quota). In-memory reuse still works.
  }
}

function hydratePendingAccountingIdentities(): void {
  if (typeof localStorage === "undefined") return;
  try {
    const raw = localStorage.getItem(ACCOUNTING_REQUEST_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    for (const entry of parsed) {
      if (!Array.isArray(entry) || entry.length !== 2) continue;
      const [key, value] = entry;
      if (typeof key !== "string" || !isRecord(value)) continue;
      if (typeof value.requestId !== "string" || typeof value.createdAt !== "number") continue;
      pendingAccountingRequestIds.set(key, {
        requestId: value.requestId,
        createdAt: value.createdAt,
        outcomeUncertain: value.outcomeUncertain === true,
      });
    }
  } catch {
    // Ignore corrupt browser storage and start with the in-memory set.
  }
}

hydratePendingAccountingIdentities();

/**
 * Protected accounting writes receive a stable identity before the request is
 * sent. An identity is retained until the client observes a definite outcome.
 * There is deliberately no age- or count-based eviction: losing an unresolved
 * financial request identity can turn an uncertain commit into a duplicate.
 */
export function attachAccountingRequestIdentity(method: string, url: string, data: unknown): unknown {
  if (!isProtectedAccountingRequest(method, url, data)) return data;
  if (typeof data.clientRequestId === "string" && data.clientRequestId.trim()) {
    return data;
  }

  const key = accountingPayloadKey(method, url, data);
  const existing = pendingAccountingRequestIds.get(key);
  const requestId = existing?.requestId || createClientRequestId();
  if (!existing) {
    pendingAccountingRequestIds.set(key, { requestId, createdAt: Date.now() });
    persistPendingAccountingIdentities();
  }

  return { ...data, clientRequestId: requestId };
}

export function markAccountingRequestOutcomeUncertain(method: string, url: string, data: unknown): void {
  if (!isProtectedAccountingRequest(method, url, data)) return;
  const key = accountingPayloadKey(method, url, data);
  const existing = pendingAccountingRequestIds.get(key);
  if (!existing) return;
  pendingAccountingRequestIds.set(key, { ...existing, outcomeUncertain: true });
  persistPendingAccountingIdentities();
}

export function releaseAccountingRequestIdentity(
  method: string,
  url: string,
  data: unknown,
  definiteOutcome = false
): void {
  if (!isProtectedAccountingRequest(method, url, data)) return;
  const key = accountingPayloadKey(method, url, data);
  const existing = pendingAccountingRequestIds.get(key);
  if (existing?.outcomeUncertain && !definiteOutcome) return;
  pendingAccountingRequestIds.delete(key);
  persistPendingAccountingIdentities();
}

export async function accountingResponseCode(response: Response): Promise<string | undefined> {
  if (response.status !== 409) return undefined;
  const payload: unknown = await response
    .clone()
    .json()
    .catch(() => null);
  return isRecord(payload) && typeof payload.code === "string" ? payload.code : undefined;
}

export function shouldReleaseAccountingRequestIdentity(status: number, responseCode?: string | number): boolean {
  // A 409 without a readable code is conservative by design: it may be the
  // fail-closed uncertain-outcome response, so never mint a fresh key for it.
  if (status === 409 && (responseCode == null || responseCode === ACCOUNTING_REQUEST_OUTCOME_UNCERTAIN)) {
    return false;
  }
  return (status >= 200 && status < 400) || (status >= 400 && status < 500);
}

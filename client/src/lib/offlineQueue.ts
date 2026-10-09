const QUEUE_KEY = "erp_offline_queue";
const LAST_SYNCED_KEY = "erp_last_synced";
const QUEUE_WARN_THRESHOLD = 50;

export type QueueItemStatus = "pending" | "failed";

export interface QueueItem {
  id: string;
  url: string;
  method: string;
  body: string;
  description: string;
  timestamp: number;
  status: QueueItemStatus;
  failReason?: string;
  clientDate?: string;
}

function readQueue(): QueueItem[] {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function writeQueue(items: QueueItem[]): void {
  localStorage.setItem(QUEUE_KEY, JSON.stringify(items));
}

export function getQueue(): QueueItem[] {
  return readQueue();
}

export function enqueueRequest(
  url: string,
  method: string,
  body: string,
  description: string,
  clientDate?: string
): string {
  const queue = readQueue();
  const upperMethod = method.toUpperCase();

  // Dedup: for PATCH/PUT, collapse multiple edits to the same URL into one
  if (upperMethod === "PATCH" || upperMethod === "PUT") {
    const existingIdx = queue.findIndex(
      (i) => i.url === url && i.method.toUpperCase() === upperMethod && i.status === "pending"
    );
    if (existingIdx !== -1) {
      queue[existingIdx] = {
        ...queue[existingIdx],
        body,
        description,
        timestamp: Date.now(),
      };
      writeQueue(queue);
      return queue[existingIdx].id;
    }
  }

  if (upperMethod === "DELETE") {
    const filtered = queue.filter(
      (i) => !(i.url === url && i.status === "pending" && i.method.toUpperCase() !== "DELETE")
    );
    if (filtered.length !== queue.length) writeQueue(filtered);
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const item: QueueItem = {
    id,
    url,
    method: upperMethod,
    body,
    description,
    timestamp: Date.now(),
    status: "pending",
    clientDate,
  };
  const currentQueue = readQueue();
  currentQueue.push(item);
  writeQueue(currentQueue);

  if (currentQueue.length === QUEUE_WARN_THRESHOLD) {
    queueSizeWarningCallbacks.forEach((cb) => cb(currentQueue.length));
  }

  return id;
}

export function updateItemStatus(id: string, status: QueueItemStatus, failReason?: string): void {
  const queue = readQueue().map((item) =>
    item.id === id ? { ...item, status, failReason: failReason ?? item.failReason } : item
  );
  writeQueue(queue);
}

export function removeFromQueue(id: string): void {
  writeQueue(readQueue().filter((item) => item.id !== id));
}

export function clearQueue(): void {
  localStorage.removeItem(QUEUE_KEY);
}

export function getLastSynced(): number | null {
  const raw = localStorage.getItem(LAST_SYNCED_KEY);
  return raw ? parseInt(raw, 10) : null;
}

export function setLastSynced(): void {
  localStorage.setItem(LAST_SYNCED_KEY, String(Date.now()));
}

/**
 * Financial repair, replay, undo and row-allocation requests are online-only.
 * Keep this deny-list ahead of the allow-list so a future broad SAFE_PATTERNS
 * entry cannot accidentally make a signed, expiring or lock-sensitive action
 * replay later from localStorage.
 */
const NEVER_QUEUE_PATTERNS: RegExp[] = [
  /^\/api\/factory\/raw-stock\/recalc(?:\/|$)/,
  /^\/api\/factory\/raw-stock\/\d+\/assign-to-bales$/,
  // Credential-bearing endpoints. A manager approval or a password change must be typed
  // again while online; replaying a stored secret hours later is both stale and unsafe.
  /^\/api\/pos\/retail\/discount-approvals$/,
  /^\/api\/auth\/(?:login|logout|change-password)$/,
  /^\/api\/user\/change-password$/,
];

/**
 * Payload keys that must never be persisted to localStorage. The queue only stores
 * JSON request bodies, so a defensive scan keeps a future allow-listed endpoint from
 * dropping a password, API token or card secret into clear-text browser storage.
 */
const SENSITIVE_PAYLOAD_KEY =
  /^(?:password|passwd|pwd|oldPassword|currentPassword|newPassword|confirmPassword|managerPassword|supervisorPassword|passwordHash|authorization|apiKey|apiToken|accessToken|refreshToken|clientSecret|secret|cvv|cardNumber|pin)$/i;

/**
 * True when a request payload carries credentials anywhere in its JSON shape.
 * The scan is depth-limited because request bodies are shallow by construction.
 */
export function containsSensitiveCredentials(value: unknown, depth = 0): boolean {
  if (depth > 6 || value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveCredentials(entry, depth + 1));
  }
  return Object.entries(value as Record<string, unknown>).some(
    ([key, entry]) => SENSITIVE_PAYLOAD_KEY.test(key) || containsSensitiveCredentials(entry, depth + 1)
  );
}

const SAFE_PATTERNS: Array<{ method: string; pattern: RegExp }> = [
  { method: "POST", pattern: /^\/api\/auth\/set-company$/ },
  { method: "POST", pattern: /^\/api\/customers$/ },
  { method: "PUT", pattern: /^\/api\/customers\/\d+$/ },
  { method: "PATCH", pattern: /^\/api\/suppliers\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/suppliers\/\d+$/ },
  { method: "PATCH", pattern: /^\/api\/purchase-orders\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/purchase-orders\/\d+$/ },
  { method: "PUT", pattern: /^\/api\/vouchers\/\d+\/with-entries$/ },
  { method: "PATCH", pattern: /^\/api\/vouchers\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/vouchers\/\d+$/ },
  { method: "POST", pattern: /^\/api\/vouchers\/\d+\/finalize$/ },
  { method: "POST", pattern: /^\/api\/inventory\/quick-adjust$/ },
  { method: "POST", pattern: /^\/api\/pos\/sales$/ },
  { method: "POST", pattern: /^\/api\/pos\/drafts$/ },
  { method: "PATCH", pattern: /^\/api\/pos\/drafts\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/pos\/drafts\/\d+$/ },
  { method: "POST", pattern: /^\/api\/pos\/customers$/ },
  { method: "POST", pattern: /^\/api\/vouchers$/ },
  { method: "POST", pattern: /^\/api\/vouchers\/payment-receipt$/ },
  { method: "POST", pattern: /^\/api\/vouchers\/journal$/ },
  { method: "PATCH", pattern: /^\/api\/vouchers\/\d+\/payment-receipt$/ },
  { method: "PATCH", pattern: /^\/api\/vouchers\/\d+\/journal$/ },
  { method: "PATCH", pattern: /^\/api\/vouchers\/\d+\/sales$/ },
  { method: "PUT", pattern: /^\/api\/vouchers\/\d+\/sales$/ },
  { method: "POST", pattern: /^\/api\/factory\/stock-entry$/ },
  { method: "POST", pattern: /^\/api\/factory\/stock-entry\/remove$/ },
  { method: "POST", pattern: /^\/api\/factory\/stock-entry\/remove-by-product$/ },
  { method: "POST", pattern: /^\/api\/factory\/bale-products$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/bale-products\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/bale-products\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/bale-products\/\d+\/cascade-update$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/bales\/\d+\/assign-worker$/ },
  { method: "POST", pattern: /^\/api\/factory\/customer-orders-loading$/ },
  { method: "POST", pattern: /^\/api\/factory\/customer-orders\/\d+\/bales$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/customer-orders\/\d+\/bales\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/customer-orders\/\d+\/finalize-loading$/ },
  { method: "POST", pattern: /^\/api\/factory\/vouchers$/ },
  { method: "POST", pattern: /^\/api\/factory\/vouchers\/payment-receipt$/ },
  { method: "POST", pattern: /^\/api\/factory\/vouchers\/journal$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/vouchers\/\d+\/payment-receipt$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/vouchers\/\d+\/journal$/ },
  { method: "POST", pattern: /^\/api\/factory\/mix-batches$/ },
  { method: "POST", pattern: /^\/api\/factory\/mix-batches\/\d+\/assign-bales$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/mix-batches\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/mix-batches\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/daybook$/ },
  { method: "PUT", pattern: /^\/api\/factory\/daybook\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/daybook\/entry\/\d+\/void$/ },
  { method: "POST", pattern: /^\/api\/factory\/categories$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/categories\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/categories\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/suppliers$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/suppliers\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/suppliers\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/suppliers\/\d+\/permanent$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/suppliers\/\d+\/opening-balance$/ },
  { method: "POST", pattern: /^\/api\/factory\/supplier-payments$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/supplier-payments\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/supplier-fx-transfers$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/supplier-fx-transfers\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/raw-stock\/opening-balance$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/raw-stock\/opening-balance\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/raw-stock\/opening-balance\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/containers$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/containers\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/containers\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/containers\/\d+\/other-charges\/sync$/ },
  { method: "POST", pattern: /^\/api\/factory\/containers\/\d+\/reverse-offload$/ },
  { method: "POST", pattern: /^\/api\/factory\/containers\/import-excel$/ },
  { method: "POST", pattern: /^\/api\/factory\/attendance\/bulk$/ },
  { method: "POST", pattern: /^\/api\/factory\/waste$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/waste\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/workers$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/workers\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/workers\/\d+\/advances$/ },
  { method: "POST", pattern: /^\/api\/factory\/advances\/\d+\/repayments$/ },
  { method: "POST", pattern: /^\/api\/factory\/advances\/bulk$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/advances\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/workers\/\d+\/documents\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/employees$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/employees\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/employees\/\d+\/deposit$/ },
  { method: "POST", pattern: /^\/api\/factory\/employees\/\d+\/withdraw$/ },
  { method: "POST", pattern: /^\/api\/factory\/customers$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/customers\/\d+$/ },
  { method: "PUT", pattern: /^\/api\/factory\/customers\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/customers\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/customer-proformas$/ },
  { method: "POST", pattern: /^\/api\/factory\/customer-proformas\/bulk$/ },
  { method: "PUT", pattern: /^\/api\/factory\/customer-proformas\/\d+$/ },
  { method: "PUT", pattern: /^\/api\/factory\/customer-proformas\/\d+\/replace-lines$/ },
  { method: "POST", pattern: /^\/api\/factory\/customer-proformas\/\d+\/apply-catalog-prices$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/customer-proformas\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/customer-proforma-lines$/ },
  { method: "PUT", pattern: /^\/api\/factory\/customer-proforma-lines\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/customer-proforma-lines\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/alerts$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/alerts\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/alerts\/\d+$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/payroll\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/payroll\/\d+\/undo$/ },
  { method: "PATCH", pattern: /^\/api\/factory\/payrolls\/\d+\/mark-paid$/ },
  { method: "POST", pattern: /^\/api\/factory\/payrolls\/mark-paid-bulk$/ },
  { method: "POST", pattern: /^\/api\/stock-adjustments$/ },
  { method: "PUT", pattern: /^\/api\/stock-adjustments\/\d+$/ },
  { method: "POST", pattern: /^\/api\/stock-transfers$/ },
  { method: "PUT", pattern: /^\/api\/stock-transfers\/\d+$/ },
  { method: "POST", pattern: /^\/api\/bale-label-prints$/ },
  { method: "POST", pattern: /^\/api\/bale-transfers$/ },
  { method: "PATCH", pattern: /^\/api\/containers\/\d+\/number$/ },
  { method: "PATCH", pattern: /^\/api\/containers\/\d+\/tracking$/ },
  { method: "DELETE", pattern: /^\/api\/containers\/\d+$/ },
  { method: "POST", pattern: /^\/api\/containers\/\d+\/reverse-offload$/ },
  { method: "POST", pattern: /^\/api\/containers\/\d+\/loaded-items$/ },
  { method: "PATCH", pattern: /^\/api\/container-loaded-items\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/container-loaded-items\/\d+$/ },
  { method: "POST", pattern: /^\/api\/containers\/\d+\/import-loaded-items$/ },
  { method: "POST", pattern: /^\/api\/container-sales$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/containers\/\d+\/documents\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/containers\/\d+\/freight$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/containers\/\d+\/freight\/\d+$/ },
  { method: "POST", pattern: /^\/api\/factory\/freight\/\d+\/payments$/ },
  { method: "DELETE", pattern: /^\/api\/factory\/freight\/\d+\/payments\/\d+$/ },
  { method: "POST", pattern: /^\/api\/suppliers\/\d+\/proformas$/ },
  { method: "DELETE", pattern: /^\/api\/suppliers\/\d+\/proformas\/\d+$/ },
  { method: "POST", pattern: /^\/api\/suppliers\/\d+\/proformas\/\d+\/lines$/ },
  { method: "PATCH", pattern: /^\/api\/supplier-proforma-lines\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/supplier-proforma-lines\/\d+$/ },
  { method: "POST", pattern: /^\/api\/suppliers\/\d+\/proformas\/\d+\/import-lines$/ },
  { method: "POST", pattern: /^\/api\/pending-barcodes$/ },
  { method: "DELETE", pattern: /^\/api\/pending-barcodes\/\d+$/ },
  { method: "PATCH", pattern: /^\/api\/pending-barcodes\/mark-printed$/ },
  { method: "POST", pattern: /^\/api\/stock-items\/bulk-delete$/ },
  { method: "POST", pattern: /^\/api\/stock-items\/bulk-update-uom$/ },
  { method: "DELETE", pattern: /^\/api\/locations\/\d+$/ },
  { method: "POST", pattern: /^\/api\/stock-group-archives$/ },
  { method: "POST", pattern: /^\/api\/factory\/waste-dispatch\/submit$/ },
  { method: "POST", pattern: /^\/api\/factory\/pressing\/create-multi$/ },
  { method: "POST", pattern: /^\/api\/spreadsheets$/ },
  { method: "PATCH", pattern: /^\/api\/spreadsheets\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/spreadsheets\/\d+$/ },
  { method: "POST", pattern: /^\/api\/live-spreadsheets$/ },
  { method: "PATCH", pattern: /^\/api\/live-spreadsheets\/\d+$/ },
  { method: "DELETE", pattern: /^\/api\/live-spreadsheets\/\d+$/ },
  { method: "POST", pattern: /^\/api\/deleted-items\/\w+\/\d+\/restore$/ },
  { method: "DELETE", pattern: /^\/api\/deleted-items\/\w+\/\d+\/permanent$/ },
];

export function isSafeToQueue(method: string, url: string): boolean {
  const path = url.split("?", 1)[0];
  if (NEVER_QUEUE_PATTERNS.some((pattern) => pattern.test(path))) return false;
  return SAFE_PATTERNS.some((p) => p.method === method.toUpperCase() && p.pattern.test(path));
}

export function getDescriptionForRequest(url: string): string {
  if (/\/api\/pos\/sales/.test(url)) return "POS Sale";
  if (/\/api\/pos\/drafts/.test(url)) return "POS Draft";
  if (/\/api\/vouchers\/payment-receipt/.test(url)) return "Payment / Receipt";
  if (/\/api\/vouchers\/journal/.test(url)) return "Journal Entry";
  if (/\/api\/vouchers\/\d+\/sales/.test(url)) return "Sales Voucher Update";
  if (/\/api\/vouchers/.test(url)) return "Voucher";
  if (/\/api\/factory\/stock-entry\/remove-by-product/.test(url)) return "Remove Bales by Product";
  if (/\/api\/factory\/stock-entry\/remove/.test(url)) return "Stock Entry Removal";
  if (/\/api\/factory\/stock-entry/.test(url)) return "Factory Stock Entry";
  if (/\/api\/factory\/bale-products\/\d+\/cascade-update/.test(url)) return "Bale Product Update";
  if (/\/api\/factory\/bale-products/.test(url)) return "Bale Product";
  if (/\/api\/factory\/bales\/\d+\/assign-worker/.test(url)) return "Worker Assignment";
  if (/\/api\/factory\/categories/.test(url)) return "Bale Category";
  if (/\/api\/factory\/customer-orders-loading/.test(url)) return "Loading Order";
  if (/\/api\/factory\/customer-orders\/\d+\/bales\/\d+/.test(url)) return "Bale Removal";
  if (/\/api\/factory\/customer-orders\/\d+\/bales/.test(url)) return "Loading Scan";
  if (/\/api\/factory\/customer-orders\/\d+\/finalize-loading/.test(url)) return "Finalize Loading";
  if (/\/api\/factory\/vouchers\/payment-receipt/.test(url)) return "Factory Payment";
  if (/\/api\/factory\/vouchers\/journal/.test(url)) return "Factory Journal";
  if (/\/api\/factory\/vouchers/.test(url)) return "Factory Voucher";
  if (/\/api\/factory\/mix-batches\/\d+\/assign-bales/.test(url)) return "Mix Batch Bale Assignment";
  if (/\/api\/factory\/mix-batches/.test(url)) return "Mix Batch";
  if (/\/api\/factory\/daybook\/entry\/\d+\/void/.test(url)) return "Daybook Void";
  if (/\/api\/factory\/daybook/.test(url)) return "Factory Daybook";
  if (/\/api\/factory\/supplier-payments/.test(url)) return "Supplier Payment";
  if (/\/api\/factory\/supplier-fx-transfers/.test(url)) return "FX Transfer";
  if (/\/api\/factory\/suppliers\/\d+\/opening-balance/.test(url)) return "Supplier Opening Balance";
  if (/\/api\/factory\/suppliers\/\d+\/permanent/.test(url)) return "Supplier Permanent Delete";
  if (/\/api\/factory\/suppliers/.test(url)) return "Supplier";
  if (/\/api\/factory\/raw-stock\/opening-balance/.test(url)) return "Raw Stock Opening Balance";
  if (/\/api\/factory\/containers\/\d+\/other-charges\/sync/.test(url)) return "Container Charges";
  if (/\/api\/factory\/containers\/\d+\/reverse-offload/.test(url)) return "Container Reverse Offload";
  if (/\/api\/factory\/containers\/import-excel/.test(url)) return "Container Excel Import";
  if (/\/api\/factory\/containers/.test(url)) return "Container";
  if (/\/api\/factory\/attendance/.test(url)) return "Attendance";
  if (/\/api\/factory\/waste/.test(url)) return "Waste Entry";
  if (/\/api\/factory\/workers\/\d+\/advances/.test(url)) return "Worker Advance";
  if (/\/api\/factory\/workers\/\d+\/documents/.test(url)) return "Worker Document";
  if (/\/api\/factory\/advances\/\d+\/repayments/.test(url)) return "Advance Repayment";
  if (/\/api\/factory\/advances\/bulk/.test(url)) return "Bulk Advance";
  if (/\/api\/factory\/advances/.test(url)) return "Worker Advance";
  if (/\/api\/factory\/workers/.test(url)) return "Worker";
  if (/\/api\/factory\/employees\/\d+\/deposit/.test(url)) return "Employee Deposit";
  if (/\/api\/factory\/employees\/\d+\/withdraw/.test(url)) return "Employee Withdrawal";
  if (/\/api\/factory\/employees/.test(url)) return "Employee";
  if (/\/api\/factory\/customers/.test(url)) return "Customer";
  if (/\/api\/factory\/customer-proforma-lines/.test(url)) return "Proforma Line";
  if (/\/api\/factory\/customer-proformas\/\d+\/apply-catalog-prices/.test(url)) return "Proforma Catalog Pricing";
  if (/\/api\/factory\/customer-proformas\/\d+\/replace-lines/.test(url)) return "Proforma Lines";
  if (/\/api\/factory\/customer-proformas\/bulk/.test(url)) return "Bulk Proforma";
  if (/\/api\/factory\/customer-proformas/.test(url)) return "Proforma";
  if (/\/api\/factory\/payrolls\/\d+\/mark-paid/.test(url)) return "Payroll Payment";
  if (/\/api\/factory\/payrolls\/mark-paid-bulk/.test(url)) return "Bulk Payroll Payment";
  if (/\/api\/factory\/payroll\/\d+\/undo/.test(url)) return "Payroll Undo";
  if (/\/api\/factory\/payroll/.test(url)) return "Payroll";
  if (/\/api\/factory\/alerts/.test(url)) return "Alert";
  if (/\/api\/stock-adjustments/.test(url)) return "Stock Adjustment";
  if (/\/api\/stock-transfers/.test(url)) return "Stock Transfer";
  if (/\/api\/bale-label-prints/.test(url)) return "Label Print";
  if (/\/api\/bale-transfers/.test(url)) return "Bale Transfer";
  return "Action";
}

type SizeWarningCallback = (count: number) => void;
const queueSizeWarningCallbacks: SizeWarningCallback[] = [];

export function onQueueSizeWarning(cb: SizeWarningCallback): () => void {
  queueSizeWarningCallbacks.push(cb);
  return () => {
    const idx = queueSizeWarningCallbacks.indexOf(cb);
    if (idx !== -1) queueSizeWarningCallbacks.splice(idx, 1);
  };
}

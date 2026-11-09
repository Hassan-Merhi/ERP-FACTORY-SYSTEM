/**
 * Standalone browser offline mode (Phase 15): which writes a laptop's browser
 * may save while it has no internet, and why every other write must wait.
 *
 * A write is supported only when the cloud can replay it exactly once from what
 * the person entered, with its normal checks, and report any disagreement
 * instead of overwriting (server/offline/browserSync/browserOperationKinds.ts
 * holds the same list). Everything else is refused on the laptop with a reason.
 */

export interface SupportedOfflineWrite {
  kind: string;
  stream: "payments" | "stock" | "pos";
  method: "POST";
  path: string;
  /** What the person sees in the queue. */
  title: string;
  /** Short label for one saved record (no notes, parties or credentials). */
  label(input: Record<string, unknown>): string;
}

function amount(value: unknown): string {
  const n = Number(value);
  return Number.isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 2 }) : "";
}

function sumEntries(entries: unknown): string {
  if (!Array.isArray(entries)) return "";
  const total = entries.reduce((sum, entry) => sum + (Number((entry as { amount?: unknown })?.amount) || 0), 0);
  return amount(total);
}

function lineCount(items: unknown): number {
  return Array.isArray(items) ? items.length : 0;
}

export const SUPPORTED_OFFLINE_WRITES: readonly SupportedOfflineWrite[] = Object.freeze([
  {
    kind: "voucher.payment-receipt.v1",
    stream: "payments",
    method: "POST",
    path: "/api/vouchers/payment-receipt",
    title: "Payment / Receipt",
    label: (input) => `${String(input.voucherType ?? "Payment")} ${sumEntries(input.entries)}`.trim(),
  },
  {
    kind: "stock.quick-adjust.v1",
    stream: "stock",
    method: "POST",
    path: "/api/inventory/quick-adjust",
    title: "Stock adjustment",
    label: (input) => `${input.type === "subtract" ? "Remove" : "Add"} ${amount(input.quantity)}`,
  },
  {
    kind: "stock.transfer.v1",
    stream: "stock",
    method: "POST",
    path: "/api/stock-transfers",
    title: "Stock transfer",
    label: (input) => `${lineCount(input.items)} line(s)`,
  },
  {
    kind: "stock.item-create.v1",
    stream: "stock",
    method: "POST",
    path: "/api/stock-items",
    title: "New stock item",
    label: (input) => String(input.code ?? "").slice(0, 50),
  },
  {
    kind: "pos.sale.v1",
    stream: "pos",
    method: "POST",
    path: "/api/pos/sales",
    title: "POS sale",
    label: (input) => {
      const total = Array.isArray(input.items)
        ? input.items.reduce(
            (sum, item) =>
              sum +
              (Number((item as { quantity?: unknown }).quantity) || 0) *
                (Number((item as { rate?: unknown }).rate) || 0),
            0
          )
        : 0;
      return `${lineCount(input.items)} line(s) · ${amount(total)}`;
    },
  },
]);

export function supportedOfflineWrite(method: string, path: string): SupportedOfflineWrite | null {
  const upper = method.toUpperCase();
  return SUPPORTED_OFFLINE_WRITES.find((write) => write.method === upper && write.path === path) ?? null;
}

export function supportedOfflineKind(kind: string): SupportedOfflineWrite | null {
  return SUPPORTED_OFFLINE_WRITES.find((write) => write.kind === kind) ?? null;
}

export type OfflineUnavailableCategory =
  | "existing-record"
  | "pressing"
  | "files"
  | "back-office"
  | "administration"
  | "integration"
  | "credentials"
  | "not-reviewed";

interface UnavailableRule {
  category: OfflineUnavailableCategory;
  test(method: string, path: string): boolean;
  reason: string;
}

const UNAVAILABLE_RULES: readonly UnavailableRule[] = Object.freeze([
  {
    category: "credentials",
    test: (_method, path) => /\/(?:password|manager-approval|discount-approval|login|2fa|mfa)\b/.test(path),
    reason: "It needs a password or a manager's approval checked by the server at that moment.",
  },
  {
    category: "pressing",
    test: (_method, path) => path.startsWith("/api/factory/pressing"),
    reason:
      "A pressing scan needs the machine's current assignment, the bale and the shift day from the cloud at the moment of the scan.",
  },
  {
    category: "files",
    test: (_method, path) => path.startsWith("/api/files") || path.includes("/attachments") || path.includes("/upload"),
    reason: "Files are not kept on the laptop; upload them once the connection is back.",
  },
  {
    category: "integration",
    test: (_method, path) =>
      /^\/api\/(?:whatsapp|chatbot|git|screen-feed|email|sms|notifications|integrations)/.test(path),
    reason: "It talks to an outside service that cannot be reached offline.",
  },
  {
    category: "administration",
    test: (_method, path) =>
      /^\/api\/(?:auth|users|admin|settings|permissions|roles|companies|company|access|developer)/.test(path),
    reason: "Users, permissions and settings must change in one place only, so they need the cloud.",
  },
  {
    category: "back-office",
    test: (_method, path) =>
      /^\/api\/(?:payroll|properties|rental|accounting|fiscal|ledger-accounts|cost-centers|insurance|sp\/|erp\/payroll)/.test(
        path
      ) || /^\/api\/factory\/(?:payroll|rental|advances|production-target-bonuses|fx-agent-wallets)/.test(path),
    reason: "Payroll, rentals and month-end accounting can wait for the connection and must not conflict.",
  },
  {
    category: "existing-record",
    test: (method) => ["PUT", "PATCH", "DELETE"].includes(method.toUpperCase()),
    reason:
      "Changing or deleting an existing record needs the cloud's current version of it, so nothing is overwritten. Do it when you are back online.",
  },
]);

/** Every category of write that needs a connection, in the order shown to the user. */
export const OFFLINE_UNAVAILABLE_CATEGORIES: readonly OfflineUnavailableCategory[] = Object.freeze([
  "existing-record",
  "pressing",
  "files",
  "back-office",
  "administration",
  "integration",
  "credentials",
  "not-reviewed",
]);

export interface OfflineAvailability {
  available: boolean;
  category: OfflineUnavailableCategory | null;
  reason: string | null;
}

export function offlineAvailability(method: string, path: string): OfflineAvailability {
  if (supportedOfflineWrite(method, path)) return { available: true, category: null, reason: null };
  const rule = UNAVAILABLE_RULES.find((candidate) => candidate.test(method, path));
  return {
    available: false,
    category: rule?.category ?? "not-reviewed",
    reason:
      rule?.reason ??
      "This action has not been made safe to save offline: the server must check it when it happens. Try again when you are back online.",
  };
}

// Extracted from ./AuditLogDialog.tsx to keep that module under the source-size cap.
import type { ReactNode } from "react";
import {
  BUSINESS_FIELD_LABELS,
  fieldLabel,
  fmtBusinessValue,
  fmtDate,
  getRecordLabel,
  normalizeAuditChanges,
  securityActionSummary,
  tableShortName,
} from "./AuditLogUtils";

export type AuditJson = unknown;

export type AuditEntry = {
  account?: unknown;
  debit?: unknown;
  credit?: unknown;
  narration?: unknown;
  [key: string]: unknown;
};

export type AuditItem = {
  stockItemId?: unknown;
  stockItemName?: unknown;
  itemName?: unknown;
  code?: unknown;
  sourceLocationId?: unknown;
  sourceLocationName?: unknown;
  originalQuantity?: unknown;
  quantity?: unknown;
  newQuantity?: unknown;
  delta?: unknown;
  rate?: unknown;
  unitPrice?: unknown;
  totalAmount?: unknown;
  [key: string]: unknown;
};

function fmtItemNumber(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return fmtBusinessValue(field, value);
}

export function RevisionItemsTable({ items, label }: { items: AuditItem[]; label?: string }) {
  if (items.length === 0) return null;
  const showRate = items.some((item) => item.rate !== undefined || item.unitPrice !== undefined);
  const showTotal = items.some((item) => item.totalAmount !== undefined);

  return (
    <div className="space-y-1.5">
      {label && <p className="text-xs font-medium text-muted-foreground">{label}</p>}
      <div className="overflow-x-auto rounded-md border">
        <div
          className={`grid min-w-[680px] ${
            showRate && showTotal
              ? "grid-cols-[minmax(180px,1.4fr)_minmax(150px,1fr)_90px_90px_90px_90px_100px]"
              : showRate || showTotal
                ? "grid-cols-[minmax(200px,1.5fr)_minmax(170px,1fr)_95px_95px_95px_100px]"
                : "grid-cols-[minmax(220px,1.5fr)_minmax(180px,1fr)_100px_100px_100px]"
          } gap-2 bg-muted/40 px-3 py-2 text-[11px] font-medium text-muted-foreground`}
        >
          <span>Item</span>
          <span>Source</span>
          <span className="text-right">Before</span>
          <span className="text-right">After</span>
          <span className="text-right">Change</span>
          {showRate && <span className="text-right">Rate</span>}
          {showTotal && <span className="text-right">Total</span>}
        </div>
        {items.map((item, index) => {
          const itemName = String(item.stockItemName ?? item.itemName ?? item.code ?? `Item ${index + 1}`);
          const sourceName = String(item.sourceLocationName ?? "—");
          const before = item.originalQuantity;
          const after = item.newQuantity ?? item.quantity;
          const delta =
            item.delta !== undefined
              ? item.delta
              : Number.isFinite(Number(after)) && Number.isFinite(Number(before))
                ? Number(after) - Number(before)
                : undefined;
          const rate = item.rate ?? item.unitPrice;

          return (
            <div
              key={`${item.stockItemId ?? item.code ?? itemName}-${item.sourceLocationId ?? "source"}-${index}`}
              className={`grid min-w-[680px] ${
                showRate && showTotal
                  ? "grid-cols-[minmax(180px,1.4fr)_minmax(150px,1fr)_90px_90px_90px_90px_100px]"
                  : showRate || showTotal
                    ? "grid-cols-[minmax(200px,1.5fr)_minmax(170px,1fr)_95px_95px_95px_100px]"
                    : "grid-cols-[minmax(220px,1.5fr)_minmax(180px,1fr)_100px_100px_100px]"
              } gap-2 border-t px-3 py-2.5 text-xs items-start`}
            >
              <div className="min-w-0">
                <div className="font-medium wrap-break-word">{itemName}</div>
                {item.stockItemId !== undefined && (
                  <div className="text-[11px] text-muted-foreground">ID {String(item.stockItemId)}</div>
                )}
              </div>
              <div className="min-w-0">
                <div className="wrap-break-word">{sourceName}</div>
                {item.sourceLocationId !== undefined && (
                  <div className="text-[11px] text-muted-foreground">ID {String(item.sourceLocationId)}</div>
                )}
              </div>
              <span className="text-right tabular-nums">{fmtItemNumber("quantity", before)}</span>
              <span className="text-right tabular-nums font-medium">{fmtItemNumber("quantity", after)}</span>
              <span className="text-right tabular-nums">{fmtItemNumber("quantity", delta)}</span>
              {showRate && <span className="text-right tabular-nums">{fmtItemNumber("rate", rate)}</span>}
              {showTotal && (
                <span className="text-right tabular-nums">{fmtItemNumber("totalAmount", item.totalAmount)}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function compareEntries(oldArr: AuditEntry[], newArr: AuditEntry[]) {
  const oldMap = new Map(oldArr.map((entry) => [String(entry.account || "Unknown account"), entry]));
  const newMap = new Map(newArr.map((entry) => [String(entry.account || "Unknown account"), entry]));
  const added = [];
  const removed = [];
  const changed: Array<{ account: string; old: AuditEntry; new: AuditEntry }> = [];

  for (const [account, entry] of newMap) {
    if (!oldMap.has(account)) {
      added.push(entry);
      continue;
    }
    const old = oldMap.get(account)!;
    if (
      parseFloat(String(old.debit || "0")) !== parseFloat(String(entry.debit || "0")) ||
      parseFloat(String(old.credit || "0")) !== parseFloat(String(entry.credit || "0")) ||
      String(old.narration ?? "") !== String(entry.narration ?? "")
    ) {
      changed.push({ account, old, new: entry });
    }
  }

  for (const [account, entry] of oldMap) {
    if (!newMap.has(account)) removed.push(entry);
  }

  return { added, removed, changed };
}

const ACTION_VERBS: Record<string, string> = {
  create: "created",
  update: "updated",
  delete: "deleted",
  restore: "restored",
  reverse: "reversed",
  void: "voided",
  return: "returned",
  recalculate: "recalculated",
  repair: "repaired",
  import: "imported",
  export: "exported",
  send_whatsapp: "sent to WhatsApp",
  send_email: "sent by email",
  approve: "approved",
  cancel: "cancelled",
  offload: "offloaded",
  transfer: "transferred",
  adjust: "adjusted",
  login: "logged in through",
  permission_change: "changed permissions for",
  settings_change: "changed settings for",
};

export function getHeaderSentence(log: Record<string, unknown>): string {
  const user =
    log.username && log.username !== "unknown"
      ? log.username
      : log.userId
        ? `User #${String(log.userId).slice(0, 8)}`
        : "Unknown user";

  if (
    log.tableName === "security_events" ||
    String(log.action || "")
      .toUpperCase()
      .startsWith("SECURITY:")
  ) {
    return `${String(user)}: ${securityActionSummary(log)} on ${fmtDate(String(log.createdAt ?? ""))}.`;
  }

  const changes = normalizeAuditChanges(log);
  const actionKey = String(log.action ?? "").toLowerCase();
  const verb = ACTION_VERBS[actionKey] || "recorded activity for";
  const voucherTypeRaw =
    changes.voucherType?.new ?? changes.voucherType?.old ?? changes.type?.new ?? changes.type?.old ?? "";
  const voucherType = typeof voucherTypeRaw === "string" ? voucherTypeRaw : String(voucherTypeRaw ?? "");
  const moduleName = tableShortName(String(log.tableName ?? "")).replace(/s$/, "");
  const subject = voucherType ? `${voucherType} ${moduleName.toLowerCase()}` : moduleName.toLowerCase();
  const record = getRecordLabel(log);
  const recordPart = record && record !== tableShortName(String(log.tableName ?? "")) ? ` ${record}` : "";
  return `${String(user)} ${verb} ${subject}${recordPart} on ${fmtDate(String(log.createdAt ?? ""))}.`;
}

export function StructuredValue({
  field,
  value,
  depth = 0,
}: {
  field: string;
  value: AuditJson;
  depth?: number;
}): ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">—</span>;
  }

  if (depth >= 4) {
    return <span className="break-all whitespace-pre-wrap">{JSON.stringify(value)}</span>;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="text-muted-foreground">None</span>;
    if (value.every((item) => item === null || ["string", "number", "boolean"].includes(typeof item))) {
      return (
        <span className="wrap-break-word whitespace-pre-wrap">{value.map((item) => String(item)).join(", ")}</span>
      );
    }
    return (
      <div className="space-y-2 min-w-0">
        {value.map((item, index) => (
          <div key={index} className="rounded-sm border bg-background/60 p-2 min-w-0">
            <div className="text-[11px] font-medium text-muted-foreground mb-1">Item {index + 1}</div>
            <StructuredValue field={`${field}_${index}`} value={item} depth={depth + 1} />
          </div>
        ))}
      </div>
    );
  }

  if (typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length === 0) return <span className="text-muted-foreground">—</span>;
    return (
      <div className="rounded-sm border bg-background/60 divide-y min-w-0">
        {entries.map(([nestedField, nestedValue]) => (
          <div
            key={nestedField}
            className="grid grid-cols-[minmax(100px,150px)_minmax(0,1fr)] gap-3 px-2.5 py-2 text-xs min-w-0 max-sm:grid-cols-1 max-sm:gap-1"
          >
            <span className="text-muted-foreground wrap-break-word">
              {BUSINESS_FIELD_LABELS[nestedField] || fieldLabel(nestedField)}
            </span>
            <div className="min-w-0 wrap-break-word whitespace-pre-wrap">
              <StructuredValue field={nestedField} value={nestedValue} depth={depth + 1} />
            </div>
          </div>
        ))}
      </div>
    );
  }

  return <span className="wrap-break-word whitespace-pre-wrap">{fmtBusinessValue(field, value)}</span>;
}

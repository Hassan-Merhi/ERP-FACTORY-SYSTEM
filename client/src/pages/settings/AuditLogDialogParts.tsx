// Extracted from ./AuditLogDialog.tsx
import { type AuditEntry, type AuditItem, type AuditJson } from "./AuditLogDialogRevisionItemsTable";

export function fmtEntryAmount(v: unknown): string {
  const n = parseFloat(String(v ?? 0));
  return isNaN(n) ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function asAuditItems(value: unknown): AuditItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AuditItem => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

export function isChangePair(value: AuditJson): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.prototype.hasOwnProperty.call(value, "old") || Object.prototype.hasOwnProperty.call(value, "new"))
  );
}

export function EntryTable({ entries, label }: { entries: AuditEntry[]; label?: string }) {
  if (entries.length === 0) return null;
  return (
    <div className="space-y-1.5">
      {label && <p className="text-xs font-medium text-muted-foreground">{label}</p>}
      <div className="rounded-md border overflow-hidden">
        <div className="grid grid-cols-[minmax(130px,1fr)_90px_90px_minmax(120px,1fr)] gap-2 px-3 py-2 bg-muted/40 text-[11px] font-medium text-muted-foreground max-sm:hidden">
          <span>Account</span>
          <span className="text-right">Debit</span>
          <span className="text-right">Credit</span>
          <span>Narration</span>
        </div>
        {entries.map((entry, index) => (
          <div
            key={`${entry.account || "account"}-${index}`}
            // Phones stack each entry: account, then Debit/Credit side by side, then narration.
            className="grid grid-cols-[minmax(130px,1fr)_90px_90px_minmax(120px,1fr)] gap-2 px-3 py-2 border-t text-xs items-start max-sm:grid-cols-2 max-sm:gap-1"
          >
            <span className="font-medium wrap-break-word max-sm:col-span-2">
              {String(entry.account ?? "Unknown account")}
            </span>
            <span className="text-right tabular-nums max-sm:text-start">
              <span className="text-muted-foreground sm:hidden">Debit </span>
              {fmtEntryAmount(entry.debit)}
            </span>
            <span className="text-right tabular-nums max-sm:text-start">
              <span className="text-muted-foreground sm:hidden">Credit </span>
              {fmtEntryAmount(entry.credit)}
            </span>
            <span className="text-muted-foreground wrap-break-word whitespace-pre-wrap max-sm:col-span-2">
              {String(entry.narration ?? "—")}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

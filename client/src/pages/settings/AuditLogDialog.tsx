import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import {
  actionBadgeVariant,
  actionLabel,
  BUSINESS_FIELD_LABELS,
  fieldLabel,
  fmtBusinessValue,
  fmtDate,
  getRecordLabel,
  isItemDiffKey,
  normalizeAuditChanges,
  tableShortName,
} from "./AuditLogUtils";
import {
  RevisionItemsTable,
  StructuredValue,
  compareEntries,
  getHeaderSentence,
  type AuditEntry,
  type AuditItem,
  type AuditJson,
} from "./AuditLogDialogRevisionItemsTable";

function fmtEntryAmount(v: unknown): string {
  const n = parseFloat(String(v ?? 0));
  return isNaN(n) ? "—" : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function asAuditItems(value: unknown): AuditItem[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is AuditItem => Boolean(item) && typeof item === "object" && !Array.isArray(item));
}

function isChangePair(value: AuditJson): boolean {
  return Boolean(
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (Object.prototype.hasOwnProperty.call(value, "old") || Object.prototype.hasOwnProperty.call(value, "new"))
  );
}

function valuesEqual(a: AuditJson, b: AuditJson): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function EntryTable({ entries, label }: { entries: AuditEntry[]; label?: string }) {
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

export function AuditLogDialog({ log, onClose }: { log: Record<string, unknown>; onClose: () => void }) {
  const changes = normalizeAuditChanges(log);
  const actionKey = String(log.action ?? "").toLowerCase();
  const isDelete = actionKey === "delete";
  const isCreate = actionKey === "create";
  const isSecurity = log.tableName === "security_events" || actionKey.startsWith("security:");

  const entriesChange = changes.entries;
  const structuredItemKey = ["items", "lines", "lineItems", "affectedItems"].find((key) => changes[key]);
  const itemsChange = structuredItemKey ? changes[structuredItemKey] : undefined;
  const scalarChanges = Object.fromEntries(
    Object.entries(changes).filter(
      ([key]) => key !== "entries" && !["items", "lines", "lineItems", "affectedItems"].includes(key)
    )
  );
  const oldEntries: AuditEntry[] = Array.isArray(entriesChange?.old) ? (entriesChange.old as AuditEntry[]) : [];
  const newEntries: AuditEntry[] = Array.isArray(entriesChange?.new) ? (entriesChange.new as AuditEntry[]) : [];
  const oldItems = asAuditItems(itemsChange?.old);
  const newItems = asAuditItems(itemsChange?.new);
  const hasItems = oldItems.length > 0 || newItems.length > 0;
  const itemSnapshotsChanged = oldItems.length > 0 && newItems.length > 0 && !valuesEqual(oldItems, newItems);
  const hasEntries = oldEntries.length > 0 || newEntries.length > 0;
  const entryDiff = compareEntries(oldEntries, newEntries);

  const voucherTypeRaw =
    changes.voucherType?.new ?? changes.voucherType?.old ?? changes.type?.new ?? changes.type?.old ?? "";
  const voucherType = typeof voucherTypeRaw === "string" ? voucherTypeRaw : String(voucherTypeRaw ?? "");

  const fieldPriority = [
    "status",
    "date",
    "amount",
    "totalAmount",
    "customer",
    "supplier",
    "location",
    "kind",
    "action",
    "outcome",
    "severity",
    "reason",
    "reasonCode",
    "targetType",
    "targetId",
    "metadata",
    "eventKey",
  ];

  const readableFields = Object.entries(scalarChanges).sort(([a], [b]) => {
    const ai = fieldPriority.indexOf(a);
    const bi = fieldPriority.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });

  type ChangePairLike = { old?: unknown; new?: unknown };
  const renderRow = (field: string, rawPair: AuditJson) => {
    if (isItemDiffKey(field)) {
      const isAdded = field.startsWith("item_added_");
      const isRemoved = field.startsWith("item_removed_");
      const pair: ChangePairLike = isChangePair(rawPair) ? (rawPair as ChangePairLike) : { new: rawPair };
      const text = pair.new ?? pair.old ?? "";
      if (!text) return null;
      return (
        <div key={field} className="flex gap-2 text-sm py-2 items-start min-w-0">
          <span
            className={`font-bold shrink-0 select-none ${
              isAdded ? "text-green-600 dark:text-green-400" : isRemoved ? "text-destructive" : "text-muted-foreground"
            }`}
          >
            {isAdded ? "+" : isRemoved ? "−" : "~"}
          </span>
          <span
            className={`wrap-break-word whitespace-pre-wrap min-w-0 ${
              isAdded ? "text-green-700 dark:text-green-300" : isRemoved ? "text-destructive/90" : ""
            }`}
          >
            {String(text)}
          </span>
        </div>
      );
    }

    const pair: ChangePairLike = isChangePair(rawPair) ? (rawPair as ChangePairLike) : { new: rawPair };
    const hasOld = pair.old !== undefined;
    const hasNew = pair.new !== undefined;
    const hasActualChange = hasOld && hasNew && !valuesEqual(pair.old, pair.new);
    const label = BUSINESS_FIELD_LABELS[field] || fieldLabel(field);

    return (
      <div
        key={field}
        className="grid grid-cols-[minmax(120px,180px)_minmax(0,1fr)] gap-3 text-sm py-2.5 items-start min-w-0 max-sm:grid-cols-1 max-sm:gap-1"
      >
        <span className="text-muted-foreground wrap-break-word">{label}</span>
        <div className="min-w-0">
          {hasActualChange ? (
            <div className="space-y-2 min-w-0">
              <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-2 min-w-0">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground pt-0.5">Before</span>
                <div className="text-destructive min-w-0">
                  <StructuredValue field={field} value={pair.old} />
                </div>
              </div>
              <div className="grid grid-cols-[52px_minmax(0,1fr)] gap-2 min-w-0">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground pt-0.5">After</span>
                <div className="font-medium text-green-600 dark:text-green-400 min-w-0">
                  <StructuredValue field={field} value={pair.new} />
                </div>
              </div>
            </div>
          ) : (
            <div className="font-medium min-w-0">
              <StructuredValue field={field} value={hasNew ? pair.new : pair.old} />
            </div>
          )}
        </div>
      </div>
    );
  };

  const renderedRows = readableFields.map(([field, vals]) => renderRow(field, vals)).filter(Boolean);
  const hasBeforeAfter =
    itemSnapshotsChanged ||
    readableFields.some(([, pair]) => {
      const normalized = isChangePair(pair) ? pair : { new: pair };
      return (
        normalized.old !== undefined && normalized.new !== undefined && !valuesEqual(normalized.old, normalized.new)
      );
    });

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-3xl max-h-[88vh] overflow-y-auto overflow-x-hidden">
        <DialogHeader>
          <DialogTitle className="text-base font-medium leading-snug pr-6 wrap-break-word">
            {getHeaderSentence(log)}
          </DialogTitle>
        </DialogHeader>

        <div className="grid grid-cols-[minmax(110px,160px)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm rounded-md border p-3 bg-muted/30 min-w-0 max-sm:grid-cols-[minmax(0,6.5rem)_minmax(0,1fr)] max-sm:gap-x-3">
          <span className="text-muted-foreground">User</span>
          <span className="font-medium wrap-break-word">{String(log.username ?? "Unknown")}</span>
          <span className="text-muted-foreground">Date & Time</span>
          <span>{fmtDate(String(log.createdAt ?? ""))}</span>
          <span className="text-muted-foreground">Company</span>
          <span className="font-medium wrap-break-word">
            {String(log.companyName ?? "") || (log.companyId ? `Company #${String(log.companyId)}` : "Unknown company")}
            {log.companyCode ? ` (${String(log.companyCode)})` : ""}
          </span>
          <span className="text-muted-foreground">Action</span>
          <div className="min-w-0">
            <Badge
              variant={actionBadgeVariant(String(log.action ?? ""))}
              className="text-xs max-w-full whitespace-normal wrap-break-word leading-snug"
            >
              {actionLabel(String(log.action ?? ""))}
            </Badge>
          </div>
          <span className="text-muted-foreground">Module</span>
          <span className="wrap-break-word">{tableShortName(String(log.tableName ?? ""))}</span>
          <span className="text-muted-foreground">Record</span>
          <span className="wrap-break-word whitespace-pre-wrap">{getRecordLabel(log)}</span>
          {voucherType && (
            <>
              <span className="text-muted-foreground">Type</span>
              <span>{fmtBusinessValue("voucherType", voucherType)}</span>
            </>
          )}
        </div>

        <div className="space-y-1.5 min-w-0">
          <p className="text-sm font-semibold">
            {isSecurity
              ? "Security event details"
              : isDelete
                ? "Deleted record details"
                : isCreate
                  ? "Created record details"
                  : hasBeforeAfter
                    ? "What changed"
                    : "Activity details"}
          </p>
          {renderedRows.length > 0 && <div className="rounded-md border px-3 divide-y min-w-0">{renderedRows}</div>}
          {hasItems && (
            <div className="space-y-2 pt-1">
              {itemSnapshotsChanged ? (
                <>
                  <RevisionItemsTable items={oldItems} label="Before items" />
                  <RevisionItemsTable items={newItems} label="After items" />
                </>
              ) : (
                <RevisionItemsTable items={newItems.length > 0 ? newItems : oldItems} label="Items" />
              )}
            </div>
          )}
          {renderedRows.length === 0 && !hasItems && (
            <p className="text-sm text-muted-foreground">No additional details were captured for this activity.</p>
          )}
        </div>

        {hasEntries && (
          <div className="space-y-3 min-w-0">
            <p className="text-sm font-semibold">Accounting Details</p>
            {hasBeforeAfter ? (
              <>
                <EntryTable entries={entryDiff.added} label="Accounts added" />
                <EntryTable entries={entryDiff.removed} label="Accounts removed" />
                {entryDiff.changed.length > 0 && (
                  <div className="space-y-2">
                    <p className="text-xs font-medium text-muted-foreground">Accounts changed</p>
                    {entryDiff.changed.map(({ account, old, new: next }) => (
                      <div key={account} className="rounded-md border p-3 space-y-2 text-xs min-w-0">
                        <p className="font-semibold wrap-break-word">{account}</p>
                        <div className="grid grid-cols-[60px_1fr] gap-2 min-w-0">
                          <span className="text-muted-foreground">Before</span>
                          <span className="wrap-break-word">
                            Debit {fmtEntryAmount(old.debit)}, Credit {fmtEntryAmount(old.credit)}
                            {old.narration ? ` — ${old.narration}` : ""}
                          </span>
                          <span className="text-muted-foreground">After</span>
                          <span className="font-medium wrap-break-word">
                            Debit {fmtEntryAmount(next.debit)}, Credit {fmtEntryAmount(next.credit)}
                            {next.narration ? ` — ${next.narration}` : ""}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {entryDiff.added.length === 0 && entryDiff.removed.length === 0 && entryDiff.changed.length === 0 && (
                  <EntryTable entries={newEntries} label="Current accounting entries" />
                )}
              </>
            ) : (
              <EntryTable entries={isDelete ? oldEntries : newEntries} />
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

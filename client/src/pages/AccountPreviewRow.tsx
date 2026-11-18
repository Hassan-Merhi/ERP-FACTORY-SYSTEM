// Extracted from ./AccountMigration.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { BookOpen, ChevronDown, ChevronUp } from "lucide-react";
import { fmt, fmtSigned, type AccountPreviewItem } from "./AccountMultiSelect";

export function AccountPreviewRow({ item }: { item: AccountPreviewItem }) {
  const [expanded, setExpanded] = useState(false);
  const ob = parseFloat(item.account.openingBalance || "0");
  return (
    <div className="rounded-md border">
      <button
        className="w-full flex items-center justify-between gap-2 p-3 text-left hover-elevate"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="font-medium truncate">{item.account.name}</span>
          <span className="font-mono text-xs text-muted-foreground shrink-0">{item.account.code}</span>
          {item.codeConflict && (
            <Badge
              variant="outline"
              className="text-xs text-amber-700 border-amber-300 dark:text-amber-300 dark:border-amber-700 shrink-0"
            >
              Renamed
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">
            {item.postedEntryCount} posted / {item.entryCount} historical
          </span>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t pt-3">
          <div className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-4">
            <div>
              <p className="text-xs text-muted-foreground">Debits</p>
              <p className="font-mono font-medium">{fmt(item.totalDebit)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Credits</p>
              <p className="font-mono font-medium">{fmt(item.totalCredit)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Opening balance</p>
              <p className="font-mono font-medium">
                {ob !== 0 ? `${fmt(ob)} ${item.account.openingBalanceSide}` : "—"}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Closing balance to transfer</p>
              <p className="font-mono font-semibold">{fmtSigned(item.closingBalance)}</p>
            </div>
          </div>
          {item.postedEntryCount !== item.entryCount && (
            <p className="text-xs text-muted-foreground">
              {item.entryCount - item.postedEntryCount} excluded/non-posted historical entries are not included in the
              closing balance.
            </p>
          )}
          {item.touchedVoucherCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {item.exclusiveVoucherCount} voucher{item.exclusiveVoucherCount !== 1 ? "s" : ""} will move
              {item.sharedVoucherCount > 0 && `, ${item.sharedVoucherCount} shared (stay in source)`}
            </p>
          )}
          {item.codeConflict && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Code <span className="font-mono">{item.account.code}</span> conflicts with existing account "
              {item.codeConflict.name}" — will be renamed to{" "}
              <span className="font-mono">{item.account.code}-MIGRATED</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

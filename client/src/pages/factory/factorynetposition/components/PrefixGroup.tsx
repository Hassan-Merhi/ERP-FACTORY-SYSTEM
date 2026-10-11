/**
 * PrefixGroup — extracted sub-component.
 *
 * Extracted from FactoryNetPosition.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { AccountItem } from "../types";
import { fmt } from "../utils";
import { SupplierRow } from "./SupplierRow";

export /** A collapsible sub-group for accounts that share the same name prefix. */
function PrefixGroup({
  prefix,
  accounts,
  accentClass,
  startIndex,
}: {
  prefix: string;
  accounts: AccountItem[];
  accentClass: string;
  startIndex: number;
}) {
  const [open, setOpen] = useState(false);
  const total = accounts.reduce((s, a) => s + a.value, 0);

  return (
    <div className="divide-y divide-border">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-2 hover-elevate text-sm"
        onClick={() => setOpen((o) => !o)}
        data-testid={`toggle-prefix-${prefix.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          <span className="font-medium truncate">{prefix}</span>
          <Badge variant="outline" className="text-[11px] shrink-0">
            {accounts.length}
          </Badge>
        </div>
        <span className={`font-mono text-sm font-semibold ml-4 shrink-0 ${accentClass}`}>{fmt(total)}</span>
      </button>
      {open && (
        <div className="divide-y divide-border bg-muted/10">
          {accounts.map((acc, i) => (
            <SupplierRow key={i} acc={acc} accentClass={accentClass} index={startIndex + i} />
          ))}
        </div>
      )}
    </div>
  );
}

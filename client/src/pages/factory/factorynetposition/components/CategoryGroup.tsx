/**
 * CategoryGroup — extracted sub-component.
 *
 * Extracted from FactoryNetPosition.tsx during the Phase 4 god-file split.
 */
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight } from "lucide-react";

import type { AccountItem } from "../types";
import { fmt, getNamePrefix } from "../utils";
import { SupplierRow } from "./SupplierRow";
import { PrefixGroup } from "./PrefixGroup";

export function CategoryGroup({
  title,
  accounts,
  accentClass,
}: {
  title: string;
  accounts: AccountItem[];
  accentClass: string;
}) {
  const [open, setOpen] = useState(false);
  const total = accounts.reduce((s, a) => s + a.value, 0);
  if (accounts.length === 0) return null;

  // Group accounts by name prefix (part before " - ").
  // Prefixes shared by ≥2 accounts get a collapsible sub-group row;
  // single accounts (or those with no prefix) render directly.
  const prefixMap = new Map<string, AccountItem[]>();
  const noPrefixAccounts: AccountItem[] = [];
  for (const acc of accounts) {
    const prefix = getNamePrefix(acc.name);
    if (prefix) {
      if (!prefixMap.has(prefix)) prefixMap.set(prefix, []);
      prefixMap.get(prefix)!.push(acc);
    } else {
      noPrefixAccounts.push(acc);
    }
  }
  // Prefixes with only 1 account fall back to a plain row.
  const singleFromPrefix: AccountItem[] = [];
  const multiPrefixes: [string, AccountItem[]][] = [];
  for (const [prefix, accs] of prefixMap) {
    if (accs.length === 1) singleFromPrefix.push(accs[0]);
    else multiPrefixes.push([prefix, accs]);
  }
  const plainAccounts = [...noPrefixAccounts, ...singleFromPrefix];

  return (
    <div className="border border-border rounded-md overflow-hidden">
      <button
        type="button"
        className="w-full flex items-center justify-between px-4 py-2.5 hover-elevate bg-muted/30"
        onClick={() => setOpen((o) => !o)}
        data-testid={`toggle-${title.toLowerCase().replace(/\s+/g, "-")}`}
      >
        <div className="flex items-center gap-2">
          {open ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-sm font-medium">{title}</span>
          <Badge variant="outline" className="text-xs">
            {accounts.length}
          </Badge>
        </div>
        <span className={`font-mono text-sm font-semibold ${accentClass}`}>{fmt(total)}</span>
      </button>
      {open && (
        <div className="divide-y divide-border">
          {multiPrefixes.map(([prefix, accs], gi) => (
            <PrefixGroup key={prefix} prefix={prefix} accounts={accs} accentClass={accentClass} startIndex={gi * 100} />
          ))}
          {plainAccounts.map((acc, i) => (
            <SupplierRow
              key={acc.id != null ? `ledger:${acc.id}` : `${acc.code}:${acc.name}:${i}`}
              acc={acc}
              accentClass={accentClass}
              index={i}
            />
          ))}
        </div>
      )}
    </div>
  );
}

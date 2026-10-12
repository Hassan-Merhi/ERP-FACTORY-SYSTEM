/**
 * SupplierRow — extracted sub-component.
 *
 * Extracted from FactoryNetPosition.tsx during the Phase 4 god-file split.
 */
import {useState} from "react";
import {ChevronDown, ChevronRight, ExternalLink} from "lucide-react";

import type {AccountItem} from "../types";
import {fmt} from "../utils";

export function SupplierRow({ acc, accentClass, index }: { acc: AccountItem; accentClass: string; index: number }) {
  const [open, setOpen] = useState(false);
  const hasBreakdown = acc.breakdown && acc.breakdown.length > 0;
  const name = acc.name.toLowerCase();
  const code = acc.code?.toUpperCase() ?? "";
  const href =
    code === "STOCK_OTW" || name.includes("stock otw") ? "/factory/stock-otw" :
    code === "INVENTORY" || name.includes("stock in hand") ? "/factory/location-inventory" :
    code === "PREPAID_RENT" || name.includes("prepaid rent") ? "/factory/rental/payments" :
    name.includes("worker advance") ? "/factory/payroll-hub?section=workers&tab=advances" :
    code === "SUPPLIER" || acc.category?.toLowerCase().includes("supplier") ? `/factory/parties?section=suppliers${acc.supplierId ? `&supplierId=${acc.supplierId}` : ""}` :
    acc.id ? `/factory/ledger-monthly/${acc.id}` : undefined;

  return (
    <div className="divide-y divide-border" data-testid={`row-account-${index}`}>
      <div className="flex items-center justify-between px-4 py-2 text-sm">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1">
            {hasBreakdown && (
              <button
                type="button"
                onClick={() => setOpen((o) => !o)}
                className="shrink-0 text-muted-foreground hover:text-foreground"
                data-testid={`button-breakdown-${index}`}
              >
                {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
              </button>
            )}
            {href ? (
              <a
                href={href}
                className="font-medium text-foreground hover:underline text-left flex items-center gap-1 min-w-0"
                data-testid={`link-net-position-${acc.code || acc.id || index}`}
              >
                <span className="truncate">{acc.name}</span>
                <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
              </a>
            ) : (
              <p className="font-medium truncate">{acc.name}</p>
            )}
          </div>
          {acc.code && acc.code !== "SUPPLIER" && acc.code !== "CUSTOMER_DR" && acc.code !== "CUSTOMER_CR" && (
            <p className="text-xs text-muted-foreground font-mono">{acc.code}</p>
          )}
        </div>
        <span className={`font-mono text-sm ml-4 shrink-0 ${accentClass}`}>{fmt(acc.value)}</span>
      </div>
      {hasBreakdown && open && (
        <div className="bg-muted/20 px-4 py-2 space-y-1">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
            Calculation Breakdown
          </p>
          {acc.breakdown!.map((line, j) => {
            const isNegative = line.usd < 0;
            const isFx = line.label.includes("FX") || line.label.includes("Net Balance");
            return (
              <div key={j} className="flex items-center justify-between text-xs gap-4">
                <div className="min-w-0">
                  <span className="text-foreground/80">{line.label}</span>
                  {line.native && <span className="ml-2 font-mono text-muted-foreground">({line.native})</span>}
                </div>
                <span
                  className={`font-mono shrink-0 ${isNegative ? "text-destructive" : isFx ? "text-muted-foreground" : accentClass}`}
                >
                  {line.usd !== 0 ? fmt(line.usd) : "—"}
                </span>
              </div>
            );
          })}
          <div className="border-t border-border mt-1 pt-1 flex justify-between text-xs font-semibold">
            <span>Total</span>
            <span className={`font-mono ${accentClass}`}>{fmt(acc.value)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

/** Extract the prefix before " - " in an account name, or return null if none. */

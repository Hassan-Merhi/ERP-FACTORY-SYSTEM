// Extracted from ./NetPositionSidePanel.tsx
import { useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import { InlineOrderButtons, inlineDrag, type InlineOrderActions } from "@/components/accounts/InlineOrderButtons";

export interface AccountItem {
  id?: number;
  name: string;
  code: string;
  value: number;
  category: string;
  balanceSide?: "Dr" | "Cr";
  breakdown?: Array<{ label: string; native?: string; usd: number; sourceKey?: string }>;
}

export interface BreakdownItem {
  name: string;
  value: number;
}

export function CategoryGroup({
  category,
  accounts,
  side,
  formatAmount,
  groupKey,
  groupSiblings = [],
  actions,
  onFxClick,
}: {
  category: string;
  accounts: AccountItem[];
  side: "asset" | "liability" | "equity";
  formatAmount: (n: number) => string;
  groupKey?: string | null;
  groupSiblings?: string[];
  actions?: InlineOrderActions;
  onFxClick?: (side: "gain" | "loss") => void;
}) {
  const [open, setOpen] = useState(true);
  const accountKeys = accounts.filter((a) => a.id != null).map((a) => `ledger:${a.id}`);
  // Use signed sum so credit-balance prepaid entries (negative) reduce the total
  const total = accounts.reduce((s, a) => s + a.value, 0);
  const color =
    side === "asset"
      ? "text-emerald-600 dark:text-emerald-400"
      : side === "equity"
        ? "text-violet-600 dark:text-violet-400"
        : "text-rose-600 dark:text-rose-400";
  const headerBg =
    side === "asset"
      ? "bg-emerald-50/60 dark:bg-emerald-950/30"
      : side === "equity"
        ? "bg-violet-50/60 dark:bg-violet-950/30"
        : "bg-rose-50/60 dark:bg-rose-950/30";

  return (
    <div className="rounded-md overflow-hidden border border-border/60" {...inlineDrag(groupKey || null, actions)}>
      <div className={`flex items-stretch ${headerBg}`}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center justify-between px-3 py-2 text-sm font-semibold hover-elevate"
          data-testid={`button-category-${category.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <div className="flex items-center gap-2">
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span className="text-foreground">{category}</span>
            <span className="text-xs font-normal text-muted-foreground bg-background/60 rounded-sm px-1.5 py-0.5">
              {accounts.length}
            </span>
          </div>
          <span className={`font-mono font-bold tabular-nums ${color}`}>{formatAmount(Math.abs(total))}</span>
        </button>
        <InlineOrderButtons label={category} nodeKey={groupKey || null} siblingKeys={groupSiblings} actions={actions} />
      </div>
      {open && (
        <div className="divide-y divide-border/50">
          {accounts.map((acc, i) => {
            const ledgerBase = window.location.pathname.startsWith("/properties")
              ? "/properties/ledger-monthly"
              : "/ledger-monthly";
            const isCreditOnAsset = side === "asset" && acc.value < 0;
            const rowColor = isCreditOnAsset ? "text-rose-600 dark:text-rose-400" : color;
            return (
              <div
                key={i}
                className="flex items-center justify-between gap-2 px-3 py-2 text-sm hover:bg-muted/30 transition-colors"
                data-testid={`row-account-${i}`}
                {...inlineDrag(acc.id != null ? `ledger:${acc.id}` : null, actions)}
              >
                {(acc.code === "FX_UNREALIZED_GAIN" || acc.code === "FX_UNREALIZED_LOSS") && onFxClick ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1 text-primary font-medium hover:underline"
                    onClick={() => onFxClick(acc.code === "FX_UNREALIZED_GAIN" ? "gain" : "loss")}
                    data-testid={`button-erp-fx-history-${acc.code}`}
                  >
                    {acc.name} <ExternalLink className="h-3 w-3" />
                  </button>
                ) : acc.id ? (
                  <button
                    type="button"
                    onClick={() => window.open(`${ledgerBase}/${acc.id}`, "_blank")}
                    className="text-foreground hover:text-foreground/80 text-left flex items-center gap-1 group"
                  >
                    <span>{acc.name}</span>
                    {isCreditOnAsset && (
                      <span className="text-xs text-rose-500 dark:text-rose-400 font-normal ml-1">(Cr)</span>
                    )}
                    {side === "equity" && acc.balanceSide && (
                      <span className="text-xs text-muted-foreground font-normal ml-1">({acc.balanceSide})</span>
                    )}
                    <ExternalLink className="h-3 w-3 text-muted-foreground opacity-0 group-hover:opacity-100 touch:opacity-100 shrink-0 transition-opacity" />
                  </button>
                ) : (
                  <span className="text-foreground flex items-center gap-1">
                    {acc.name}
                    {isCreditOnAsset && (
                      <span className="text-xs text-rose-500 dark:text-rose-400 font-normal">(Cr)</span>
                    )}
                    {side === "equity" && acc.balanceSide && (
                      <span className="text-xs text-muted-foreground font-normal ml-1">({acc.balanceSide})</span>
                    )}
                  </span>
                )}
                <div className="flex items-center gap-1">
                  <InlineOrderButtons
                    label={acc.name}
                    nodeKey={acc.id != null ? `ledger:${acc.id}` : null}
                    siblingKeys={accountKeys}
                    actions={actions}
                  />
                  <span className={`font-mono tabular-nums font-medium ${rowColor}`}>
                    {formatAmount(Math.abs(acc.value))}
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Assets / liabilities / equity side panels for the Net Position Details page,
 * extracted from NetProfitDetails.tsx.
 */
import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronDown, ChevronRight, ArrowUpRight, ArrowDownRight, Scale } from "lucide-react";
import type { AccountDisplayLayout } from "../accounts/DisplayAccountGroups";
import { type InlineOrderActions } from "@/components/accounts/InlineOrderButtons";
import { CategoryGroup, type AccountItem } from "./CategoryGroup";
export type { AccountItem, BreakdownItem } from "./CategoryGroup";

export function SidePanel({
  id,
  title,
  subtitle,
  side,
  total,
  accounts,
  formatAmount,
  displayLayout,
  orderActions,
  onFxClick,
}: {
  id: string;
  title: string;
  subtitle?: string;
  side: "asset" | "liability" | "equity";
  total: number;
  accounts: AccountItem[];
  formatAmount: (n: number) => string;
  displayLayout?: AccountDisplayLayout;
  orderActions?: InlineOrderActions;
  onFxClick?: (side: "gain" | "loss") => void;
}) {
  const [open, setOpen] = useState(true);

  const layoutGroups = (displayLayout?.nodes || []).filter((n) => n.type === "group");
  const layoutMembership = new Map(
    (displayLayout?.nodes || [])
      .filter((n) => n.type === "ledger" && n.parentKey)
      .map((n) => [Number(n.key.slice(7)), n])
  );
  const layoutGroupNames = new Map(layoutGroups.map((n) => [`display:${n.key}`, n.name || "Group"]));
  const layoutOrder = new Map(layoutGroups.map((n) => [`display:${n.key}`, n.order]));
  // A group can have accounts on both sides. Partition each side separately,
  // so liabilities never cancel assets and dashboard totals never change.
  const grouped = accounts.reduce<Record<string, AccountItem[]>>((acc, item) => {
    const membership = item.id ? layoutMembership.get(item.id) : undefined;
    const category = membership?.parentKey ? `display:${membership.parentKey}` : item.category || "Other";
    if (!acc[category]) acc[category] = [];
    acc[category].push(item);
    return acc;
  }, {});
  const sortedCategories = Object.entries(grouped)
    .map(([key, items]) => {
      if (layoutGroupNames.has(key)) {
        items.sort(
          (a, b) =>
            (layoutMembership.get(a.id || -1)?.order ?? 10000) - (layoutMembership.get(b.id || -1)?.order ?? 10000)
        );
      }
      return [key, items] as const;
    })
    .sort(([keyA, a], [keyB, b]) => {
      const aRank = layoutOrder.get(keyA),
        bRank = layoutOrder.get(keyB);
      if (aRank != null && bRank != null) return aRank - bRank;
      if (aRank != null) return -1;
      if (bRank != null) return 1;
      return b.reduce((s, x) => s + Math.abs(x.value), 0) - a.reduce((s, x) => s + Math.abs(x.value), 0);
    });

  const groupKeys = sortedCategories
    .filter(([key]) => layoutGroupNames.has(key))
    .map(([key]) => key.slice("display:".length));
  const isAsset = side === "asset";
  const isEquity = side === "equity";
  const headerGradient = isAsset
    ? "from-emerald-500/10 to-transparent dark:from-emerald-500/15"
    : isEquity
      ? "from-violet-500/10 to-transparent dark:from-violet-500/15"
      : "from-rose-500/10 to-transparent dark:from-rose-500/15";
  const totalColor = isAsset
    ? "text-emerald-600 dark:text-emerald-400"
    : isEquity
      ? "text-violet-600 dark:text-violet-400"
      : "text-rose-600 dark:text-rose-400";
  const iconBg = isAsset
    ? "bg-emerald-100 dark:bg-emerald-900/50 text-emerald-600 dark:text-emerald-400"
    : isEquity
      ? "bg-violet-100 dark:bg-violet-900/50 text-violet-600 dark:text-violet-400"
      : "bg-rose-100 dark:bg-rose-900/50 text-rose-600 dark:text-rose-400";
  const footerBg = isAsset
    ? "bg-emerald-50/50 dark:bg-emerald-950/30 border-emerald-200/60 dark:border-emerald-800/40"
    : isEquity
      ? "bg-violet-50/50 dark:bg-violet-950/30 border-violet-200/60 dark:border-violet-800/40"
      : "bg-rose-50/50 dark:bg-rose-950/30 border-rose-200/60 dark:border-rose-800/40";
  const displayTotal = isEquity ? Math.abs(total) : total;
  const totalSide = isEquity && total !== 0 ? (total > 0 ? "Dr" : "Cr") : null;

  return (
    <Card data-testid={`card-${id}`} className="flex flex-col overflow-hidden">
      <div
        className={`bg-linear-to-r ${headerGradient} px-5 py-4 cursor-pointer select-none`}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <div className={`p-2 rounded-lg ${iconBg}`}>
              {isAsset ? (
                <ArrowUpRight className="h-4 w-4" />
              ) : isEquity ? (
                <Scale className="h-4 w-4" />
              ) : (
                <ArrowDownRight className="h-4 w-4" />
              )}
            </div>
            <div>
              <div className={`font-semibold text-base ${totalColor}`}>{title}</div>
              {subtitle && <div className="text-xs text-muted-foreground mt-0.5">{subtitle}</div>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`text-2xl font-bold font-mono tabular-nums ${totalColor}`}>
              {formatAmount(displayTotal)}
              {totalSide && <span className="text-xs font-normal ml-1">{totalSide}</span>}
            </span>
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
          </div>
        </div>
      </div>

      {open && (
        <CardContent className="pt-3 pb-4 flex-1 space-y-2">
          {sortedCategories.length > 0 ? (
            <>
              {sortedCategories.map(([cat, catAccounts]) => (
                <CategoryGroup
                  key={cat}
                  category={layoutGroupNames.get(cat) || cat}
                  accounts={catAccounts}
                  side={side}
                  formatAmount={formatAmount}
                  groupKey={layoutGroupNames.has(cat) ? cat.slice("display:".length) : null}
                  groupSiblings={groupKeys}
                  actions={orderActions}
                  onFxClick={onFxClick}
                />
              ))}
              <div
                className={`flex justify-between items-center px-3 py-2.5 rounded-md border font-semibold text-sm mt-2 ${footerBg}`}
              >
                <span className="text-muted-foreground">
                  {isAsset ? "Total Assets" : isEquity ? "Net Equity Balance" : "Total Liabilities"}
                </span>
                <span className={`font-mono tabular-nums ${totalColor}`}>
                  {formatAmount(displayTotal)}
                  {totalSide && <span className="text-xs font-normal ml-1">{totalSide}</span>}
                </span>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-center py-6 text-sm">No data recorded</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

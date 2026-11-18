// Extracted from ./FactoryNetPositionDetails.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import type { AccountDisplayLayout } from "../accounts/DisplayAccountGroups";
import { inlineDrag, type InlineOrderActions, InlineOrderButtons } from "@/components/accounts/InlineOrderButtons";
import type { AccountItem } from "./factorynetposition/detailsTypes";

function InsuranceSubGroup({
  accounts,
  amountColor,
  formatAmount,
}: {
  accounts: AccountItem[];
  amountColor: string;
  formatAmount: (n: number) => string;
}) {
  const [open, setOpen] = useState(false);
  const total = accounts.reduce((s, a) => s + a.value, 0);

  return (
    <>
      <div className="flex items-center justify-between px-4 py-2 text-sm border-t border-border">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-1.5 font-medium text-foreground hover-elevate rounded-sm px-1 -ml-1"
          data-testid="button-insurance-group-toggle"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          )}
          Insurance
          <Badge variant="outline" className="text-xs font-normal ml-0.5">
            {accounts.length}
          </Badge>
        </button>
        <span className={`shrink-0 whitespace-nowrap font-mono tabular-nums ${amountColor}`}>
          {formatAmount(total)}
        </span>
      </div>
      {open &&
        accounts.map((acc, i) => (
          <div
            key={i}
            className="flex items-center justify-between pl-10 pr-4 py-2 text-sm border-t border-border bg-muted/20"
            data-testid={`row-insurance-${i}`}
          >
            {acc.id ? (
              <button
                type="button"
                onClick={() => window.open(`/factory/ledger-monthly/${acc.id}`, "_blank")}
                className="font-medium text-foreground hover:underline text-left flex items-center gap-1"
              >
                {acc.name.replace(/^Insurance\s*[-–]\s*/i, "")}
                <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
              </button>
            ) : (
              <span className="font-medium text-foreground">{acc.name.replace(/^Insurance\s*[-–]\s*/i, "")}</span>
            )}
            <span className={`shrink-0 whitespace-nowrap font-mono tabular-nums ${amountColor}`}>
              {formatAmount(acc.value)}
            </span>
          </div>
        ))}
    </>
  );
}

function CategoryGroup({
  category,
  accounts,
  amountColor,
  formatAmount,
  accentColor,
  groupKey,
  groupSiblings = [],
  actions,
  onFxClick,
}: {
  category: string;
  accounts: AccountItem[];
  amountColor: string;
  formatAmount: (n: number) => string;
  accentColor: string;
  groupKey?: string | null;
  groupSiblings?: string[];
  actions?: InlineOrderActions;
  onFxClick?: (side: "gain" | "loss") => void;
}) {
  const [open, setOpen] = useState(true);
  const total = accounts.reduce((s, a) => s + a.value, 0);

  const insuranceAccounts = accounts.filter((a) => /^Insurance\s*[-–]/i.test(a.name));
  const otherAccounts = accounts.filter((a) => !/^Insurance\s*[-–]/i.test(a.name));
  const accountKeys = otherAccounts.filter((a) => a.id != null).map((a) => `ledger:${a.id}`);
  const displayCount = otherAccounts.length + (insuranceAccounts.length > 0 ? 1 : 0);

  return (
    <div className="border border-border rounded-md overflow-hidden" {...inlineDrag(groupKey || null, actions)}>
      <div className="flex items-stretch bg-muted/40">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex-1 flex items-center justify-between px-4 py-2.5 hover-elevate text-sm font-semibold"
          data-testid={`button-category-${category.toLowerCase().replace(/\s+/g, "-")}`}
        >
          <div className="flex items-center gap-2">
            {open ? (
              <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            )}
            <span>{category}</span>
            <Badge variant="outline" className="text-xs font-normal">
              {displayCount}
            </Badge>
          </div>
          <span className={`shrink-0 whitespace-nowrap font-mono font-bold ${accentColor}`}>{formatAmount(total)}</span>
        </button>
        <InlineOrderButtons label={category} nodeKey={groupKey || null} siblingKeys={groupSiblings} actions={actions} />
      </div>
      {open && (
        <div className="divide-y divide-border">
          {otherAccounts.map((acc, i) => (
            <div
              key={i}
              className="flex items-center justify-between px-4 py-2 text-sm"
              data-testid={`row-account-${i}`}
              {...inlineDrag(acc.id != null ? `ledger:${acc.id}` : null, actions)}
            >
              {(acc.code === "FX_UNREALIZED_GAIN" || acc.code === "FX_UNREALIZED_LOSS") && onFxClick ? (
                <button
                  type="button"
                  onClick={() => onFxClick(acc.code === "FX_UNREALIZED_GAIN" ? "gain" : "loss")}
                  className="font-medium text-primary hover:underline text-left flex items-center gap-1"
                  data-testid={`button-factory-details-fx-history-${acc.code}`}
                >
                  {acc.name} <ExternalLink className="h-3.5 w-3.5" />
                </button>
              ) : acc.id ? (
                <button
                  type="button"
                  onClick={() => window.open(`/factory/ledger-monthly/${acc.id}`, "_blank")}
                  className="font-medium text-foreground hover:underline text-left flex items-center gap-1"
                >
                  {acc.name}
                  <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                </button>
              ) : (
                <span className="font-medium text-foreground">{acc.name}</span>
              )}
              <div className="flex items-center gap-1">
                <InlineOrderButtons
                  label={acc.name}
                  nodeKey={acc.id != null ? `ledger:${acc.id}` : null}
                  siblingKeys={accountKeys}
                  actions={actions}
                />
                <span className={`shrink-0 whitespace-nowrap font-mono tabular-nums ${amountColor}`}>
                  {formatAmount(acc.value)}
                </span>
              </div>
            </div>
          ))}
          {insuranceAccounts.length > 0 && (
            <InsuranceSubGroup accounts={insuranceAccounts} amountColor={amountColor} formatAmount={formatAmount} />
          )}
        </div>
      )}
    </div>
  );
}

export function CollapsibleSection({
  id,
  title,
  subtitle,
  accentColor,
  icon,
  total,
  totalLabel,
  totalColor,
  accounts,
  amountColor,
  formatAmount,
  displayLayout,
  orderActions,
  onFxClick,
}: {
  id: string;
  title: string;
  subtitle?: string;
  accentColor: string;
  icon: React.ReactNode;
  total: number;
  totalLabel: string;
  totalColor: string;
  accounts: AccountItem[];
  amountColor: string;
  formatAmount: (n: number) => string;
  displayLayout?: AccountDisplayLayout;
  orderActions?: InlineOrderActions;
  onFxClick?: (side: "gain" | "loss") => void;
}) {
  const [open, setOpen] = useState(true);

  const layoutGroups = (displayLayout?.nodes || []).filter((n) => n.type === "group");
  const membership = new Map(
    (displayLayout?.nodes || [])
      .filter((n) => n.type === "ledger" && n.parentKey)
      .map((n) => [Number(n.key.slice(7)), n])
  );
  const labels = new Map(layoutGroups.map((n) => [`display:${n.key}`, n.name || "Group"]));
  const groupOrder = new Map(layoutGroups.map((n) => [`display:${n.key}`, n.order]));
  const grouped = accounts.reduce<Record<string, AccountItem[]>>((acc, item) => {
    const member = item.id ? membership.get(item.id) : undefined;
    const cat = member?.parentKey ? `display:${member.parentKey}` : item.category || "Other";
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(item);
    return acc;
  }, {});
  const sortedCategories = Object.entries(grouped)
    .map(([key, items]) => {
      if (labels.has(key))
        items.sort(
          (a, b) => (membership.get(a.id || -1)?.order ?? 10000) - (membership.get(b.id || -1)?.order ?? 10000)
        );
      return [key, items] as const;
    })
    .sort(([ak, a], [bk, b]) => {
      const ai = groupOrder.get(ak),
        bi = groupOrder.get(bk);
      if (ai != null && bi != null) return ai - bi;
      if (ai != null) return -1;
      if (bi != null) return 1;
      return b.reduce((s, x) => s + x.value, 0) - a.reduce((s, x) => s + x.value, 0);
    });

  const groupKeys = sortedCategories.filter(([key]) => labels.has(key)).map(([key]) => key.slice("display:".length));
  return (
    <Card data-testid={`card-${id}`} className="flex flex-col">
      <CardHeader className="cursor-pointer select-none pb-3" onClick={() => setOpen((v) => !v)}>
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span className={accentColor}>{icon}</span>
            <div>
              <CardTitle className={`flex items-center gap-2 text-lg ${accentColor}`}>{title}</CardTitle>
              {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className={`shrink-0 whitespace-nowrap text-2xl font-bold font-mono ${totalColor}`}>
              {formatAmount(total)}
            </span>
            {open ? (
              <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
            ) : (
              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
            )}
          </div>
        </div>
      </CardHeader>

      {open && (
        <CardContent className="pt-0 flex-1 space-y-2">
          {sortedCategories.length > 0 ? (
            <>
              {sortedCategories.map(([cat, catAccounts]) => (
                <CategoryGroup
                  key={cat}
                  category={labels.get(cat) || cat}
                  accounts={catAccounts}
                  groupKey={labels.has(cat) ? cat.slice("display:".length) : null}
                  groupSiblings={groupKeys}
                  actions={orderActions}
                  onFxClick={onFxClick}
                  amountColor={amountColor}
                  formatAmount={formatAmount}
                  accentColor={totalColor}
                />
              ))}
              <div className="flex justify-between items-center px-4 py-2.5 rounded-md bg-muted/60 font-bold text-sm mt-1">
                <span>{totalLabel}</span>
                <span className={`shrink-0 whitespace-nowrap font-mono ${totalColor}`}>{formatAmount(total)}</span>
              </div>
            </>
          ) : (
            <p className="text-muted-foreground text-center py-4">No data recorded</p>
          )}
        </CardContent>
      )}
    </Card>
  );
}

/**
 * CustomNetPositionView — extracted sub-component.
 *
 * Extracted from PropertiesDashboard.tsx during the Phase 4 god-file split.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { Eye, EyeOff, RotateCcw, Equal } from "lucide-react";
import { useState, useCallback, useMemo } from "react";
import type { ProfitData, PropsCustomAccount } from "../types";
import { loadPropsCustomViewHidden, savePropsCustomViewHidden } from "../utils";

export function CustomNetPositionView({ data }: { data: ProfitData }) {
  const { formatAmount } = useCurrencyContext();
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => loadPropsCustomViewHidden());

  const allAccounts = useMemo<PropsCustomAccount[]>(() => {
    const have = (data.forUsBreakdown ?? []).map((a) => ({
      key: `have:${a.name}`,
      name: a.name,
      value: a.value,
      side: "have" as const,
    }));
    const owe = (data.onUsBreakdown ?? []).map((a) => ({
      key: `owe:${a.name}`,
      name: a.name,
      value: a.value,
      side: "owe" as const,
    }));
    const spent = (data.expenses?.breakdown ?? []).map((a) => ({
      key: `spent:${a.name}`,
      name: a.name,
      value: a.value,
      side: "spent" as const,
    }));
    return [...have, ...owe, ...spent];
  }, [data.forUsBreakdown, data.onUsBreakdown, data.expenses]);

  const toggle = useCallback((key: string) => {
    setHiddenKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      savePropsCustomViewHidden(next);
      return next;
    });
  }, []);

  const resetAll = useCallback(() => {
    const empty = new Set<string>();
    setHiddenKeys(empty);
    savePropsCustomViewHidden(empty);
  }, []);

  const visibleHaveTotal = useMemo(
    () => allAccounts.filter((a) => a.side === "have" && !hiddenKeys.has(a.key)).reduce((s, a) => s + a.value, 0),
    [allAccounts, hiddenKeys]
  );
  const visibleOweTotal = useMemo(
    () => allAccounts.filter((a) => a.side === "owe" && !hiddenKeys.has(a.key)).reduce((s, a) => s + a.value, 0),
    [allAccounts, hiddenKeys]
  );
  const visibleSpentTotal = useMemo(
    () => allAccounts.filter((a) => a.side === "spent" && !hiddenKeys.has(a.key)).reduce((s, a) => s + a.value, 0),
    [allAccounts, hiddenKeys]
  );
  const customNet = visibleHaveTotal - visibleOweTotal - visibleSpentTotal;
  const netPositive = customNet >= 0;
  const hiddenCount = hiddenKeys.size;
  const visibleCount = allAccounts.filter((a) => !hiddenKeys.has(a.key)).length;

  const sideLabel = (side: PropsCustomAccount["side"]) => {
    if (side === "have") return "Have";
    if (side === "owe") return "Owe";
    return "Spent";
  };

  const sideBadgeClass = (side: PropsCustomAccount["side"]) => {
    if (side === "have") return "text-green-700 dark:text-green-400 border-green-600/30";
    if (side === "owe") return "text-red-600 dark:text-red-400 border-red-500/30";
    return "text-orange-600 dark:text-orange-400 border-orange-500/30";
  };

  const sideValueClass = (side: PropsCustomAccount["side"]) => {
    if (side === "have") return "text-green-600 dark:text-green-400";
    if (side === "owe") return "text-red-600 dark:text-red-400";
    return "text-orange-600 dark:text-orange-400";
  };

  return (
    <Card data-testid="card-props-custom-net-position">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <Equal className="h-4 w-4 text-muted-foreground" />
            <CardTitle className="text-base">Custom Net Position View</CardTitle>
            <Badge variant="outline" className="text-xs">
              View only
            </Badge>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            {hiddenCount > 0 && (
              <span className="text-xs text-muted-foreground">
                {hiddenCount} account{hiddenCount !== 1 ? "s" : ""} hidden
              </span>
            )}
            {hiddenCount > 0 && (
              <Button variant="ghost" size="sm" onClick={resetAll} data-testid="button-props-custom-view-reset">
                <RotateCcw className="h-3.5 w-3.5 mr-1" />
                Show all
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Same accounts as the Net Position breakdown above. Hide any account to adjust the subtotal shown here — the
          actual figures above are never affected.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center gap-6 flex-wrap">
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Custom Net</p>
            <p
              className={`text-2xl font-bold font-mono ${netPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
              data-testid="text-props-custom-net-position"
            >
              {customNet < 0 ? "-" : ""}
              {formatAmount(Math.abs(customNet))}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Have</p>
            <p className="font-mono font-semibold text-green-600 dark:text-green-400">
              {formatAmount(visibleHaveTotal)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Owe</p>
            <p className="font-mono font-semibold text-red-600 dark:text-red-400">{formatAmount(visibleOweTotal)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Spent</p>
            <p className="font-mono font-semibold text-orange-600 dark:text-orange-400">
              {formatAmount(visibleSpentTotal)}
            </p>
          </div>
          {hiddenCount > 0 && (
            <Badge variant="secondary" className="text-xs ml-auto">
              {hiddenCount} excluded
            </Badge>
          )}
        </div>

        {allAccounts.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted-foreground text-center">No accounts to display.</p>
        ) : (
          <div className="divide-y divide-border">
            {allAccounts.map((acc) => {
              const hidden = hiddenKeys.has(acc.key);
              return (
                <div
                  key={acc.key}
                  className={`flex items-center gap-3 px-4 py-2.5 ${hidden ? "opacity-40" : ""}`}
                  data-testid={`row-props-custom-view-${acc.key}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge variant="outline" className={`text-[11px] px-1 h-4 shrink-0 ${sideBadgeClass(acc.side)}`}>
                        {sideLabel(acc.side)}
                      </Badge>
                      <p className="text-sm font-medium truncate">{acc.name}</p>
                    </div>
                  </div>
                  <span className={`font-mono text-sm font-semibold shrink-0 ${sideValueClass(acc.side)}`}>
                    {formatAmount(acc.value)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => toggle(acc.key)}
                    data-testid={`button-props-custom-view-toggle-${acc.key}`}
                    title={hidden ? "Include in custom total" : "Exclude from custom total"}
                  >
                    {hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        <div className="border-t border-border px-4 py-3 flex items-center justify-between bg-muted/30">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Custom Net Position</span>
            {hiddenCount > 0 && (
              <span className="text-xs text-muted-foreground">
                ({visibleCount} of {allAccounts.length} accounts)
              </span>
            )}
          </div>
          <span
            className={`font-mono text-base font-bold ${netPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
            data-testid="text-props-custom-net-footer"
          >
            {customNet < 0 ? "-" : ""}
            {formatAmount(Math.abs(customNet))}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

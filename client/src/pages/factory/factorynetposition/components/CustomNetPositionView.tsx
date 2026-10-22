/**
 * CustomNetPositionView — extracted sub-component.
 *
 * Extracted from FactoryNetPosition.tsx during the Phase 4 god-file split.
 */
import { useState, useCallback, useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Equal, EyeOff, Eye, RotateCcw } from "lucide-react";

import type { CustomViewAccount, NetPositionData } from "../types";
import { fmt, loadCustomViewHidden, saveCustomViewHidden } from "../utils";

export function CustomNetPositionView({ data }: { data: NetPositionData }) {
  const companyId = data.companyId;
  const [hiddenKeys, setHiddenKeys] = useState<Set<string>>(() => loadCustomViewHidden(companyId));

  const allAccounts = useMemo<CustomViewAccount[]>(() => {
    const accountKey = (
      side: "forUs" | "onUs",
      rows: NetPositionData["forUs"]["accounts"],
      a: (typeof rows)[number],
      index: number
    ) =>
      rows.filter((row) => row.name === a.name).length > 1
        ? `${side}:${a.id != null ? `ledger:${a.id}` : `${a.code}:${a.name}:${index}`}`
        : `${side}:${a.name}`;
    const forUsRows = data.forUs.accounts ?? [];
    const onUsRows = data.onUs.accounts ?? [];
    const forUs = forUsRows.map((a, index) => ({
      key: accountKey("forUs", forUsRows, a, index),
      name: a.name,
      code: a.code,
      category: a.category,
      value: a.value,
      side: "forUs" as const,
    }));
    const onUs = onUsRows.map((a, index) => ({
      key: accountKey("onUs", onUsRows, a, index),
      name: a.name,
      code: a.code,
      category: a.category,
      value: a.value,
      side: "onUs" as const,
    }));
    return [...forUs, ...onUs];
  }, [data.forUs.accounts, data.onUs.accounts]);

  const toggle = useCallback(
    (key: string) => {
      setHiddenKeys((prev) => {
        const next = new Set(prev);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        saveCustomViewHidden(next, companyId);
        return next;
      });
    },
    [companyId]
  );

  const resetAll = useCallback(() => {
    const empty = new Set<string>();
    setHiddenKeys(empty);
    saveCustomViewHidden(empty, companyId);
  }, [companyId]);

  const visibleForUsTotal = useMemo(
    () => allAccounts.filter((a) => a.side === "forUs" && !hiddenKeys.has(a.key)).reduce((s, a) => s + a.value, 0),
    [allAccounts, hiddenKeys]
  );
  const visibleOnUsTotal = useMemo(
    () => allAccounts.filter((a) => a.side === "onUs" && !hiddenKeys.has(a.key)).reduce((s, a) => s + a.value, 0),
    [allAccounts, hiddenKeys]
  );
  const customNet = visibleForUsTotal - visibleOnUsTotal;
  const netPositive = customNet >= 0;
  const hiddenCount = allAccounts.filter((a) => hiddenKeys.has(a.key)).length;
  const visibleCount = allAccounts.filter((a) => !hiddenKeys.has(a.key)).length;

  return (
    <Card data-testid="card-custom-net-position-view">
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
              <Button variant="ghost" size="sm" onClick={resetAll} data-testid="button-custom-view-reset">
                <RotateCcw className="h-3.5 w-3.5 mr-1" />
                Show all
              </Button>
            )}
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Same accounts as the Net Position table above. Hide any account to adjust the subtotal shown here — the actual
          Net Position calculation above is never affected.
        </p>
      </CardHeader>
      <CardContent className="p-0">
        {/* Mini totals banner */}
        <div className="px-4 py-3 border-b border-border bg-muted/20 flex items-center gap-6 flex-wrap">
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Custom Net</p>
            <p
              className={`text-2xl font-bold font-mono ${netPositive ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"}`}
              data-testid="text-custom-net-position"
            >
              {customNet < 0 ? "-" : ""}
              {fmt(Math.abs(customNet))}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Have</p>
            <p className="font-mono font-semibold text-green-600 dark:text-green-400">{fmt(visibleForUsTotal)}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground mb-0.5">Owe</p>
            <p className="font-mono font-semibold text-red-600 dark:text-red-400">{fmt(visibleOnUsTotal)}</p>
          </div>
          {hiddenCount > 0 && (
            <Badge variant="secondary" className="text-xs ml-auto">
              {hiddenCount} excluded
            </Badge>
          )}
        </div>

        {/* Account rows */}
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
                  data-testid={`row-custom-view-${acc.key}`}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <Badge
                        variant="outline"
                        className={`text-[11px] px-1 h-4 shrink-0 ${
                          acc.side === "forUs"
                            ? "text-green-700 dark:text-green-400 border-green-600/30"
                            : "text-red-600 dark:text-red-400 border-red-500/30"
                        }`}
                      >
                        {acc.side === "forUs" ? "Have" : "Owe"}
                      </Badge>
                      <p className="text-sm font-medium truncate">{acc.name}</p>
                    </div>
                    <p className="text-xs text-muted-foreground">{acc.category}</p>
                  </div>
                  <span
                    className={`font-mono text-sm font-semibold shrink-0 ${
                      acc.side === "forUs" ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                    }`}
                  >
                    {fmt(acc.value)}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => toggle(acc.key)}
                    data-testid={`button-custom-view-toggle-${acc.key}`}
                    title={hidden ? "Include in custom total" : "Exclude from custom total"}
                  >
                    {hidden ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                  </Button>
                </div>
              );
            })}
          </div>
        )}

        {/* Footer total */}
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
            data-testid="text-custom-net-footer"
          >
            {customNet < 0 ? "-" : ""}
            {fmt(Math.abs(customNet))}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}

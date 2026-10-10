// LEGACY — Stock Allocation V2. Superseded by FactoryStockAllocationV5. Kept as fallback only. Route: /factory/stock-allocation (not in sidebar).
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Loader2, RefreshCw, Info, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import CreateProformaDrawer from "./CreateProformaDrawer";
import { PageHeader } from "@/components/PageHeader";

/* ─── Types ───────────────────────────────────────────────────────────────── */
interface StockTruthEntry {
  articleCode: string;
  isActive: boolean;
  onHand: number;
  inStock: number;
  inLoading: number;
  proformaReserved: number;
  reservedNotYetLoaded: number;
  freeToPromise: number;
}
interface ProformaLineV2 {
  id: number;
  articleCode: string;
  productName: string;
  quantity: number;
  alreadyLoaded: number;
  remainingToLoad: number;
}
interface ProformaV2 {
  id: number;
  customerId: number;
  customerName: string;
  name: string;
  isActive: boolean;
  lines: ProformaLineV2[];
}
interface AllocationDataV2 {
  stockTruth: StockTruthEntry[];
  proformas: ProformaV2[];
  productNames: Record<string, string>;
}

/* ═══════════════════════════════════════════════════════════════════════════ */
export default function FactoryStockAllocationV2() {
  const [visibleProformaIds, setVisibleProformaIds] = useState<Set<number>>(new Set());
  const [showInactiveProformas, setShowInactiveProformas] = useState(false);
  const [showZeroItems, setShowZeroItems] = useState(false);
  const [createDrawerOpen, setCreateDrawerOpen] = useState(false);

  const proformaQuery = useQuery<AllocationDataV2>({
    queryKey: ["/api/factory/v2/stock-allocation"],
    queryFn: async () => {
      const res = await fetch("/api/factory/v2/stock-allocation", { credentials: "include" });
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.message || "Failed");
      }
      return res.json();
    },
    retry: 1,
  });

  const toggleProformaVisible = (id: number) => {
    setVisibleProformaIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  /* ── Backend truth drives everything ──────────────────────────────────── */
  const computed = useMemo(() => {
    const data = proformaQuery.data;
    if (!data)
      return {
        articleRows: [] as (StockTruthEntry & { displayName: string })[],
        allProformas: [] as ProformaV2[],
        visibleProformas: [] as ProformaV2[],
        hiddenZeroCount: 0,
      };

    const allProformas = data.proformas.filter((p) => p.isActive || showInactiveProformas);
    const visibleProformas = allProformas.filter((p) => visibleProformaIds.has(p.id));

    const allCodes = new Set<string>([
      ...data.stockTruth.map((t) => t.articleCode),
      ...allProformas.flatMap((p) => p.lines.map((l) => l.articleCode)),
    ]);

    const truthMap = new Map(data.stockTruth.map((t) => [t.articleCode, t]));

    const articleRows = Array.from(allCodes)
      .map((code) => {
        const truth = truthMap.get(code) || {
          articleCode: code,
          onHand: 0,
          inStock: 0,
          inLoading: 0,
          proformaReserved: 0,
          reservedNotYetLoaded: 0,
          freeToPromise: 0,
          isActive: true,
        };
        // productNames (from factory_bale_products SQL) is the canonical source — always wins.
        // Only fall back to the proforma line's stored productName if the canonical lookup fails
        // AND the stored name is actually different from the code (i.e. a real name was saved).
        let displayName = data.productNames[code];
        if (!displayName) {
          for (const p of allProformas) {
            const line = p.lines.find((l) => l.articleCode === code);
            if (line?.productName && line.productName !== code) {
              displayName = line.productName;
              break;
            }
          }
        }
        displayName = displayName || code;
        // isActive comes from the backend tag; default true if not yet in stockTruth
        const isActive = truth.isActive ?? true;
        return { ...truth, isActive, displayName };
      })
      .sort((a, b) => a.displayName.localeCompare(b.displayName));

    // Determine which rows have "substance" (bales or proforma allocations)
    const hasSubstance = (r: (typeof articleRows)[number]) =>
      r.onHand > 0 ||
      r.proformaReserved > 0 ||
      allProformas.some((p) => p.lines.some((l) => l.articleCode === r.articleCode));

    // Inactive items: show only if they have bales (onHand > 0)
    // Active items with 0 bales and no allocations: hidden unless showZeroItems
    const visibleRows = articleRows.filter((r) => {
      if (!r.isActive) return r.onHand > 0; // inactive → only show if physical stock exists
      if (hasSubstance(r)) return true; // active with allocations → always show
      return showZeroItems; // active with nothing → depends on toggle
    });

    const hiddenZeroCount = articleRows.filter((r) => r.isActive && !hasSubstance(r)).length;

    return { articleRows: visibleRows, hiddenZeroCount, allProformas, visibleProformas };
  }, [proformaQuery.data, visibleProformaIds, showInactiveProformas, showZeroItems]);

  /* ── Render ──────────────────────────────────────────────────────────── */
  return (
    <div className="p-4 flex flex-col gap-4 h-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <PageHeader title="Stock Allocation" />
          <Badge variant="secondary" className="text-[11px] font-semibold tracking-wide">
            v2
          </Badge>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {computed.hiddenZeroCount > 0 && (
            <Button
              variant={showZeroItems ? "default" : "outline"}
              size="default"
              onClick={() => setShowZeroItems((v) => !v)}
              data-testid="button-toggle-zero-items"
            >
              {showZeroItems
                ? `Hide 0-bale items (${computed.hiddenZeroCount})`
                : `Show 0-bale items (${computed.hiddenZeroCount})`}
            </Button>
          )}
          <Button size="default" onClick={() => setCreateDrawerOpen(true)} data-testid="button-open-create-proforma">
            <Plus className="h-4 w-4 mr-2" />
            Create Proforma
          </Button>
          <Button
            variant="outline"
            size="default"
            onClick={() => proformaQuery.refetch()}
            data-testid="button-refresh-allocation"
          >
            <RefreshCw className="h-4 w-4 mr-2" />
            Refresh
          </Button>
        </div>
      </div>

      {/* Content */}
      {proformaQuery.isLoading ? (
        <div className="flex items-center justify-center h-48">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      ) : proformaQuery.isError ? (
        <div className="p-6 flex flex-col items-center justify-center h-48 gap-4">
          <p className="text-muted-foreground text-sm">
            {(proformaQuery.error as Error)?.message || "Failed to load."}
          </p>
          <Button variant="outline" onClick={() => proformaQuery.refetch()}>
            <RefreshCw className="h-4 w-4 mr-2" />
            Try Again
          </Button>
        </div>
      ) : (
        <>
          {/* Proforma column toggles */}
          {computed.allProformas.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-3">
                <p className="text-xs text-muted-foreground font-medium">Show proforma columns:</p>
                <Button
                  variant={showInactiveProformas ? "default" : "outline"}
                  size="sm"
                  onClick={() => setShowInactiveProformas((v) => !v)}
                  data-testid="button-toggle-inactive-proformas"
                >
                  {showInactiveProformas ? "Hide Inactive" : "Show Inactive"}
                </Button>
              </div>
              <div className="flex flex-wrap gap-2">
                {computed.allProformas.map((p) => {
                  const isOn = visibleProformaIds.has(p.id);
                  return (
                    <Button
                      key={p.id}
                      variant={isOn ? "default" : "outline"}
                      size="sm"
                      onClick={() => toggleProformaVisible(p.id)}
                      data-testid={`button-proforma-toggle-${p.id}`}
                      className="flex flex-col h-auto py-1.5 px-3 items-start gap-0"
                    >
                      <span className="text-xs font-semibold leading-tight">{p.customerName}</span>
                      <span
                        className={cn(
                          "text-[10px] leading-tight",
                          isOn ? "text-primary-foreground/70" : "text-muted-foreground"
                        )}
                      >
                        {p.name}
                      </span>
                      {!p.isActive && (
                        <span
                          className={cn(
                            "text-[10px] leading-tight",
                            isOn ? "text-primary-foreground/60" : "text-muted-foreground/60"
                          )}
                        >
                          inactive
                        </span>
                      )}
                    </Button>
                  );
                })}
              </div>
            </div>
          )}

          {computed.allProformas.length === 0 && computed.articleRows.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                No proformas found. Create a proforma first to use stock allocation.
              </CardContent>
            </Card>
          ) : computed.articleRows.length === 0 ? (
            <Card>
              <CardContent className="p-8 text-center text-muted-foreground">
                No article codes found in stock or proformas.
              </CardContent>
            </Card>
          ) : (
            <div data-horizontal-scroll="true" className="overflow-x-auto rounded-md border">
              <table className="w-full text-sm border-collapse min-w-max">
                <thead>
                  <tr className="bg-muted sticky top-0 z-30">
                    <th className="text-left px-3 py-2.5 font-medium border-b border-r whitespace-nowrap sticky left-0 bg-muted z-20 min-w-[200px]">
                      Product
                    </th>

                    <th className="text-right px-3 py-2.5 font-medium border-b border-r whitespace-nowrap min-w-[90px]">
                      <span className="flex items-center justify-end gap-1">
                        On Hand
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3 w-3 text-muted-foreground cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-[260px] text-xs">
                            Total physical bales still in the warehouse pool — includes both free stock and bales
                            already assigned to active loading orders.
                            <br />
                            <span className="font-mono mt-1 block">= Free stock + In Loading</span>
                          </TooltipContent>
                        </Tooltip>
                      </span>
                    </th>

                    <th className="text-right px-3 py-2.5 font-medium border-b border-r whitespace-nowrap min-w-[95px] text-amber-600 dark:text-amber-400">
                      <span className="flex items-center justify-end gap-1">
                        Reserved
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3 w-3 text-amber-400 cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-[260px] text-xs">
                            Total quantity committed to active proformas but not yet physically loaded.
                            <br />
                            <span className="font-mono mt-1 block">= Proforma qty − Already loaded</span>
                          </TooltipContent>
                        </Tooltip>
                      </span>
                    </th>

                    <th className="text-right px-3 py-2.5 font-medium border-b border-r whitespace-nowrap min-w-[95px] text-blue-600 dark:text-blue-400">
                      <span className="flex items-center justify-end gap-1">
                        In Loading
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3 w-3 text-blue-400 cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-[260px] text-xs">
                            Bales already scanned into active loading orders. Still counted in On Hand until the
                            shipment is finalised.
                          </TooltipContent>
                        </Tooltip>
                      </span>
                    </th>

                    <th className="text-right px-3 py-2.5 font-medium border-b border-r whitespace-nowrap min-w-[115px] text-green-700 dark:text-green-400">
                      <span className="flex items-center justify-end gap-1">
                        Free to Promise
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <Info className="h-3 w-3 text-green-500 cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent side="bottom" className="max-w-[260px] text-xs">
                            Stock available to commit to new proformas. Computed entirely on the server.
                            <br />
                            <span className="font-mono mt-1 block">= On Hand − Reserved − In Loading</span>
                          </TooltipContent>
                        </Tooltip>
                      </span>
                    </th>

                    {computed.visibleProformas.map((p) => (
                      <th key={p.id} className="px-2 py-1.5 font-medium border-b border-r text-center min-w-[140px]">
                        <div className="flex flex-col items-center gap-0.5">
                          <span className="text-xs font-semibold truncate max-w-[130px]" title={p.customerName}>
                            {p.customerName}
                          </span>
                          <span className="text-xs text-muted-foreground truncate max-w-[130px]" title={p.name}>
                            {p.name}
                          </span>
                          {!p.isActive && (
                            <Badge variant="outline" className="text-[10px] px-1">
                              Inactive
                            </Badge>
                          )}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {computed.articleRows.map((row, idx) => (
                    <tr
                      key={row.articleCode}
                      className={cn(
                        "border-b transition-colors",
                        !row.isActive ? "opacity-60" : "",
                        idx % 2 === 0 ? "bg-background" : "bg-muted/20"
                      )}
                      data-testid={`row-article-${row.articleCode}`}
                    >
                      <td className="px-3 py-2 border-r sticky left-0 bg-inherit z-10">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          <span className="font-medium truncate max-w-[200px]" title={row.displayName}>
                            {row.displayName}
                          </span>
                          {!row.isActive && (
                            <Badge variant="outline" className="text-[10px] px-1 py-0 shrink-0">
                              Inactive
                            </Badge>
                          )}
                        </div>
                        {row.displayName !== row.articleCode && (
                          <div className="text-xs text-muted-foreground font-mono">{row.articleCode}</div>
                        )}
                      </td>

                      <td className="px-3 py-2 text-right border-r font-mono tabular-nums">{row.onHand}</td>

                      <td
                        className={cn(
                          "px-3 py-2 text-right border-r font-mono tabular-nums",
                          row.reservedNotYetLoaded > 0 ? "text-amber-600 dark:text-amber-400" : ""
                        )}
                      >
                        {row.reservedNotYetLoaded > 0 ? (
                          row.reservedNotYetLoaded
                        ) : (
                          <span className="text-muted-foreground/40 text-xs">—</span>
                        )}
                      </td>

                      <td
                        className={cn(
                          "px-3 py-2 text-right border-r font-mono tabular-nums",
                          row.inLoading > 0 ? "text-blue-600 dark:text-blue-400" : ""
                        )}
                      >
                        {row.inLoading > 0 ? (
                          row.inLoading
                        ) : (
                          <span className="text-muted-foreground/40 text-xs">—</span>
                        )}
                      </td>

                      <td
                        className={cn(
                          "px-3 py-2 text-right border-r font-mono tabular-nums font-semibold",
                          row.freeToPromise > 0
                            ? "text-green-700 dark:text-green-400"
                            : row.freeToPromise === 0
                              ? "text-muted-foreground"
                              : "text-destructive"
                        )}
                      >
                        {row.freeToPromise}
                      </td>

                      {computed.visibleProformas.map((p) => {
                        const line = p.lines.find((l) => l.articleCode === row.articleCode);
                        if (!line)
                          return (
                            <td key={p.id} className="px-2 py-2 text-center border-r bg-muted/30">
                              <span className="text-muted-foreground/40 text-xs">—</span>
                            </td>
                          );
                        const done = line.remainingToLoad <= 0;
                        return (
                          <td key={p.id} className="px-2 py-2 text-center border-r">
                            <span
                              className={cn(
                                "font-semibold font-mono tabular-nums",
                                done ? "text-green-700 dark:text-green-400" : "text-foreground"
                              )}
                            >
                              {line.quantity}
                            </span>
                            {line.alreadyLoaded > 0 && (
                              <div className="text-[10px] text-muted-foreground/60">
                                {line.alreadyLoaded} loaded · {line.remainingToLoad} left
                              </div>
                            )}
                            {line.alreadyLoaded === 0 && (
                              <div className="text-[10px] text-muted-foreground/60">bales</div>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      <CreateProformaDrawer
        open={createDrawerOpen}
        onClose={() => setCreateDrawerOpen(false)}
        articleRows={computed.articleRows}
        onSuccess={() => proformaQuery.refetch()}
      />
    </div>
  );
}

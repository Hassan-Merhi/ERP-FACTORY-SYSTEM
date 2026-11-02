/**
 * "Available Waste Bales" card for the Waste Dispatch page: the paged
 * product-group table with expandable per-bale rows, the running totals row,
 * and the search / select-all controls.
 *
 * Extracted from WasteDispatchOptimized.tsx during the P1 god-file split.
 * Purely presentational — all queries and selection state come from
 * useWasteDispatchModel.
 */

import { Fragment } from "react";
import { Boxes, Loader2, Search, ChevronDown, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { baleMatchesSearch } from "../optimizedData";
import { fmt, fmtKg } from "../utils";
import type { useWasteDispatchModel } from "../useWasteDispatchModel";
import type { WasteBale } from "../optimizedTypes";

type WasteDispatchModel = ReturnType<typeof useWasteDispatchModel>;

export function WasteBaleGroupTable({ model }: { model: WasteDispatchModel }) {
  const {
    search,
    setSearch,
    balePage,
    setBalePage,
    summaryLoading,
    groups,
    summaryTotals,
    summaryPagination,
    selectAllMutation,
  } = model;

  return (
    <Card className="overflow-hidden rounded-2xl border-slate-200 bg-white shadow-sm dark:border-slate-700/70 dark:bg-slate-900/80">
      <CardHeader className="border-b border-slate-200 px-4 pb-3 pt-4 dark:border-slate-700/70 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-500/10 text-orange-600 dark:bg-orange-500/15 dark:text-orange-400">
              <Boxes className="h-5 w-5" />
            </div>
            <CardTitle className="text-base font-bold tracking-tight sm:text-lg">Available Waste Bales</CardTitle>
            {!summaryLoading && (
              <Badge variant="outline" className="border-orange-300 bg-orange-50 px-2.5 py-1 text-xs font-semibold text-orange-800 dark:border-orange-500/40 dark:bg-orange-500/15 dark:text-orange-300">
                {summaryTotals.bales} bales · {summaryPagination.total} products
              </Badge>
            )}
          </div>
          <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
            <div className="relative min-w-0 flex-1 sm:flex-none">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Filter bales or products..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-9 w-full rounded-lg border-slate-300 bg-slate-50 pl-8 text-xs focus-visible:ring-orange-500 dark:border-slate-600 dark:bg-slate-950/50 sm:w-56"
                data-testid="input-search-bales"
              />
            </div>
            <Button
              variant="default"
              size="sm"
              className="h-9 rounded-lg bg-orange-600 px-4 text-xs font-semibold text-white shadow-sm hover:bg-orange-700 dark:bg-orange-600 dark:hover:bg-orange-500"
              disabled={summaryTotals.bales === 0 || selectAllMutation.isPending}
              onClick={() => selectAllMutation.mutate()}
              data-testid="button-select-all-waste"
            >
              {selectAllMutation.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
              Select all matching
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="p-3 sm:p-4">
        {summaryLoading && !groups.length ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : groups.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            <Trash2 className="mx-auto mb-3 h-10 w-10 opacity-25" />
            <p className="text-sm">No matching Garbage or Wiper bales in stock.</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl">
              <Table mobileLayout="cards" wrapperClassName="rounded-xl border-slate-200 dark:border-slate-700/70" className="text-slate-900 dark:text-slate-100">
                <TableHeader className="bg-slate-100 dark:bg-slate-800/95">
                  <TableRow className="border-b border-slate-300 bg-slate-100 dark:border-slate-700 dark:bg-slate-800/95">
                    <TableHead className="w-8 px-3 py-2" />
                    <TableHead className="px-3 py-2 text-xs">Product</TableHead>
                    <TableHead className="px-3 py-2 text-xs">Category</TableHead>
                    <TableHead className="px-3 py-2 text-right text-xs">Bales</TableHead>
                    <TableHead className="px-3 py-2 text-right text-xs">Weight (kg)</TableHead>
                    <TableHead className="px-3 py-2 text-right text-xs">Avg Rate</TableHead>
                    <TableHead className="px-3 py-2 text-right text-xs">Total Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {groups.map((group) => (
                    <WasteBaleGroupRow key={group.productId} group={group} model={model} />
                  ))}

                  <TableRow className="border-t-2 border-orange-300 bg-orange-50/70 font-bold dark:border-orange-500/30 dark:bg-orange-500/10">
                    <TableCell className="px-3 py-2" />
                    <TableCell className="px-3 py-2 text-xs" colSpan={2}>
                      TOTAL — {summaryPagination.total} product{summaryPagination.total !== 1 ? "s" : ""}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-right text-xs">{summaryTotals.bales}</TableCell>
                    <TableCell className="px-3 py-2 text-right text-xs">{fmtKg(summaryTotals.weight)}</TableCell>
                    <TableCell className="px-3 py-2 text-right text-xs text-muted-foreground">
                      {summaryTotals.bales > 0 && summaryTotals.cost > 0
                        ? fmt(summaryTotals.cost / summaryTotals.bales)
                        : "—"}
                    </TableCell>
                    <TableCell className="px-3 py-2 text-right text-xs">
                      {summaryTotals.cost > 0 ? fmt(summaryTotals.cost) : "—"}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>

            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 px-1 pt-3 dark:border-slate-700">
              <span className="text-xs text-muted-foreground">
                Page {summaryPagination.page} of {summaryPagination.totalPages}
              </span>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  disabled={balePage <= 1}
                  onClick={() => setBalePage((page) => Math.max(1, page - 1))}
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2"
                  disabled={balePage >= summaryPagination.totalPages}
                  onClick={() => setBalePage((page) => Math.min(summaryPagination.totalPages, page + 1))}
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function WasteBaleGroupRow({
  group,
  model,
}: {
  group: WasteDispatchModel["groups"][number];
  model: WasteDispatchModel;
}) {
  const {
    debouncedSearch,
    expandedGroups,
    selectedBales,
    selected,
    toggleExpandGroup,
    toggleGroupSelection,
    toggleBale,
    groupQueryById,
  } = model;

  const isExpanded = expandedGroups.has(group.productId);
  const selectedInGroup = selectedBales.filter(
    (bale) => bale.productId === group.productId && baleMatchesSearch(bale, debouncedSearch)
  ).length;
  const allSelected = group.baleCount > 0 && selectedInGroup === group.baleCount;
  const partiallySelected = selectedInGroup > 0 && !allSelected;
  const groupCheckState: boolean | "indeterminate" = allSelected ? true : partiallySelected ? "indeterminate" : false;
  const detailQuery = groupQueryById.get(group.productId);
  const bales = (detailQuery?.data as WasteBale[] | undefined) ?? [];

  return (
    <Fragment>
      <TableRow className={allSelected ? "bg-orange-100/70 dark:bg-orange-500/15" : partiallySelected ? "bg-orange-50/70 dark:bg-orange-500/10" : "transition-colors hover:bg-orange-50/60 dark:hover:bg-slate-800/80"}>
        <TableCell className="px-3 py-2">
          <Checkbox
            checked={groupCheckState}
            onCheckedChange={() => void toggleGroupSelection(group)}
            data-testid={`checkbox-group-${group.productId}`}
          />
        </TableCell>
        <TableCell className="cursor-pointer px-3 py-2.5" onClick={() => toggleExpandGroup(group.productId)}>
          <div className="flex items-center gap-2">
            {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span className="text-sm font-semibold tracking-tight">{group.productName}</span>
            {selectedInGroup > 0 && (
              <Badge variant="outline" className="text-xs">
                {selectedInGroup} selected
              </Badge>
            )}
          </div>
        </TableCell>
        <TableCell className="cursor-pointer px-3 py-2" onClick={() => toggleExpandGroup(group.productId)}>
          <Badge variant="outline" className={group.categoryName.toUpperCase().includes("GARBAGE") ? "rounded-md border-orange-300 bg-orange-100 px-2 py-0.5 text-[11px] font-semibold uppercase text-orange-900 dark:border-orange-500/40 dark:bg-orange-500/20 dark:text-orange-200" : "rounded-md border-blue-300 bg-blue-100 px-2 py-0.5 text-[11px] font-semibold uppercase text-blue-900 dark:border-blue-500/40 dark:bg-blue-500/20 dark:text-blue-200"}>
            {group.categoryName}
          </Badge>
        </TableCell>
        <TableCell
          className="cursor-pointer px-3 py-2 text-right text-sm"
          onClick={() => toggleExpandGroup(group.productId)}
        >
          {group.baleCount}
        </TableCell>
        <TableCell
          className="cursor-pointer px-3 py-2 text-right text-sm"
          onClick={() => toggleExpandGroup(group.productId)}
        >
          {fmtKg(group.totalWeight)}
        </TableCell>
        <TableCell
          className="cursor-pointer px-3 py-2 text-right text-xs text-muted-foreground"
          onClick={() => toggleExpandGroup(group.productId)}
        >
          {group.avgRate > 0 ? fmt(group.avgRate) : "—"}
        </TableCell>
        <TableCell
          className="cursor-pointer px-3 py-2 text-right text-sm font-medium"
          onClick={() => toggleExpandGroup(group.productId)}
        >
          {group.totalCost > 0 ? fmt(group.totalCost) : "—"}
        </TableCell>
      </TableRow>

      {isExpanded && detailQuery?.isLoading && (
        <TableRow>
          <TableCell colSpan={7} className="py-4 text-center">
            <Loader2 className="mx-auto h-4 w-4 animate-spin" />
          </TableCell>
        </TableRow>
      )}
      {isExpanded && detailQuery?.isError && (
        <TableRow>
          <TableCell colSpan={7} className="py-3 text-center text-xs text-destructive">
            Could not load bale details.
          </TableCell>
        </TableRow>
      )}
      {isExpanded &&
        !detailQuery?.isLoading &&
        bales.map((bale) => (
          <TableRow
            key={bale.id}
            className={`cursor-pointer text-xs transition-colors ${selected.has(bale.id) ? "bg-orange-100/70 dark:bg-orange-500/15" : "bg-slate-50/80 hover:bg-orange-50 dark:bg-slate-800/50 dark:hover:bg-slate-800"}`}
            onClick={() => toggleBale(bale)}
            data-testid={`row-bale-${bale.id}`}
          >
            <TableCell className="px-3 py-1.5 pl-5" onClick={(event) => event.stopPropagation()}>
              <Checkbox checked={selected.has(bale.id)} onCheckedChange={() => toggleBale(bale)} />
            </TableCell>
            <TableCell className="px-3 py-1.5 pl-8" colSpan={2}>
              <div className="flex items-center gap-2">
                <span className="font-mono font-semibold text-primary">{bale.referenceNumber}</span>
                <span className="text-muted-foreground">{bale.locationName}</span>
              </div>
            </TableCell>
            <TableCell className="px-3 py-1.5 text-right">1</TableCell>
            <TableCell className="px-3 py-1.5 text-right">{fmtKg(bale.weightKg)}</TableCell>
            <TableCell className="px-3 py-1.5 text-right text-muted-foreground">
              {bale.totalCost > 0 ? fmt(bale.totalCost) : "—"}
            </TableCell>
            <TableCell className="px-3 py-1.5 text-right">{bale.totalCost > 0 ? fmt(bale.totalCost) : "—"}</TableCell>
          </TableRow>
        ))}
    </Fragment>
  );
}

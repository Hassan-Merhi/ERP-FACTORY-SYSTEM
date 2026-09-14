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
import { Loader2, Search, ChevronDown, ChevronLeft, ChevronRight, Trash2 } from "lucide-react";
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
    <Card>
      <CardHeader className="px-4 pb-2 pt-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <CardTitle className="text-sm">Available Waste Bales</CardTitle>
            {!summaryLoading && (
              <Badge variant="outline" className="text-xs">
                {summaryTotals.bales} bales · {summaryPagination.total} products
              </Badge>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Filter bales or products..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                className="h-8 w-52 pl-8 text-xs"
                data-testid="input-search-bales"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 px-3 text-xs"
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
      <CardContent className="p-0">
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
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow className="bg-muted/40">
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

                  <TableRow className="border-t-2 bg-muted/50 font-bold">
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

            <div className="flex items-center justify-between border-t px-4 py-2">
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
      <TableRow className={allSelected ? "bg-destructive/5" : partiallySelected ? "bg-destructive/3" : ""}>
        <TableCell className="px-3 py-2">
          <Checkbox
            checked={groupCheckState}
            onCheckedChange={() => void toggleGroupSelection(group)}
            data-testid={`checkbox-group-${group.productId}`}
          />
        </TableCell>
        <TableCell className="cursor-pointer px-3 py-2" onClick={() => toggleExpandGroup(group.productId)}>
          <div className="flex items-center gap-2">
            {isExpanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span className="text-sm font-semibold">{group.productName}</span>
            {selectedInGroup > 0 && (
              <Badge variant="outline" className="text-xs">
                {selectedInGroup} selected
              </Badge>
            )}
          </div>
        </TableCell>
        <TableCell className="cursor-pointer px-3 py-2" onClick={() => toggleExpandGroup(group.productId)}>
          <Badge variant="outline" className="text-xs">
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
            className={`cursor-pointer text-xs ${selected.has(bale.id) ? "bg-destructive/8" : "bg-muted/10"}`}
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

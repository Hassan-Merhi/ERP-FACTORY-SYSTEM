/**
 * Left column of the ERP container loading scan page: the scan input, the
 * last-scanned banner and the grouped bale list.
 *
 * Split out of ContainerLoadingScan.tsx unchanged — the card ring follows the
 * scan flash, the input keeps autofocus and its Enter handler, and detailed
 * view lists individual bales newest-first with an inline remove action.
 */
import { AlignJustify, Package, Rows3, ScanLine, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableRow } from "@/components/ui/table";
import type { ContainerLoadingScanModel } from "./useContainerLoadingScanModel";

function BaleGroups({ model }: { model: ContainerLoadingScanModel }) {
  if (model.orderedGroups.length === 0) {
    return (
      <div
        className="flex flex-col items-center justify-center py-12 text-muted-foreground"
        data-testid="text-no-bales"
      >
        <Package className="h-12 w-12 mb-3 opacity-40" />
        <p>No bales scanned yet</p>
        <p className="text-sm mt-1">
          {!model.orderId ? "Set up the loading order first, then scan bales" : "Scan bales using the scanner above"}
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      {model.orderedGroups.map((group) => (
        <div key={group.articleCode} data-testid={`group-article-${group.articleCode}`}>
          <button
            type="button"
            className="w-full flex flex-wrap items-center justify-between gap-2 mb-1 px-1 cursor-pointer rounded-md p-2 hover-elevate"
            onClick={() => model.toggleGroup(group.articleCode)}
            data-testid={`button-toggle-group-${group.articleCode}`}
          >
            <div className="flex items-center gap-2">
              <Badge variant="outline" data-testid={`badge-article-${group.articleCode}`}>
                {group.articleCode}
              </Badge>
              <span className="text-sm font-medium">{group.baleName}</span>
            </div>
            <div className="flex items-center gap-3 text-sm text-muted-foreground">
              <span>Qty: {group.bales.length}</span>
              <span>Wt: {group.totalWeight.toFixed(2)} kg</span>
            </div>
          </button>
          {model.viewMode === "detailed" && (
            <Table>
              <TableBody>
                {[...group.bales]
                  .sort((a, b) => b.id - a.id)
                  .map((bale) => (
                    <TableRow key={bale.id} data-testid={`row-bale-${bale.id}`}>
                      <TableCell className="font-mono text-sm" data-testid={`text-bale-ref-${bale.id}`}>
                        {bale.baleReference}
                      </TableCell>
                      <TableCell className="text-sm">{bale.baleName}</TableCell>
                      <TableCell className="text-right text-sm text-muted-foreground">
                        {parseFloat(bale.weight || "0").toFixed(2)} kg
                      </TableCell>
                      <TableCell className="w-[40px]">
                        <Button
                          variant="ghost"
                          size="icon"
                          onClick={() => model.removeBaleMutation.mutate(bale.id)}
                          disabled={model.removeBaleMutation.isPending}
                          data-testid={`button-remove-bale-${bale.id}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
              </TableBody>
            </Table>
          )}
        </div>
      ))}
    </div>
  );
}

export function ScannedBalesCard({ model }: { model: ContainerLoadingScanModel }) {
  const { scanFlash, bales, totalWeight, viewMode, lastScannedRef, orderId } = model;
  return (
    <div className="lg:w-[60%] flex flex-col min-h-0">
      <Card
        className={`flex-1 flex flex-col min-h-0 p-4 transition-colors duration-300 ${scanFlash === "success" ? "ring-4 ring-green-500 bg-green-50 dark:bg-green-950" : scanFlash === "error" ? "ring-2 ring-red-500" : ""}`}
      >
        <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
          <h2 className="font-semibold text-lg" data-testid="text-bales-header">
            Scanned Bales
          </h2>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" data-testid="badge-bale-count">
              {bales.length} bales
            </Badge>
            {bales.length > 0 && (
              <Badge variant="outline" data-testid="badge-total-weight">
                {totalWeight.toFixed(2)} kg
              </Badge>
            )}
            <Button
              size="icon"
              variant={viewMode === "detailed" ? "secondary" : "ghost"}
              onClick={() => model.setViewMode(viewMode === "detailed" ? "condensed" : "detailed")}
              title={viewMode === "detailed" ? "Switch to condensed view" : "Switch to detailed view"}
              data-testid="button-toggle-view-mode"
            >
              {viewMode === "detailed" ? <Rows3 className="h-4 w-4" /> : <AlignJustify className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {orderId && (
          <div className="mb-3">
            <label className="text-sm font-medium mb-1 block">
              <ScanLine className="inline h-4 w-4 mr-1" />
              Scan Bale
            </label>
            <Input
              ref={model.scannerRef}
              value={model.scanCode}
              onChange={(e) => model.setScanCode(e.target.value)}
              onKeyDown={model.handleScan}
              placeholder="Scan barcode, ref number, or article code…"
              disabled={!orderId || !model.orderDetail || !model.selectedLocationId || model.addBaleMutation.isPending}
              className={`text-lg h-12 font-mono ${model.scanInputClass}`}
              autoFocus
              data-testid="input-scan-code"
            />
          </div>
        )}

        {viewMode === "detailed" && lastScannedRef && (
          <div
            className="mb-3 flex items-center gap-3 rounded-md status-success px-3 py-2"
            data-testid="banner-last-scanned"
          >
            <div className="text-xs font-medium uppercase tracking-wide shrink-0 opacity-80">Last Scanned</div>
            <div className="min-w-0">
              <div className="font-mono font-bold text-sm truncate">{lastScannedRef.baleReference}</div>
              {lastScannedRef.baleName && <div className="text-xs opacity-80 truncate">{lastScannedRef.baleName}</div>}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto">
          <BaleGroups model={model} />
        </div>
      </Card>
    </div>
  );
}

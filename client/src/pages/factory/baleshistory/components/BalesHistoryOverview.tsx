/**
 * BalesHistoryOverview — extracted presentational sub-component (inventory
 * overview card + date stats strip). Read-only: no business writes.
 *
 * Extracted from BalesHistory.tsx during the god-file split.
 */
import { Boxes, Download, Package, PackageCheck, Shirt, Trash2, Weight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatLabelNum } from "@/lib/labelHtml";
import type { useBalesHistoryModel } from "../useBalesHistoryModel";

type Model = ReturnType<typeof useBalesHistoryModel>;

export function BalesHistoryOverview({ model }: { model: Model }) {
  const {
    setShowExportDialog,
    setDateFilter,
    totalWeight,
    totalBales,
    todayStr,
    summaryDate,
    regularQty,
    regularKg,
    garbageQty,
    garbageKg,
    wipersQty,
    wipersKg,
  } = model;

  return (
    <>
      {/* ── Inventory overview: counts still come directly from the existing model ── */}
      <div className="bales-modern-summary-card">
        <div className="bales-modern-heading">
          <div className="bales-modern-heading-icon">
            <Package className="h-5 w-5" aria-hidden="true" />
          </div>
          <div>
            <h1 className="text-lg font-bold leading-tight">Bales</h1>
            <p className="text-xs text-muted-foreground leading-tight">Stock history, status management and removal</p>
          </div>
        </div>
        <div className="bales-modern-actions">
          <div className="bales-modern-kpi">
            <span className="bales-modern-kpi-icon">
              <Boxes className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <Badge
                variant="secondary"
                data-testid="badge-total-bales"
                className="bales-modern-kpi-value border-0 bg-transparent px-0 py-0 text-foreground shadow-none"
              >
                {totalBales} bales
              </Badge>
              <div className="bales-modern-kpi-caption">Bales</div>
            </div>
          </div>
          <div className="bales-modern-kpi">
            <span className="bales-modern-kpi-icon weight">
              <Weight className="h-4 w-4" aria-hidden="true" />
            </span>
            <div>
              <Badge
                variant="outline"
                data-testid="badge-total-weight"
                className="bales-modern-kpi-value border-0 bg-transparent px-0 py-0 text-foreground shadow-none"
              >
                {formatLabelNum(totalWeight)} kg
              </Badge>
              <div className="bales-modern-kpi-caption">Total weight</div>
            </div>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="bales-modern-export"
            onClick={() => setShowExportDialog(true)}
            data-testid="button-export-stock-register"
          >
            <Download className="h-3.5 w-3.5 mr-1.5" />
            Export Register
          </Button>
        </div>
      </div>

      {/* ── Date stats strip ── */}
      <div className="bales-modern-date-strip">
        <Input
          type="date"
          value={summaryDate}
          onChange={(e) => setDateFilter(e.target.value || todayStr)}
          className="h-8 w-36 text-xs"
          data-testid="input-summary-date"
          aria-label="Bale summary date"
        />
        <div className="bales-modern-stat">
          <span className="bales-modern-stat-icon stock">
            <PackageCheck className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="bales-modern-stat-label">In Stock</span>
          <span className="bales-modern-stat-value" data-testid="text-today-qty">
            {regularQty}
          </span>
          <span className="bales-modern-stat-unit" data-testid="text-today-kg">
            {formatLabelNum(regularKg)} kg
          </span>
        </div>
        <div className="bales-modern-stat">
          <span className="bales-modern-stat-icon garbage">
            <Trash2 className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="bales-modern-stat-label">Garbage</span>
          <span className="bales-modern-stat-value" data-testid="text-today-garbage-qty">
            {garbageQty}
          </span>
          <span className="bales-modern-stat-unit" data-testid="text-today-garbage-kg">
            {formatLabelNum(garbageKg)} kg
          </span>
        </div>
        <div className="bales-modern-stat">
          <span className="bales-modern-stat-icon wipers">
            <Shirt className="h-4 w-4" aria-hidden="true" />
          </span>
          <span className="bales-modern-stat-label">Wipers</span>
          <span className="bales-modern-stat-value" data-testid="text-today-wipers-qty">
            {wipersQty}
          </span>
          <span className="bales-modern-stat-unit" data-testid="text-today-wipers-kg">
            {formatLabelNum(wipersKg)} kg
          </span>
        </div>
      </div>
    </>
  );
}

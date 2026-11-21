import { formatUsd } from "@/lib/moneyDisplay";
import { Package } from "lucide-react";
import { ErpListTable } from "@/erp-core";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProfitCell } from "./components/ProfitCell";
import { StatusBadge } from "./components/StatusBadge";
import { QuantityCell } from "./SupplierProfitCheckTableQuantity";
import type { ComputedRow } from "./types";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { ErpMobileRecordList } from "@/components/ui/erp-mobile-records";
import { AverageSellValue, DubaiPriceValue, ProfitCard, type ProfitModel } from "./SupplierProfitCheckTableParts";

export function SupplierProfitCheckTable({ model }: { model: ProfitModel }) {
  const isPhone = useErpPhoneLayout();
  if (!model.loaded) return null;
  const visibility = model.colVisibility;
  if (isPhone) {
    return (
      <ErpMobileRecordList
        isEmpty={model.filteredRows.length === 0}
        empty="No items match your filters"
        data-testid="profit-check-cards"
      >
        {model.filteredRows.map((row) => (
          <ProfitCard key={row.stockItemId} row={row} model={model} />
        ))}
      </ErpMobileRecordList>
    );
  }
  return (
    <div className="rounded-xl border overflow-hidden">
      <ErpListTable pageKey="supplier-profit-check" scrollLabel="Supplier profit check">
        <TableHeader className="sticky top-0 z-30">
          <TableRow className="bg-muted/60 border-b-2 hover:bg-muted/60">
            {visibility.code && <Header className="min-w-[90px]">Code</Header>}
            {visibility.name && <Header className="min-w-[200px]">Name</Header>}
            {visibility.salesQty && <Header className="text-right min-w-[80px]">Sales Qty</Header>}
            {visibility.avgSell && (
              <Header className="text-right min-w-[100px]">
                {model.sellPriceSource === "location_group" ? "Group Sell" : "Avg Sell"}
              </Header>
            )}
            {visibility.dubaiPrice && (
              <TableHead className="text-right min-w-[110px] text-[11px] font-bold uppercase tracking-wide">
                <span className="text-amber-500">Dubai Price</span>
                <div className="font-normal text-muted-foreground normal-case text-[11px]">PO rate</div>
              </TableHead>
            )}
            {visibility.extraPerBale && (
              <TableHead className="text-right min-w-[90px] text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                Extra / Bale<div className="font-normal normal-case text-[11px]">freight+duties</div>
              </TableHead>
            )}
            {visibility.landingCost && (
              <TableHead className="text-right min-w-[110px] text-[11px] font-bold uppercase tracking-wide">
                <span className="text-blue-500">Landing Cost</span>
                <div className="font-normal text-muted-foreground normal-case text-[11px]">Dubai + Extra</div>
              </TableHead>
            )}
            {visibility.costProfit && (
              <TableHead className="text-right min-w-[130px] text-[11px] font-bold uppercase tracking-wide">
                <span className="text-emerald-500">Cost Profit</span>
                <div className="font-normal text-muted-foreground normal-case text-[11px]">Sell − Landing</div>
              </TableHead>
            )}
            {visibility.status && <Header className="min-w-[100px]">Status</Header>}
            {visibility.qtyToOrder && <Header className="text-right min-w-[100px]">Qty to Order</Header>}
            {visibility.inventoryAvgCost && <Header className="text-right min-w-[130px]">Inv. Avg Cost</Header>}
            {visibility.hassanPrice && <Header className="text-right min-w-[110px]">Hassan Price</Header>}
            {visibility.hassanProfit && <Header className="text-right min-w-[120px]">Hassan Profit</Header>}
            {visibility.currentStock && <Header className="text-right min-w-[100px]">Stock</Header>}
          </TableRow>
        </TableHeader>
        <TableBody>
          {model.filteredRows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={model.visibleColCount} className="text-center py-16 text-muted-foreground">
                <Package className="w-8 h-8 mx-auto mb-2 opacity-30" />
                <p className="text-sm">No items match your filters</p>
              </TableCell>
            </TableRow>
          ) : (
            model.filteredRows.map((row, index) => (
              <ProfitRow key={row.stockItemId} row={row} index={index} model={model} />
            ))
          )}
        </TableBody>
      </ErpListTable>
    </div>
  );
}

function Header({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <TableHead className={`${className} text-[11px] font-bold uppercase tracking-wide text-muted-foreground`}>
      {children}
    </TableHead>
  );
}

function ProfitRow({ row, index, model }: { row: ComputedRow; index: number; model: ProfitModel }) {
  const visibility = model.colVisibility;
  const isLosing = row.computedStatus === "losing";
  const isNoData = row.computedStatus === "no_sales_data";
  const isNoGroupPrice = model.sellPriceSource === "location_group" && row.groupSellingPrice == null;
  const rowClass = [
    row.unresolved
      ? "border-l-2 border-l-amber-500 bg-amber-500/5"
      : isLosing
        ? "border-l-2 border-l-red-500 bg-red-500/5"
        : isNoGroupPrice
          ? "border-l-2 border-l-amber-400 bg-amber-500/5"
          : isNoData
            ? "bg-amber-500/3"
            : index % 2 === 1
              ? "bg-muted/20"
              : "",
    "hover:bg-muted/40 transition-colors",
  ].join(" ");

  return (
    <TableRow className={rowClass} data-testid={`row-item-${row.stockItemId}`}>
      {visibility.code && <TableCell className="font-mono text-xs text-muted-foreground py-2.5">{row.code}</TableCell>}
      {visibility.name && (
        <TableCell className="font-medium text-sm py-2.5">
          <div>{row.name}</div>
          {row.unresolved && <div className="text-[11px] text-amber-500 font-medium">Unresolved stock code</div>}
        </TableCell>
      )}
      {visibility.salesQty && (
        <TableCell className="text-right font-mono text-sm py-2.5">
          {row.salesQty > 0 ? (
            row.salesQty.toLocaleString("en-US")
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>
      )}
      {visibility.avgSell && <AverageSellCell row={row} model={model} />}
      {visibility.dubaiPrice && <DubaiPriceCell row={row} model={model} />}
      {visibility.extraPerBale && (
        <TableCell className="text-right text-sm py-2.5">
          {model.extraCostPerBale > 0 ? (
            <span className="font-mono text-amber-500">{formatUsd(model.extraCostPerBale, 2)}</span>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>
      )}
      {visibility.landingCost && (
        <TableCell className="text-right text-sm font-medium py-2.5 bg-blue-500/5">
          {row.landingCost != null ? (
            <span className="text-blue-600 dark:text-blue-400 tabular-nums">{formatUsd(row.landingCost, 2)}</span>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>
      )}
      {visibility.costProfit && (
        <TableCell className="py-2.5">
          <ProfitCell value={row.costProfit} pct={row.costProfitPct} />
        </TableCell>
      )}
      {visibility.status && (
        <TableCell className="py-2.5">
          {row.unresolved ? (
            <span className="inline-flex items-center rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
              Unresolved
            </span>
          ) : (
            <StatusBadge status={row.computedStatus} />
          )}
        </TableCell>
      )}
      {visibility.qtyToOrder && <QuantityCell row={row} model={model} />}
      {visibility.inventoryAvgCost && (
        <TableCell className="text-right text-sm font-mono text-muted-foreground py-2.5">
          {formatUsd(row.inventoryAvgCost, 2)}
        </TableCell>
      )}
      {visibility.hassanPrice && (
        <TableCell className="text-right text-sm font-mono py-2.5">
          {row.configPrice > 0 ? (
            formatUsd(row.configPrice, 2)
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>
      )}
      {visibility.hassanProfit && (
        <TableCell className="py-2.5">
          <ProfitCell
            value={row.hassanProfit}
            pct={row.configPrice > 0 ? (row.hassanProfit / row.configPrice) * 100 : null}
          />
        </TableCell>
      )}
      {visibility.currentStock && (
        <TableCell className="text-right text-sm font-mono text-muted-foreground py-2.5">
          {row.currentStock > 0 ? row.currentStock.toLocaleString() : <span className="text-xs">—</span>}
        </TableCell>
      )}
    </TableRow>
  );
}

function AverageSellCell({ row, model }: { row: ComputedRow; model: ProfitModel }) {
  return (
    <TableCell className="text-right text-sm font-medium py-2.5">
      <AverageSellValue row={row} model={model} />
    </TableCell>
  );
}

function DubaiPriceCell({ row, model }: { row: ComputedRow; model: ProfitModel }) {
  return (
    <TableCell className="text-right text-sm py-2.5 bg-amber-500/5">
      <DubaiPriceValue row={row} model={model} />
    </TableCell>
  );
}

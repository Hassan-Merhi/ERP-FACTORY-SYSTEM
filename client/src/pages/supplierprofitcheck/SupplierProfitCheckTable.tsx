import { Package } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ProfitCell } from "./components/ProfitCell";
import { StatusBadge } from "./components/StatusBadge";
import { fmt } from "./utils";
import type { ComputedRow } from "./types";
import type { useSupplierProfitCheckModel } from "./useSupplierProfitCheckModel";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import {
  ErpMobileRecordCard,
  ErpMobileRecordList,
  type ErpMobileRecordField,
} from "@/components/ui/erp-mobile-records";

type ProfitModel = ReturnType<typeof useSupplierProfitCheckModel>;

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
      <Table wrapperClassName="max-h-[calc(100vh-340px)]">
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
                <div className="font-normal text-muted-foreground normal-case text-[10px]">PO rate</div>
              </TableHead>
            )}
            {visibility.extraPerBale && (
              <TableHead className="text-right min-w-[90px] text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
                Extra / Bale<div className="font-normal normal-case text-[10px]">freight+duties</div>
              </TableHead>
            )}
            {visibility.landingCost && (
              <TableHead className="text-right min-w-[110px] text-[11px] font-bold uppercase tracking-wide">
                <span className="text-blue-500">Landing Cost</span>
                <div className="font-normal text-muted-foreground normal-case text-[10px]">Dubai + Extra</div>
              </TableHead>
            )}
            {visibility.costProfit && (
              <TableHead className="text-right min-w-[130px] text-[11px] font-bold uppercase tracking-wide">
                <span className="text-emerald-500">Cost Profit</span>
                <div className="font-normal text-muted-foreground normal-case text-[10px]">Sell − Landing</div>
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
      </Table>
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
          {row.unresolved && <div className="text-[10px] text-amber-500 font-medium">Unresolved stock code</div>}
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
            <span className="font-mono text-amber-500">${fmt(model.extraCostPerBale)}</span>
          ) : (
            <span className="text-muted-foreground text-xs">—</span>
          )}
        </TableCell>
      )}
      {visibility.landingCost && (
        <TableCell className="text-right text-sm font-medium py-2.5 bg-blue-500/5">
          {row.landingCost != null ? (
            <span className="text-blue-600 dark:text-blue-400 tabular-nums">${fmt(row.landingCost)}</span>
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
          ${fmt(row.inventoryAvgCost)}
        </TableCell>
      )}
      {visibility.hassanPrice && (
        <TableCell className="text-right text-sm font-mono py-2.5">
          {row.configPrice > 0 ? `$${fmt(row.configPrice)}` : <span className="text-muted-foreground text-xs">—</span>}
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

/** Selling price: the location-group price, or the average sell price with a manual override input. */
function AverageSellValue({ row, model }: { row: ComputedRow; model: ProfitModel }) {
  if (row.unresolved) {
    return <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">Link item first</span>;
  }
  if (model.sellPriceSource === "location_group") {
    return (
      <div className="text-right">
        {row.groupSellingPrice != null ? (
          <span className="font-mono text-sm">${fmt(row.groupSellingPrice)}</span>
        ) : (
          <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">No Price</span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      <Input
        type="number"
        min="0"
        step="0.01"
        placeholder={row.avgSellingPrice != null ? fmt(row.avgSellingPrice) : "—"}
        value={model.manualAvgPrices[row.stockItemId] ?? ""}
        onChange={(event) => model.handleManualAvgChange(row.stockItemId, event.target.value)}
        onKeyDown={(event) => model.handleArrowNav(event, "data-avg-input")}
        className="h-7 w-20 text-right text-xs px-1.5 font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        data-testid={`input-manual-avg-price-${row.stockItemId}`}
        data-avg-input="true"
      />
      {model.manualAvgPrices[row.stockItemId] && row.avgSellingPrice != null && (
        <span className="text-[10px] text-muted-foreground leading-tight">auto ${fmt(row.avgSellingPrice)}</span>
      )}
    </div>
  );
}

function DubaiPriceCell({ row, model }: { row: ComputedRow; model: ProfitModel }) {
  return (
    <TableCell className="text-right text-sm py-2.5 bg-amber-500/5">
      <DubaiPriceValue row={row} model={model} />
    </TableCell>
  );
}

/** Dubai (PO) price with its manual override input; unresolved rows show the proforma price. */
function DubaiPriceValue({ row, model }: { row: ComputedRow; model: ProfitModel }) {
  if (row.unresolved) {
    return row.poPrice != null ? (
      <div className="flex flex-col items-end gap-0.5">
        <span className="font-mono text-sm text-amber-600 dark:text-amber-400">${fmt(row.poPrice)}</span>
        <span className="text-[10px] text-muted-foreground leading-tight">proforma price</span>
      </div>
    ) : (
      <span className="text-muted-foreground text-xs">—</span>
    );
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex items-center justify-end gap-1">
        <span className="text-muted-foreground text-xs">$</span>
        <Input
          type="number"
          min="0"
          step="0.01"
          placeholder={row.poPrice != null ? fmt(row.poPrice) : "—"}
          value={model.manualPoPrices[row.stockItemId] ?? ""}
          onChange={(event) => model.handleManualPoChange(row.stockItemId, event.target.value)}
          onKeyDown={(event) => model.handleArrowNav(event, "data-po-input")}
          className="h-7 w-20 text-right text-xs px-1.5 font-mono border-amber-300 dark:border-amber-700 focus-visible:ring-amber-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          data-testid={`input-manual-po-price-${row.stockItemId}`}
          data-po-input="true"
        />
      </div>
      {model.manualPoPrices[row.stockItemId] && row.poPrice != null && (
        <span className="text-[10px] text-muted-foreground leading-tight">auto ${fmt(row.poPrice)}</span>
      )}
      {!model.manualPoPrices[row.stockItemId] && row.poPriceSource === "any_po_fallback" && (
        <span className="text-[10px] text-amber-500/80 leading-tight">any supplier</span>
      )}
    </div>
  );
}

function QuantityCell({ row, model }: { row: ComputedRow; model: ProfitModel }) {
  return (
    <TableCell className="py-2.5">
      <QuantityInput row={row} model={model} className="w-24 h-7 text-right ml-auto font-mono" />
    </TableCell>
  );
}

function QuantityInput({ row, model, className }: { row: ComputedRow; model: ProfitModel; className: string }) {
  return (
    <Input
      type="number"
      min="0"
      step="1"
      placeholder="0"
      value={model.qtyMap[row.stockItemId] ?? ""}
      onChange={(event) => {
        model.setQtyMap((previous) => ({ ...previous, [row.stockItemId]: event.target.value }));
        model.setQtyVersion((version) => version + 1);
      }}
      onKeyDown={(event) => model.handleArrowNav(event, "data-qty-input")}
      className={`${className} [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none`}
      data-testid={`input-qty-${row.stockItemId}`}
      data-qty-input="true"
    />
  );
}

/**
 * Phone card for one item: selling price, Dubai price, landing cost, profit and status up front,
 * the secondary figures (extra/bale, inventory cost, Hassan price/profit, stock, sales, quantity
 * to order) behind "More details". Inputs are the same controlled fields as the table.
 */
function ProfitCard({ row, model }: { row: ComputedRow; model: ProfitModel }) {
  const visibility = model.colVisibility;
  const isLosing = row.computedStatus === "losing";
  const fields: ErpMobileRecordField[] = [];
  const details: ErpMobileRecordField[] = [];
  if (visibility.avgSell)
    fields.push({
      label: model.sellPriceSource === "location_group" ? "Group Sell" : "Selling Price",
      value: <AverageSellValue row={row} model={model} />,
      className: "[&_input]:h-10 [&_input]:w-full [&_input]:text-sm [&>dd>div]:items-stretch",
    });
  if (visibility.dubaiPrice)
    fields.push({
      label: "Dubai Price",
      value: <DubaiPriceValue row={row} model={model} />,
      className: "[&_input]:h-10 [&_input]:w-full [&_input]:text-sm [&>dd>div]:items-stretch",
    });
  if (visibility.landingCost)
    fields.push({
      label: "Landing Cost",
      value:
        row.landingCost != null ? (
          <span className="text-blue-600 dark:text-blue-400 tabular-nums">${fmt(row.landingCost)}</span>
        ) : (
          "—"
        ),
      numeric: true,
    });
  if (visibility.costProfit)
    fields.push({ label: "Cost Profit", value: <ProfitCell value={row.costProfit} pct={row.costProfitPct} /> });

  if (visibility.extraPerBale)
    details.push({
      label: "Extra / Bale",
      value: model.extraCostPerBale > 0 ? `$${fmt(model.extraCostPerBale)}` : "—",
      numeric: true,
    });
  if (visibility.inventoryAvgCost)
    details.push({ label: "Inv. Avg Cost", value: `$${fmt(row.inventoryAvgCost)}`, numeric: true });
  if (visibility.hassanPrice)
    details.push({
      label: "Hassan Price",
      value: row.configPrice > 0 ? `$${fmt(row.configPrice)}` : "—",
      numeric: true,
    });
  if (visibility.hassanProfit)
    details.push({
      label: "Hassan Profit",
      value: (
        <ProfitCell
          value={row.hassanProfit}
          pct={row.configPrice > 0 ? (row.hassanProfit / row.configPrice) * 100 : null}
        />
      ),
    });
  if (visibility.currentStock)
    details.push({
      label: "Stock",
      value: row.currentStock > 0 ? row.currentStock.toLocaleString() : "—",
      numeric: true,
    });
  if (visibility.salesQty)
    details.push({
      label: "Sales Qty",
      value: row.salesQty > 0 ? row.salesQty.toLocaleString("en-US") : "—",
      numeric: true,
    });

  return (
    <ErpMobileRecordCard
      data-testid={`row-item-${row.stockItemId}`}
      className={
        row.unresolved ? "border-s-4 border-s-amber-500" : isLosing ? "border-s-4 border-s-red-500" : undefined
      }
      title={visibility.name ? row.name : row.code}
      subtitle={
        <>
          {visibility.code && <span className="font-mono">{row.code}</span>}
          {row.unresolved && <span className="ms-1 text-amber-600">Unresolved stock code</span>}
        </>
      }
      badges={
        visibility.status &&
        (row.unresolved ? (
          <span className="inline-flex items-center rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400">
            Unresolved
          </span>
        ) : (
          <StatusBadge status={row.computedStatus} />
        ))
      }
      fields={fields}
      details={details}
    >
      {visibility.qtyToOrder && (
        <label className="flex items-center justify-between gap-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Qty to Order
          <QuantityInput row={row} model={model} className="h-10 w-28 text-right font-mono text-sm" />
        </label>
      )}
    </ErpMobileRecordCard>
  );
}

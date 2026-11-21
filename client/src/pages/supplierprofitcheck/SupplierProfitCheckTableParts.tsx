// Extracted from ./SupplierProfitCheckTable.tsx
import { useEffect, useRef, useState } from "react";
import { formatUsd } from "@/lib/moneyDisplay";
import { Input } from "@/components/ui/input";
import { ProfitCell } from "./components/ProfitCell";
import { StatusBadge } from "./components/StatusBadge";
import { fmt } from "./utils";
import { QuantityInput } from "./SupplierProfitCheckTableQuantity";
import type { ComputedRow } from "./types";
import type { useSupplierProfitCheckModel } from "./useSupplierProfitCheckModel";
import { ErpMobileRecordCard, type ErpMobileRecordField } from "@/components/ui/erp-mobile-records";

export type ProfitModel = ReturnType<typeof useSupplierProfitCheckModel>;

/**
 * Keep the typed price local until editing finishes. Profit Check filters on
 * calculated status, so applying the first digit immediately can remove the
 * entire row from the "No Data" view before the user finishes typing.
 * Blur (including Arrow navigation and Enter) commits the complete value.
 */
function CommittedPriceInput({
  value,
  onCommit,
  model,
  navigationAttr,
  placeholder,
  className,
  testId,
}: {
  value: string;
  onCommit: (value: string) => void;
  model: ProfitModel;
  navigationAttr: "data-avg-input" | "data-po-input";
  placeholder: string;
  className: string;
  testId: string;
}) {
  const [draft, setDraft] = useState(value);
  const isEditing = useRef(false);

  useEffect(() => {
    if (!isEditing.current) setDraft(value);
  }, [value]);

  return (
    <Input
      type="number"
      min="0"
      step="0.01"
      placeholder={placeholder}
      value={draft}
      onFocus={() => {
        isEditing.current = true;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        isEditing.current = false;
        if (draft !== value) onCommit(draft);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          event.currentTarget.blur();
        } else {
          model.handleArrowNav(event, navigationAttr);
        }
      }}
      className={className}
      data-testid={testId}
      {...{ [navigationAttr]: "true" }}
    />
  );
}

/** Selling price: the location-group price, or the average sell price with a manual override input. */
export function AverageSellValue({ row, model }: { row: ComputedRow; model: ProfitModel }) {
  if (row.unresolved) {
    return <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">Link item first</span>;
  }
  if (model.sellPriceSource === "location_group") {
    return (
      <div className="text-right">
        {row.groupSellingPrice != null ? (
          <span className="font-mono text-sm">{formatUsd(row.groupSellingPrice, 2)}</span>
        ) : (
          <span className="text-[11px] text-amber-600 dark:text-amber-400 font-medium">No Price</span>
        )}
      </div>
    );
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      <CommittedPriceInput
        value={model.manualAvgPrices[row.stockItemId] ?? ""}
        onCommit={(value) => model.handleManualAvgChange(row.stockItemId, value)}
        model={model}
        navigationAttr="data-avg-input"
        placeholder={row.avgSellingPrice != null ? fmt(row.avgSellingPrice) : "—"}
        className="h-7 w-20 text-right text-xs px-1.5 font-mono [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
        testId={`input-manual-avg-price-${row.stockItemId}`}
      />
      {model.manualAvgPrices[row.stockItemId] && row.avgSellingPrice != null && (
        <span className="text-[11px] text-muted-foreground leading-tight">
          auto {formatUsd(row.avgSellingPrice, 2)}
        </span>
      )}
    </div>
  );
}

/** Dubai (PO) price with its manual override input; unresolved rows show the proforma price. */
export function DubaiPriceValue({ row, model }: { row: ComputedRow; model: ProfitModel }) {
  if (row.unresolved) {
    return row.poPrice != null ? (
      <div className="flex flex-col items-end gap-0.5">
        <span className="font-mono text-sm text-amber-600 dark:text-amber-400">{formatUsd(row.poPrice, 2)}</span>
        <span className="text-[11px] text-muted-foreground leading-tight">proforma price</span>
      </div>
    ) : (
      <span className="text-muted-foreground text-xs">—</span>
    );
  }
  return (
    <div className="flex flex-col items-end gap-0.5">
      <div className="flex items-center justify-end gap-1">
        <span className="text-muted-foreground text-xs">$</span>
        <CommittedPriceInput
          value={model.manualPoPrices[row.stockItemId] ?? ""}
          onCommit={(value) => model.handleManualPoChange(row.stockItemId, value)}
          model={model}
          navigationAttr="data-po-input"
          placeholder={row.poPrice != null ? fmt(row.poPrice) : "—"}
          className="h-7 w-20 text-right text-xs px-1.5 font-mono border-amber-300 dark:border-amber-700 focus-visible:ring-amber-400 [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          testId={`input-manual-po-price-${row.stockItemId}`}
        />
      </div>
      {model.manualPoPrices[row.stockItemId] && row.poPrice != null && (
        <span className="text-[11px] text-muted-foreground leading-tight">auto {formatUsd(row.poPrice, 2)}</span>
      )}
      {!model.manualPoPrices[row.stockItemId] && row.poPriceSource === "any_po_fallback" && (
        <span className="text-[11px] text-amber-500/80 leading-tight">any supplier</span>
      )}
    </div>
  );
}

/**
 * Phone card for one item: selling price, Dubai price, landing cost, profit and status up front,
 * the secondary figures (extra/bale, inventory cost, Hassan price/profit, stock, sales, quantity
 * to order) behind "More details". Inputs are the same controlled fields as the table.
 */
export function ProfitCard({ row, model }: { row: ComputedRow; model: ProfitModel }) {
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
          <span className="text-blue-600 dark:text-blue-400 tabular-nums">{formatUsd(row.landingCost, 2)}</span>
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
      value: model.extraCostPerBale > 0 ? formatUsd(model.extraCostPerBale, 2) : "—",
      numeric: true,
    });
  if (visibility.inventoryAvgCost)
    details.push({
      label: "Inv. Avg Cost",
      value: formatUsd(row.inventoryAvgCost, 2),
      numeric: true,
    });
  if (visibility.hassanPrice)
    details.push({
      label: "Hassan Price",
      value: row.configPrice > 0 ? formatUsd(row.configPrice, 2) : "—",
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

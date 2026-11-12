/**
 * InventoryTableColumns — extracted presentational sub-component rendering the
 * shared <colgroup> and <thead> for the regular and "Wipers & Garbage" stock
 * tables. Read-only: no business writes.
 *
 * Extracted from FactoryLocationInventoryProductView.tsx during the god-file split.
 */

export function InventoryTableColumns({
  proformaMode,
  hideSellingPrice,
  col,
}: {
  proformaMode: boolean;
  hideSellingPrice: boolean;
  col: (key: string) => boolean;
}) {
  return (
    <>
      <colgroup>
        {proformaMode && <col style={{ width: "36px" }} />}
        <col style={{ minWidth: "200px" }} />
        {col("category") && <col style={{ width: "110px" }} />}
        <col style={{ width: "70px" }} />
        {proformaMode && <col style={{ width: "80px" }} />}
        {proformaMode && <col style={{ width: "110px" }} />}
        {col("avg_kg") && <col style={{ width: "110px" }} />}
        {!hideSellingPrice && col("sell_price") && <col style={{ width: "110px" }} />}
        {!hideSellingPrice && col("sell_value") && <col style={{ width: "130px" }} />}
        {!hideSellingPrice && col("cost_price") && <col style={{ width: "110px" }} />}
        {!hideSellingPrice && col("cost_value") && <col style={{ width: "130px" }} />}
        {col("total_kg") && <col style={{ width: "100px" }} />}
        {!proformaMode && col("actions") && <col style={{ width: "100px" }} />}
      </colgroup>
      <thead className="inventory-table-head bg-muted border-b-2 border-border/60 sticky top-0 z-30">
        <tr className="h-10">
          {proformaMode && <th className="px-2"></th>}
          <th className="text-left px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
            Product
          </th>
          {col("category") && (
            <th className="text-left px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Category
            </th>
          )}
          <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
            {proformaMode ? "Available" : "Bales"}
          </th>
          {proformaMode && (
            <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">Qty</th>
          )}
          {proformaMode && (
            <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
              Price/Bale
            </th>
          )}
          {col("avg_kg") && (
            <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
              Avg KG/Bale
            </th>
          )}
          {!hideSellingPrice && col("sell_price") && (
            <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
              Sell Price
            </th>
          )}
          {!hideSellingPrice && col("sell_value") && (
            <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
              Sell Value
            </th>
          )}
          {!hideSellingPrice && col("cost_price") && (
            <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
              Cost Price
            </th>
          )}
          {!hideSellingPrice && col("cost_value") && (
            <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
              Cost Value
            </th>
          )}
          {col("total_kg") && (
            <th className="text-right px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide whitespace-nowrap">
              Total KG
            </th>
          )}
          {!proformaMode && col("actions") && (
            <th className="text-center px-3 text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Actions
            </th>
          )}
        </tr>
      </thead>
    </>
  );
}

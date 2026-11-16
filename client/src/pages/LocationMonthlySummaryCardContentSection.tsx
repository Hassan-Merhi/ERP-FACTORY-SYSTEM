// Extracted from ./LocationMonthlySummary.tsx to keep that module under the source-size cap.
import { CardContent } from "@/components/ui/card";
import { hasActivity, useLocationMonthlySummaryState } from "./useLocationMonthlySummaryState";

export function LocationMonthlySummaryCardContentSection({
  data,
  fmtQty,
  fmtRate,
  fmtVal,
  handleMonthClick,
  isAllLocationsMode,
  mobileCards,
  periodFilter,
  posUser,
  selectedRowIndex,
  setDetailDirection,
  setDetailMonth,
  setDetailMonthName,
  setDetailOpen,
  setDetailYear,
  tableScrollContainer,
  visibleRows,
}: Pick<
  ReturnType<typeof useLocationMonthlySummaryState>,
  | "data"
  | "fmtQty"
  | "fmtRate"
  | "fmtVal"
  | "handleMonthClick"
  | "isAllLocationsMode"
  | "mobileCards"
  | "periodFilter"
  | "posUser"
  | "selectedRowIndex"
  | "setDetailDirection"
  | "setDetailMonth"
  | "setDetailMonthName"
  | "setDetailOpen"
  | "setDetailYear"
  | "tableScrollContainer"
  | "visibleRows"
>) {
  return (
    <CardContent className="overflow-auto flex-1 p-0" ref={tableScrollContainer}>
      <table {...mobileCards.tableProps} className="w-full text-sm border-collapse" style={{ minWidth: "900px" }}>
        <thead className="sticky top-0 z-30">
          <tr className="bg-muted border-b">
            <th rowSpan={2} className="text-left align-bottom px-3 py-2 border-r font-semibold w-28">
              Month
            </th>
            <th
              colSpan={posUser ? 1 : 3}
              className="text-center px-2 py-1.5 border-r font-semibold text-muted-foreground"
            >
              Opening
            </th>
            <th
              colSpan={posUser ? 1 : 3}
              className="text-center px-2 py-1.5 border-r font-semibold text-green-700 dark:text-green-400"
            >
              Stock In
            </th>
            <th
              colSpan={posUser ? 1 : 3}
              className="text-center px-2 py-1.5 border-r font-semibold text-red-700 dark:text-red-400"
            >
              Stock Out
            </th>
            <th colSpan={posUser ? 1 : 3} className="text-center px-2 py-1.5 font-semibold text-primary">
              Closing
            </th>
          </tr>
          <tr className="bg-muted/70 border-b text-xs">
            <th className="text-right px-3 py-1.5 font-medium text-muted-foreground border-r">Qty</th>
            {!posUser && (
              <>
                <th className="text-right px-3 py-1.5 font-medium text-muted-foreground border-r">Rate</th>
                <th className="text-right px-3 py-1.5 font-medium text-muted-foreground border-r">Value</th>
              </>
            )}
            <th className="text-right px-3 py-1.5 font-medium border-r text-green-700 dark:text-green-400">Qty</th>
            {!posUser && (
              <>
                <th className="text-right px-3 py-1.5 font-medium border-r text-green-700 dark:text-green-400">Rate</th>
                <th className="text-right px-3 py-1.5 font-medium border-r text-green-700 dark:text-green-400">
                  Value
                </th>
              </>
            )}
            <th className="text-right px-3 py-1.5 font-medium border-r text-red-700 dark:text-red-400">Qty</th>
            {!posUser && (
              <>
                <th className="text-right px-3 py-1.5 font-medium border-r text-red-700 dark:text-red-400">Rate</th>
                <th className="text-right px-3 py-1.5 font-medium border-r text-red-700 dark:text-red-400">Value</th>
              </>
            )}
            <th className="text-right px-3 py-1.5 font-medium text-primary">Qty</th>
            {!posUser && (
              <>
                <th className="text-right px-3 py-1.5 font-medium text-primary">Rate</th>
                <th className="text-right px-3 py-1.5 font-medium text-primary">Value</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {visibleRows.length === 0 && (
            <tr>
              <td colSpan={posUser ? 5 : 13} className="text-center py-12 text-muted-foreground">
                No stock movement for this period
              </td>
            </tr>
          )}
          {visibleRows.map((month, idx) => {
            const isSelected = selectedRowIndex === idx;
            const isClickable = !isAllLocationsMode;
            const isActive = hasActivity(month);

            return (
              <tr
                key={month.month}
                className={`border-b transition-colors ${isClickable ? "cursor-pointer" : ""} ${isSelected ? "bg-primary/10 ring-1 ring-inset ring-primary" : isActive && isClickable ? "hover:bg-muted/40" : "text-muted-foreground/60"}`}
                onClick={() => isClickable && isActive && handleMonthClick(month.month)}
                data-testid={`row-month-${month.month}`}
                data-row-index={idx}
              >
                <td className="font-medium px-3 py-2.5 border-r">{month.monthName}</td>

                {/* Opening */}
                <td className="text-right px-3 py-2.5 tabular-nums border-r text-muted-foreground">
                  {fmtQty(month.openingQty)}
                </td>
                {!posUser && (
                  <>
                    <td className="text-right px-3 py-2.5 tabular-nums border-r text-muted-foreground">
                      {fmtRate(month.openingRate)}
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums border-r text-muted-foreground">
                      {fmtVal(month.openingValue)}
                    </td>
                  </>
                )}

                {/* Stock In */}
                <td className="text-right px-3 py-2.5 tabular-nums border-r text-green-700 dark:text-green-400 font-medium">
                  {!isAllLocationsMode && month.inwardQty > 0 ? (
                    <button
                      className="underline decoration-dotted underline-offset-2 cursor-pointer hover:opacity-70 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        const y = new Date(periodFilter.fromDate).getFullYear();
                        setDetailYear(y);
                        setDetailMonth(month.month);
                        setDetailMonthName(month.monthName);
                        setDetailDirection("in");
                        setDetailOpen(true);
                      }}
                    >
                      {fmtQty(month.inwardQty)}
                    </button>
                  ) : (
                    fmtQty(month.inwardQty)
                  )}
                </td>
                {!posUser && (
                  <>
                    <td className="text-right px-3 py-2.5 tabular-nums border-r text-green-700 dark:text-green-400">
                      {fmtRate(month.inwardRate)}
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums border-r text-green-700 dark:text-green-400">
                      {fmtVal(month.inwardValue)}
                    </td>
                  </>
                )}

                {/* Stock Out */}
                <td className="text-right px-3 py-2.5 tabular-nums border-r text-red-700 dark:text-red-400 font-medium">
                  {!isAllLocationsMode && month.outwardQty > 0 ? (
                    <button
                      className="underline decoration-dotted underline-offset-2 cursor-pointer hover:opacity-70 transition-opacity"
                      onClick={(e) => {
                        e.stopPropagation();
                        const y = new Date(periodFilter.fromDate).getFullYear();
                        setDetailYear(y);
                        setDetailMonth(month.month);
                        setDetailMonthName(month.monthName);
                        setDetailDirection("out");
                        setDetailOpen(true);
                      }}
                    >
                      {fmtQty(month.outwardQty)}
                    </button>
                  ) : (
                    fmtQty(month.outwardQty)
                  )}
                </td>
                {!posUser && (
                  <>
                    <td className="text-right px-3 py-2.5 tabular-nums border-r text-red-700 dark:text-red-400">
                      {fmtRate(month.outwardRate)}
                    </td>
                    <td className="text-right px-3 py-2.5 tabular-nums border-r text-red-700 dark:text-red-400">
                      {fmtVal(month.outwardValue)}
                    </td>
                  </>
                )}

                {/* Closing */}
                <td className="text-right px-3 py-2.5 tabular-nums font-semibold text-foreground">
                  {fmtQty(month.closingQty)}
                </td>
                {!posUser && (
                  <>
                    <td className="text-right px-3 py-2.5 tabular-nums font-medium">{fmtRate(month.closingRate)}</td>
                    <td className="text-right px-3 py-2.5 tabular-nums font-medium">{fmtVal(month.closingValue)}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>

        {/* Grand Total */}
        {data?.grandTotal && (
          <tfoot className="sticky bottom-0 z-10">
            <tr className="bg-muted font-bold border-t-2">
              <td className="px-3 py-2.5 border-r">Total</td>

              {/* Opening total */}
              <td className="text-right px-3 py-2.5 tabular-nums border-r text-muted-foreground">
                {fmtQty(data.grandTotal.openingQty)}
              </td>
              {!posUser && (
                <>
                  <td className="text-right px-3 py-2.5 tabular-nums border-r text-muted-foreground">
                    {fmtRate(data.grandTotal.openingRate)}
                  </td>
                  <td className="text-right px-3 py-2.5 tabular-nums border-r text-muted-foreground">
                    {fmtVal(data.grandTotal.openingValue)}
                  </td>
                </>
              )}

              {/* In total */}
              <td className="text-right px-3 py-2.5 tabular-nums border-r text-green-700 dark:text-green-400">
                {fmtQty(data.grandTotal.inwardQty)}
              </td>
              {!posUser && (
                <>
                  <td className="text-right px-3 py-2.5 tabular-nums border-r text-green-700 dark:text-green-400">
                    {fmtRate(data.grandTotal.inwardRate)}
                  </td>
                  <td className="text-right px-3 py-2.5 tabular-nums border-r text-green-700 dark:text-green-400">
                    {fmtVal(data.grandTotal.inwardValue)}
                  </td>
                </>
              )}

              {/* Out total */}
              <td className="text-right px-3 py-2.5 tabular-nums border-r text-red-700 dark:text-red-400">
                {fmtQty(data.grandTotal.outwardQty)}
              </td>
              {!posUser && (
                <>
                  <td className="text-right px-3 py-2.5 tabular-nums border-r text-red-700 dark:text-red-400">
                    {fmtRate(data.grandTotal.outwardRate)}
                  </td>
                  <td className="text-right px-3 py-2.5 tabular-nums border-r text-red-700 dark:text-red-400">
                    {fmtVal(data.grandTotal.outwardValue)}
                  </td>
                </>
              )}

              {/* Closing total */}
              <td className="text-right px-3 py-2.5 tabular-nums text-foreground">
                {fmtQty(data.grandTotal.closingQty)}
              </td>
              {!posUser && (
                <>
                  <td className="text-right px-3 py-2.5 tabular-nums">{fmtRate(data.grandTotal.closingRate)}</td>
                  <td className="text-right px-3 py-2.5 tabular-nums">{fmtVal(data.grandTotal.closingValue)}</td>
                </>
              )}
            </tr>
          </tfoot>
        )}
      </table>
    </CardContent>
  );
}

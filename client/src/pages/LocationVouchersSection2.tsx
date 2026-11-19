// Extracted from ./LocationVouchers.tsx to keep that module under the source-size cap.
import { ArrowDownToLine, ArrowUpFromLine, Layers } from "lucide-react";
import { useLocationVouchersState } from "./useLocationVouchersState";

export function LocationVouchersSection({
  calculatedTotals,
  formatAmount,
  formatNumber,
  posUser,
}: Pick<
  ReturnType<typeof useLocationVouchersState>,
  "calculatedTotals" | "formatAmount" | "formatNumber" | "posUser"
>) {
  return (
    <tr className="bg-muted font-bold border-t-2">
      <td colSpan={3} className="px-4 py-2.5 border-r text-sm">
        Totals
      </td>
      <td className="text-right px-2 py-2.5 tabular-nums border-r text-emerald-700 dark:text-emerald-400">
        {formatNumber(calculatedTotals.inwardQty, 0)}
      </td>
      {!posUser && (
        <td className="text-right px-2 py-2.5 tabular-nums text-muted-foreground">
          {formatAmount(calculatedTotals.inwardRate)}
        </td>
      )}
      {!posUser && (
        <td className="text-right px-2 py-2.5 tabular-nums border-r text-muted-foreground">
          {formatAmount(calculatedTotals.inwardValue)}
        </td>
      )}
      <td className="text-right px-2 py-2.5 tabular-nums border-r text-rose-700 dark:text-rose-400">
        {formatNumber(calculatedTotals.outwardQty, 0)}
      </td>
      {!posUser && (
        <td className="text-right px-2 py-2.5 tabular-nums text-muted-foreground">
          {formatAmount(calculatedTotals.outwardRate)}
        </td>
      )}
      {!posUser && (
        <td className="text-right px-2 py-2.5 tabular-nums border-r text-muted-foreground">
          {formatAmount(calculatedTotals.outwardValue)}
        </td>
      )}
      <td className="text-right px-2 py-2.5 tabular-nums text-foreground">
        {formatNumber(calculatedTotals.closingQty, 0)}
      </td>
      {!posUser && (
        <td className="text-right px-2 py-2.5 tabular-nums text-muted-foreground">
          {formatAmount(calculatedTotals.closingRate)}
        </td>
      )}
      {!posUser && (
        <td className="text-right px-2 py-2.5 tabular-nums text-primary">
          {formatAmount(calculatedTotals.closingValue)}
        </td>
      )}
    </tr>
  );
}

export function LocationVouchersSection2({ posUser }: Pick<ReturnType<typeof useLocationVouchersState>, "posUser">) {
  return (
    <thead className="sticky top-0 z-30">
      <tr className="bg-muted border-b">
        <th rowSpan={2} className="text-left align-bottom px-4 py-2 border-r bg-muted font-medium w-[100px]">
          Date
        </th>
        <th rowSpan={2} className="text-left align-bottom px-4 py-2 border-r bg-muted font-medium">
          Particulars
        </th>
        <th rowSpan={2} className="text-left align-bottom px-4 py-2 border-r bg-muted font-medium w-[110px]">
          Vch Type
        </th>
        <th
          colSpan={posUser ? 1 : 3}
          className="text-center px-3 py-1.5 border-r font-semibold text-emerald-700 dark:text-emerald-400 bg-emerald-50 dark:bg-emerald-950/30 border-t-2 border-t-emerald-500"
        >
          <span className="flex items-center justify-center gap-1">
            <ArrowDownToLine className="h-3.5 w-3.5" />
            Inwards
          </span>
        </th>
        <th
          colSpan={posUser ? 1 : 3}
          className="text-center px-3 py-1.5 border-r font-semibold text-rose-700 dark:text-rose-400 bg-rose-50 dark:bg-rose-950/30 border-t-2 border-t-rose-500"
        >
          <span className="flex items-center justify-center gap-1">
            <ArrowUpFromLine className="h-3.5 w-3.5" />
            Outwards
          </span>
        </th>
        <th
          colSpan={posUser ? 1 : 3}
          className="text-center px-3 py-1.5 font-semibold text-primary bg-primary/5 border-t-2 border-t-primary"
        >
          <span className="flex items-center justify-center gap-1">
            <Layers className="h-3.5 w-3.5" />
            Closing
          </span>
        </th>
      </tr>
      <tr className="border-b text-xs">
        <th className="text-right px-2 py-1.5 font-medium border-r bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 w-[55px]">
          Qty
        </th>
        {!posUser && (
          <th className="text-right px-2 py-1.5 font-medium bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 w-[60px]">
            Rate
          </th>
        )}
        {!posUser && (
          <th className="text-right px-2 py-1.5 border-r font-medium bg-emerald-50 dark:bg-emerald-950/20 text-emerald-700 dark:text-emerald-400 w-[75px]">
            Value
          </th>
        )}
        <th className="text-right px-2 py-1.5 font-medium border-r bg-rose-50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-400 w-[55px]">
          Qty
        </th>
        {!posUser && (
          <th className="text-right px-2 py-1.5 font-medium bg-rose-50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-400 w-[60px]">
            Rate
          </th>
        )}
        {!posUser && (
          <th className="text-right px-2 py-1.5 border-r font-medium bg-rose-50 dark:bg-rose-950/20 text-rose-700 dark:text-rose-400 w-[75px]">
            Value
          </th>
        )}
        <th className="text-right px-2 py-1.5 font-medium bg-primary/5 text-primary w-[55px]">Qty</th>
        {!posUser && <th className="text-right px-2 py-1.5 font-medium bg-primary/5 text-primary w-[60px]">Rate</th>}
        {!posUser && <th className="text-right px-2 py-1.5 font-medium bg-primary/5 text-primary w-[75px]">Value</th>}
      </tr>
    </thead>
  );
}

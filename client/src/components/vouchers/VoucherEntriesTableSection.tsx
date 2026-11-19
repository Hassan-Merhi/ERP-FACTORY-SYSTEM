// Extracted from ./VoucherEntriesTable.tsx to keep that module under the source-size cap.
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormControl, FormField, FormItem, FormMessage } from "@/components/ui/form";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { ENTRY_TYPE_BADGE } from "./VoucherEntriesTableTypes";
import { useVoucherEntriesTableState } from "./useVoucherEntriesTableState";

export function VoucherEntriesTableSection({
  activeRow,
  amountCurrencyOverride,
  entries,
  fields,
  form,
  formatEntryAmount,
  handleAccountKeyDown,
  handleAddRow,
  handleAmountBlur,
  handleAmountKeyDown,
  hasAnyAmount,
  mode,
  onRowBlur,
  onRowFocus,
  remove,
  renderBalanceLine,
  runningTotals,
  setSidebarSearchValue,
  total,
}: Pick<
  ReturnType<typeof useVoucherEntriesTableState>,
  | "activeRow"
  | "amountCurrencyOverride"
  | "entries"
  | "fields"
  | "form"
  | "formatEntryAmount"
  | "handleAccountKeyDown"
  | "handleAddRow"
  | "handleAmountBlur"
  | "handleAmountKeyDown"
  | "hasAnyAmount"
  | "mode"
  | "onRowBlur"
  | "onRowFocus"
  | "remove"
  | "renderBalanceLine"
  | "runningTotals"
  | "setSidebarSearchValue"
  | "total"
>) {
  return (
    <div className="voucher-entries-table hidden sm:block border rounded-md overflow-x-auto">
      <table className="w-full">
        {/* Below the form's sticky save footer (z-20), which it otherwise paints over on short screens. */}
        <thead className="bg-muted sticky top-0 z-10">
          <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
            <th className="text-center px-2 py-2 font-semibold w-8">#</th>
            <th className="text-left px-2 py-2 font-semibold min-w-[10rem]">Account</th>
            <th className="text-left px-2 py-2 font-semibold w-24 hidden lg:table-cell">Type</th>
            <th className="text-right px-2 py-2 font-semibold w-[22%] min-w-[6.5rem]">
              {amountCurrencyOverride === "EUR" ? "Amount (EUR)" : "Amount"}
            </th>
            <th className="text-left px-2 py-2 font-semibold w-[24%] hidden md:table-cell">Narration</th>
            <th className="text-right px-2 py-2 font-semibold w-28 hidden lg:table-cell">Running</th>
            <th className="w-10"></th>
          </tr>
        </thead>
        <tbody>
          {fields.map((field, index) => {
            const entry = entries[index];
            const isEmpty = !entry?.accountId || entry.accountId === 0;
            const typeBadge = entry?.accountType ? ENTRY_TYPE_BADGE[entry.accountType] : null;
            return (
              <tr
                key={field.id}
                className={cn(
                  "border-t hover-elevate",
                  activeRow === index &&
                    (mode === "payment"
                      ? "bg-amber-50/60 dark:bg-amber-950/20 shadow-[inset_2px_0_0_#f59e0b]"
                      : "bg-emerald-50/60 dark:bg-emerald-950/20 shadow-[inset_2px_0_0_#10b981]")
                )}
              >
                <td className="px-2 py-1.5 text-center text-[11px] font-mono text-muted-foreground tabular-nums align-top pt-3">
                  {index + 1}
                </td>
                <td className="px-2 py-1.5">
                  <FormField
                    control={form.control}
                    name={`entries.${index}.accountName`}
                    render={({ field: accountField }) => (
                      <FormItem>
                        <FormControl>
                          <Input
                            {...accountField}
                            placeholder="Type to search..."
                            className="text-sm h-8"
                            data-testid={`input-account-${index}`}
                            onChange={(event) => {
                              accountField.onChange(event);
                              setSidebarSearchValue(event.target.value);
                            }}
                            onFocus={() => onRowFocus(index, "account")}
                            onKeyDown={(event) => handleAccountKeyDown(event, index)}
                            onBlur={() => setTimeout(() => onRowBlur(), 200)}
                          />
                        </FormControl>
                        {!isEmpty && typeBadge && (
                          <span
                            className={`lg:hidden inline-block text-[11px] font-medium px-1.5 py-0 rounded-sm mt-0.5 ${typeBadge.cls}`}
                          >
                            {typeBadge.label}
                          </span>
                        )}
                        {renderBalanceLine(index)}
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </td>
                <td className="px-2 py-1.5 align-top pt-3 hidden lg:table-cell">
                  {!isEmpty && typeBadge && (
                    <span className={`inline-block text-[11px] font-medium px-1.5 py-0 rounded-sm ${typeBadge.cls}`}>
                      {typeBadge.label}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1.5">
                  <FormField
                    control={form.control}
                    name={`entries.${index}.amount`}
                    render={({ field: amountField }) => (
                      <FormItem>
                        <FormControl>
                          <Input
                            {...amountField}
                            type="number"
                            step="0.01"
                            placeholder="0.00"
                            className="font-mono tabular-nums text-right h-8"
                            data-testid={`input-amount-${index}`}
                            onKeyDown={(event) => handleAmountKeyDown(event, index)}
                            onBlur={(event) => handleAmountBlur(event, index)}
                            onFocus={() => onRowFocus(index, "amount")}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </td>
                <td className="px-2 py-1.5 hidden md:table-cell">
                  <FormField
                    control={form.control}
                    name={`entries.${index}.narration`}
                    render={({ field: narrationField }) => (
                      <FormItem>
                        <FormControl>
                          <Input
                            {...narrationField}
                            placeholder="Optional note"
                            className="text-sm h-8"
                            data-testid={`input-narration-${index}`}
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </td>
                <td className="px-2 py-1.5 align-top pt-3 text-right hidden lg:table-cell">
                  <span
                    className="text-xs font-mono tabular-nums text-muted-foreground"
                    data-testid={`text-running-${index}`}
                  >
                    {runningTotals[index] > 0 ? formatEntryAmount(runningTotals[index]) : "—"}
                  </span>
                </td>
                <td className="px-1 py-1.5 align-top pt-2">
                  {fields.length > 1 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => remove(index)}
                      data-testid={`button-remove-${index}`}
                    >
                      <X className="h-4 w-4 text-muted-foreground" />
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
        <tfoot className="bg-muted/30 border-t">
          <tr>
            <td colSpan={7} className="px-2 py-2">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={handleAddRow}
                  data-testid="button-add-row"
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Add Row
                </Button>
                <p className="text-[11px] text-muted-foreground hidden xl:block">
                  <kbd className="px-1 py-0.5 bg-muted rounded-sm text-[11px]">Tab</kbd> next field
                  <kbd className="px-1 py-0.5 bg-muted rounded-sm text-[11px] ml-2">↵</kbd> new row
                  <kbd className="px-1 py-0.5 bg-muted rounded-sm text-[11px] ml-2">↑↓</kbd> move
                </p>
                {hasAnyAmount && (
                  <div className="text-right xl:hidden">
                    <div className="text-[11px] text-muted-foreground uppercase tracking-wider">Subtotal</div>
                    <div className="text-sm font-semibold font-mono tabular-nums">{formatEntryAmount(total)}</div>
                  </div>
                )}
              </div>
            </td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

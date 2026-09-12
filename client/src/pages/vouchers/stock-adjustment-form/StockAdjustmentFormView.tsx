import { format } from "date-fns";
import { formatNumber } from "@/lib/formatNumber";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Plus, FileDown, ChevronDown } from "lucide-react";
import type { StockAdjustmentFormModel } from "./useStockAdjustmentFormModel";
import { AdjustmentMobileRows } from "./AdjustmentMobileRows";
import { AdjustmentSpreadsheet } from "./AdjustmentSpreadsheet";
import { AdjustmentItemSidebar } from "./AdjustmentItemSidebar";

export function StockAdjustmentFormView({ model }: { model: StockAdjustmentFormModel }) {
  const {
    locations,
    stockAdjustmentForm,
    appendAdjustment,
    adjustmentEntries,
    consumptionTotal,
    productionTotal,
    displayAdjustmentTotal,
    stockAdjustmentMutation,
    handleExportProductionConsumptionVoucher,
    onStockAdjustmentSubmit,
    formatAmount,
  } = model;

  return (
    <div className="space-y-4">
      <Card>
        <div className="p-5">
          <div className="flex items-center gap-2 mb-5">
            <span className="text-sm font-semibold">Production / Consumption Voucher</span>
          </div>
          <Form {...stockAdjustmentForm}>
            <form noValidate onSubmit={stockAdjustmentForm.handleSubmit(onStockAdjustmentSubmit)} className="space-y-6">
              {/* Header Row */}
              <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
                <FormField
                  control={stockAdjustmentForm.control}
                  name="locationId"
                  render={({ field }) => (
                    <FormItem className="flex-1">
                      <FormLabel>Location</FormLabel>
                      <Select
                        value={field.value > 0 ? field.value.toString() : ""}
                        onValueChange={(v) => field.onChange(parseInt(v))}
                      >
                        <FormControl>
                          <SelectTrigger data-testid="select-adjustment-location">
                            <SelectValue placeholder="Select location..." />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          {[...locations]
                            .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
                            .map((loc) => (
                              <SelectItem key={loc.id} value={loc.id.toString()}>
                                {loc.name}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <FormField
                  control={stockAdjustmentForm.control}
                  name="voucherDate"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Date</FormLabel>
                      <FormControl>
                        <Input
                          type="date"
                          value={
                            field.value instanceof Date
                              ? format(field.value, "yyyy-MM-dd")
                              : typeof field.value === "string"
                                ? field.value
                                : ""
                          }
                          onChange={(e) =>
                            field.onChange(e.target.value ? new Date(e.target.value + "T00:00:00") : new Date())
                          }
                          className="w-full sm:w-[200px]"
                          data-testid="input-adjustment-date"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>

              {/* Unified Production/Consumption Table + Sidebar */}
              <div className="flex flex-col lg:flex-row gap-4">
                <Card className="flex-1 overflow-hidden min-w-0">
                  {/* Mobile: card-per-row */}
                  <AdjustmentMobileRows model={model} />

                  {/* Desktop: spreadsheet */}
                  <AdjustmentSpreadsheet model={model} />

                  {/* Total Section */}
                  <div className="border-t bg-muted/20 p-4">
                    <div className="flex flex-wrap justify-between items-center gap-2">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() =>
                          appendAdjustment({
                            type: "CONSUME",
                            stockItemId: 0,
                            stockItemCode: "",
                            stockItemName: "",
                            quantity: "",
                            rate: "",
                          })
                        }
                        data-testid="button-add-adjustment-row"
                      >
                        <Plus className="h-4 w-4 mr-2" />
                        Add Row
                      </Button>
                      <div className="flex flex-wrap items-center gap-2 sm:gap-6">
                        <div className="text-xs text-muted-foreground">Total Qty:</div>
                        <div className="text-xs font-mono font-medium">
                          {formatNumber(adjustmentEntries.reduce((sum, e) => sum + parseFloat(e.quantity || "0"), 0))}
                        </div>
                        <div className="text-xs text-muted-foreground">Consume:</div>
                        <div className="text-xs font-mono font-medium text-destructive">
                          {formatAmount(consumptionTotal)}
                        </div>
                        <div className="text-xs text-muted-foreground">Produce:</div>
                        <div className="text-xs font-mono font-medium text-green-600">
                          {formatAmount(productionTotal)}
                        </div>
                        <div className="text-sm font-semibold">Total:</div>
                        <div className="text-sm font-bold font-mono" data-testid="text-adjustment-total">
                          {formatAmount(displayAdjustmentTotal)}
                        </div>
                      </div>
                    </div>
                  </div>
                </Card>

                {/* Item Search Sidebar */}
                <AdjustmentItemSidebar model={model} />
              </div>

              {/* Notes */}
              <FormField
                control={stockAdjustmentForm.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea
                        {...field}
                        placeholder="Additional notes..."
                        rows={3}
                        data-testid="input-adjustment-notes"
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              {/* Optional */}
              <FormField
                control={stockAdjustmentForm.control}
                name="optional"
                render={({ field }) => (
                  <FormItem className="flex flex-row items-start space-x-3 space-y-0">
                    <FormControl>
                      <Checkbox
                        checked={field.value}
                        onCheckedChange={field.onChange}
                        data-testid="checkbox-adjustment-optional"
                      />
                    </FormControl>
                    <div className="space-y-1 leading-none">
                      <FormLabel>Mark as Optional</FormLabel>
                    </div>
                  </FormItem>
                )}
              />

              {/* Footer Actions */}
              <div className="flex flex-wrap justify-end gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={
                        adjustmentEntries.filter((e) => e.stockItemId > 0 && parseFloat(e.quantity) > 0).length === 0
                      }
                      data-testid="button-export-production-consumption"
                    >
                      <FileDown className="h-4 w-4 mr-2" />
                      Export
                      <ChevronDown className="h-4 w-4 ml-1" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() => handleExportProductionConsumptionVoucher(false)}
                      data-testid="export-prod-cons-summary"
                    >
                      Summary Export
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onClick={() => handleExportProductionConsumptionVoucher(true)}
                      data-testid="export-prod-cons-detailed"
                    >
                      Detailed Export
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
                <Button
                  type="submit"
                  disabled={stockAdjustmentMutation.isPending || adjustmentEntries.length === 0}
                  data-testid="button-save-adjustment-voucher"
                >
                  {stockAdjustmentMutation.isPending ? "Saving..." : "Save Production/Consumption Voucher"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </Card>
    </div>
  );
}

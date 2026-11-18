// Extracted from ./CreditNoteTab.tsx to keep that module under the source-size cap.
import { formatNumber } from "@/lib/formatNumber";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Package, Pencil, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { AccountAutocomplete } from "@/components/AccountAutocomplete";
import { useCreditNoteTabState } from "./useCreditNoteTabState";

export function CreditNoteTabCardSection({
  allAccounts,
  cashAccountId,
  cashAccountName,
  cashAccountType,
  form,
  isEditMode,
  isPending,
  isPhoneLayout,
  items,
  noteCurrency,
  noteType,
  onSubmit,
  removeItem,
  resetForm,
  totalInventoryValue,
  totalRefund,
  totalRefundUsd,
  updateItemInventoryCost,
}: Pick<
  ReturnType<typeof useCreditNoteTabState>,
  | "allAccounts"
  | "cashAccountId"
  | "cashAccountName"
  | "cashAccountType"
  | "form"
  | "isEditMode"
  | "isPending"
  | "isPhoneLayout"
  | "items"
  | "noteCurrency"
  | "noteType"
  | "onSubmit"
  | "removeItem"
  | "resetForm"
  | "totalInventoryValue"
  | "totalRefund"
  | "totalRefundUsd"
  | "updateItemInventoryCost"
>) {
  return (
    <Card className="flex-1 flex flex-col">
      <CardHeader className="pb-3 shrink-0">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <CardTitle className="flex items-center gap-2">
            {isEditMode ? (
              <>
                <Pencil className="h-5 w-5" />
                Edit {noteType}
              </>
            ) : (
              <>
                <Package className="h-5 w-5" />
                {noteType === "Credit Note" ? "Credit Note (Customer Return)" : "Debit Note"}
              </>
            )}
          </CardTitle>
          {/* Phones save from the pinned action bar at the bottom of the tab. */}
          <div className={cn("w-full flex-wrap gap-2 sm:w-auto", isPhoneLayout ? "hidden" : "flex")}>
            {isEditMode && (
              <Button type="button" variant="outline" onClick={resetForm} data-testid="button-cancel-edit">
                Cancel
              </Button>
            )}
            <Button
              type="button"
              onClick={form.handleSubmit(onSubmit)}
              disabled={items.length === 0 || isPending}
              data-testid="button-create-credit-note"
            >
              <Plus className="h-4 w-4 mr-1" />
              {isPending ? "Saving..." : isEditMode ? "Update Note" : "Create Note"}
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="flex-1 overflow-auto">
        <Form {...form}>
          <form className="space-y-4" noValidate>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <FormField
                control={form.control}
                name="noteType"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Type</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value} disabled={isEditMode}>
                      <FormControl>
                        <SelectTrigger data-testid="select-note-type">
                          <SelectValue placeholder="Select type" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        <SelectItem value="Credit Note">Credit Note</SelectItem>
                        <SelectItem value="Debit Note">Debit Note</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="voucherDate"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Date</FormLabel>
                    <FormControl>
                      <Input
                        type="date"
                        value={field.value || ""}
                        onChange={(event) => field.onChange(event.target.value)}
                        data-testid="input-credit-note-date"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="cashAccountId"
                render={() => (
                  <FormItem className="sm:col-span-2">
                    <FormLabel>{noteType === "Credit Note" ? "Refund From (Cash/Bank)" : "Receive Into"}</FormLabel>
                    <FormControl>
                      <AccountAutocomplete
                        value={
                          cashAccountId > 0
                            ? { type: cashAccountType, id: cashAccountId, name: cashAccountName || "" }
                            : null
                        }
                        onChange={(type, id, name) => {
                          form.setValue("cashAccountType", type);
                          form.setValue("cashAccountId", id);
                          form.setValue("cashAccountName", name);
                        }}
                        allAccounts={allAccounts}
                        rowIndex={-1}
                        placeholder="Select cash/bank account..."
                        testId="input-credit-note-account"
                      />
                    </FormControl>
                  </FormItem>
                )}
              />
            </div>

            {items.length > 0 && (
              <Card>
                <CardContent className="p-0">
                  <Table mobileLayout="cards">
                    <TableHeader>
                      <TableRow>
                        <TableHead>Item</TableHead>
                        <TableHead>Location</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Refund Rate ({noteCurrency})</TableHead>
                        <TableHead className="text-right">Refund Amt</TableHead>
                        <TableHead className="text-right">Inv. Cost (USD)</TableHead>
                        <TableHead className="text-right">Inv. Value (USD)</TableHead>
                        <TableHead></TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {items.map((item, index) => {
                        const qty = parseFloat(item.quantity);
                        const refundAmt = qty * parseFloat(item.refundRate);
                        const invValue = qty * parseFloat(item.inventoryCost);
                        return (
                          <TableRow key={item.rowKey} data-testid={`credit-note-item-${index}`}>
                            <TableCell className="font-medium">{item.stockItemName}</TableCell>
                            <TableCell>{item.locationName}</TableCell>
                            <TableCell className="text-right font-mono">
                              {formatNumber(qty, 0)} {item.uom}
                            </TableCell>
                            <TableCell className="text-right font-mono">
                              {formatNumber(parseFloat(item.refundRate))}
                            </TableCell>
                            <TableCell className="text-right font-mono text-primary">
                              {formatNumber(refundAmt)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Input
                                type="number"
                                step="0.01"
                                value={item.inventoryCost}
                                onChange={(event) => updateItemInventoryCost(index, event.target.value)}
                                className="w-20 h-8 text-right font-mono text-sm"
                                data-testid={`input-inv-cost-${index}`}
                              />
                            </TableCell>
                            <TableCell className="text-right font-mono text-muted-foreground">
                              {formatNumber(invValue)}
                            </TableCell>
                            <TableCell>
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => removeItem(index)}
                                data-testid={`button-remove-item-${index}`}
                              >
                                <Trash2 className="h-4 w-4 text-destructive" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            <FormField
              control={form.control}
              name="description"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Notes</FormLabel>
                  <FormControl>
                    <Textarea
                      {...field}
                      placeholder="Enter notes..."
                      className="resize-none"
                      rows={2}
                      data-testid="input-credit-note-description"
                    />
                  </FormControl>
                </FormItem>
              )}
            />
            <div className="flex flex-wrap justify-between items-center pt-4 border-t gap-2">
              <div className="space-y-1">
                <div className="text-lg font-semibold">
                  Refund Total:{" "}
                  <span className="font-mono text-primary">
                    {noteCurrency === "ZMW" ? "K" : "$"} {formatNumber(totalRefund, 2)}
                  </span>
                </div>
                <div className="text-sm text-muted-foreground">
                  Inventory Value: <span className="font-mono">{formatNumber(totalInventoryValue)}</span>
                  {Math.abs(totalRefundUsd - totalInventoryValue) > 0.01 && (
                    <span className="ml-2">(Variance: {formatNumber(totalRefundUsd - totalInventoryValue)})</span>
                  )}
                </div>
              </div>
            </div>
          </form>
        </Form>
      </CardContent>
    </Card>
  );
}

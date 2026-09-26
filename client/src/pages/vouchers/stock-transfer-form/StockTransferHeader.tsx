import { format } from "date-fns";
import { LayoutGrid, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Form, FormControl, FormField, FormItem, FormLabel } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StockTransferDesktopEntries } from "./StockTransferDesktopEntries";
import { StockTransferFooterAndDialogs } from "./StockTransferFooterAndDialogs";
import { StockTransferMobileEntries } from "./StockTransferMobileEntries";
import { StockTransferSidebars } from "./StockTransferSidebars";
import { StockTransferTotals } from "./StockTransferTotals";
import type { StockTransferFormModel } from "./useStockTransferFormModel";

export function StockTransferHeader({ model }: { model: StockTransferFormModel }) {
  const {
    isPOS,
    voucherIdToEdit,
    myLocations,
    posSelectedSourceId,
    setPosSelectedSourceId,
    locations,
    posSelectedSourceName,
    posLocationName,
    setTransferInventorySource,
    stockTransferForm,
    transferInventorySource,
    setLocation,
    setImportDialogOpen,
  } = model;

  return (
    <div className="flex flex-wrap items-center gap-2 sm:gap-4 mb-4">
      {isPOS && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">From:</span>
          {myLocations.length > 1 ? (
            <Select
              value={posSelectedSourceId?.toString() || ""}
              onValueChange={(v) => {
                const newId = Number(v);
                if (!Number.isInteger(newId) || newId <= 0) return;
                const newName = locations.find((l) => l.id === newId)?.name || "";
                setPosSelectedSourceId(newId);
                setTransferInventorySource(newId);
                const curEntries = stockTransferForm.getValues("entries");
                curEntries.forEach((_, index) => {
                  stockTransferForm.setValue(`entries.${index}.sourceLocationId`, newId);
                  stockTransferForm.setValue(`entries.${index}.sourceLocationName`, newName);
                  stockTransferForm.setValue(`entries.${index}.stockItemId`, 0);
                  stockTransferForm.setValue(`entries.${index}.stockItemName`, "");
                  stockTransferForm.setValue(`entries.${index}.quantity`, "");
                });
              }}
            >
              <SelectTrigger className="w-[160px]" data-testid="select-source-location-pos">
                <SelectValue placeholder="Select source..." />
              </SelectTrigger>
              <SelectContent>
                {myLocations.map((l) => (
                  <SelectItem key={l.id} value={String(l.id)}>
                    {l.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <span className="font-medium">{posSelectedSourceName || posLocationName}</span>
          )}
        </div>
      )}
      <FormField
        control={stockTransferForm.control}
        name="destinationLocationId"
        render={({ field }) => {
          const destinationId = Number(field.value);
          return (
            <FormItem className="flex items-center gap-2 space-y-0 max-sm:w-full max-sm:flex-col max-sm:items-stretch max-sm:gap-1">
              <FormLabel className="text-sm text-muted-foreground whitespace-nowrap">To:</FormLabel>
              <Select
                value={Number.isInteger(destinationId) && destinationId > 0 ? String(destinationId) : ""}
                onValueChange={(value) => {
                  const nextLocationId = Number(value);
                  if (!Number.isInteger(nextLocationId) || nextLocationId <= 0) return;
                  field.onChange(nextLocationId);
                }}
              >
                <FormControl>
                  <SelectTrigger className="w-full sm:w-[200px]" data-testid="select-destination-location">
                    <SelectValue placeholder="Select destination..." />
                  </SelectTrigger>
                </FormControl>
                <SelectContent>
                  {[...locations]
                    .filter((l) => l.id !== transferInventorySource)
                    .sort((a, b) => (a.name || "").localeCompare(b.name || ""))
                    .map((location) => (
                      <SelectItem key={location.id} value={location.id.toString()}>
                        {location.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </FormItem>
          );
        }}
      />
      <FormField
        control={stockTransferForm.control}
        name="voucherDate"
        render={({ field }) => (
          <FormItem className="flex items-center gap-2 space-y-0 max-sm:w-full max-sm:flex-col max-sm:items-stretch max-sm:gap-1">
            <FormLabel className="text-sm text-muted-foreground whitespace-nowrap">Date:</FormLabel>
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
                onChange={(e) => field.onChange(e.target.value ? new Date(e.target.value + "T00:00:00") : new Date())}
                className="w-full sm:w-[160px]"
                data-testid="input-transfer-date"
              />
            </FormControl>
          </FormItem>
        )}
      />
      <div className="flex-1 max-sm:hidden" />
      {!isPOS && voucherIdToEdit && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setLocation(`/stock-transfer-order?edit=${voucherIdToEdit}`)}
          data-testid="button-switch-to-order-view"
        >
          <LayoutGrid className="h-4 w-4 mr-2" />
          Order View
        </Button>
      )}
      {!isPOS && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setImportDialogOpen(true)}
          data-testid="button-open-import-dialog"
        >
          <Upload className="h-4 w-4 mr-2" />
          Import
        </Button>
      )}
    </div>
  );
}

export function StockTransferFormView({ model }: { model: StockTransferFormModel }) {
  const { stockTransferForm, onStockTransferSubmit, toast } = model;

  return (
    <div className="space-y-4">
      <Form {...stockTransferForm}>
        <form
          noValidate
          onSubmit={stockTransferForm.handleSubmit(onStockTransferSubmit, (errors) => {
            console.error("Stock Transfer Form Validation Errors:", errors);
            toast({
              title: "Form Validation Error",
              description:
                Object.values(errors)
                  .map((error) => error?.message || JSON.stringify(error))
                  .join(", ") || "Please check all fields",
              variant: "destructive",
            });
          })}
        >
          <StockTransferHeader model={model} />
          <div className="flex flex-col lg:flex-row gap-4">
            <Card className="flex-1 overflow-hidden min-w-0">
              <StockTransferMobileEntries model={model} />
              <StockTransferDesktopEntries model={model} />
              <StockTransferTotals model={model} />
            </Card>
            <StockTransferSidebars model={model} />
          </div>
          <StockTransferFooterAndDialogs model={model} />
        </form>
      </Form>
    </div>
  );
}

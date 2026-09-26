import { format } from "date-fns";
import { CalendarIcon, ChevronDown, FileDown, List, Settings2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { useStockTransferOrderModel } from "./useStockTransferOrderModel";

type Model = ReturnType<typeof useStockTransferOrderModel>;

interface StockTransferOrderHeaderProps {
  model: Model;
  onSwitchToNormalView?: () => void;
}

export function StockTransferOrderHeader({ model, onSwitchToNormalView }: StockTransferOrderHeaderProps) {
  const {
    editVoucherId,
    destinationLocationId,
    setDestinationLocationId,
    availableDestinations,
    locationDialogOpen,
    setLocationDialogOpen,
    selectedLocations,
    locations,
    toggleLocation,
    selectedLocationIds,
    transferDate,
    setTransferDate,
    isOptional,
    setIsOptional,
    navigate,
    orderItems,
    handleExportOrder,
  } = model;

  return (
    <div className="space-y-3">
      {(() => {
        const title = editVoucherId ? "Edit Stock Transfer Order" : "Stock Transfer Order";
        const actions = (
          <>
            {editVoucherId && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (onSwitchToNormalView) {
                    onSwitchToNormalView();
                    return;
                  }
                  navigate(`/vouchers?edit=${editVoucherId}&tab=transfer`);
                }}
                data-testid="button-switch-to-normal-view"
              >
                <List className="h-4 w-4 mr-2" />
                Normal View
              </Button>
            )}

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={orderItems.length === 0}
                  data-testid="button-export-order"
                >
                  <FileDown className="h-4 w-4 mr-1" />
                  Export
                  <ChevronDown className="h-4 w-4 ml-1" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => handleExportOrder(false)} data-testid="export-order-no-cost">
                  Export without Cost
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleExportOrder(true)} data-testid="export-order-with-cost">
                  Export with Cost
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        );
        // Inside the Vouchers page (onSwitchToNormalView) the page already has its header; the
        // order view gets a section heading instead of a second page header.
        return onSwitchToNormalView ? (
          <div
            className="flex flex-wrap items-center justify-between gap-2"
            data-testid="stock-transfer-order-section-header"
          >
            <h2 className="text-base font-semibold">{title}</h2>
            <div className="flex flex-wrap items-center gap-2">{actions}</div>
          </div>
        ) : (
          <PageHeader
            title={title}
            subtitle={
              editVoucherId
                ? "Edit and update this stock transfer using the order view"
                : "Build orders by selecting items from multiple source locations"
            }
          >
            {actions}
          </PageHeader>
        );
      })()}

      <div
        className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 sm:flex sm:flex-wrap sm:items-center"
        data-testid="stock-transfer-order-settings"
      >
        <div className="flex min-w-0 items-center gap-2 min-[420px]:col-span-2 sm:col-span-1">
          <Label className="text-sm whitespace-nowrap">Destination:</Label>
          <Select
            value={destinationLocationId?.toString() || ""}
            onValueChange={(value) => setDestinationLocationId(parseInt(value))}
          >
            <SelectTrigger className="w-full sm:w-[200px]" data-testid="select-destination">
              <SelectValue placeholder="Choose destination" />
            </SelectTrigger>
            <SelectContent>
              {availableDestinations.map((location) => (
                <SelectItem
                  key={location.id}
                  value={location.id.toString()}
                  data-testid={`select-destination-option-${location.id}`}
                >
                  {location.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Dialog open={locationDialogOpen} onOpenChange={setLocationDialogOpen}>
          <Button variant="outline" onClick={() => setLocationDialogOpen(true)} data-testid="button-select-sources">
            <Settings2 className="h-4 w-4 mr-2" />
            Source Locations ({selectedLocations.length})
          </Button>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Select Source Locations</DialogTitle>
            </DialogHeader>
            <div className="space-y-2 max-h-[400px] overflow-y-auto">
              {locations.map((location) => (
                <div
                  key={location.id}
                  className="flex items-center gap-3 p-2 rounded-md hover-elevate cursor-pointer"
                  onClick={() => toggleLocation(location.id)}
                  data-testid={`location-checkbox-${location.id}`}
                >
                  <Checkbox
                    checked={selectedLocationIds.includes(location.id)}
                    onCheckedChange={() => toggleLocation(location.id)}
                  />
                  <div className="flex-1">
                    <p className="text-sm font-medium">{location.name}</p>
                    <p className="text-xs text-muted-foreground">{location.code}</p>
                  </div>
                </div>
              ))}
            </div>
            <DialogFooter>
              <Button onClick={() => setLocationDialogOpen(false)}>Done</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              className={cn(
                "w-full sm:w-[140px] justify-start text-left font-normal",
                !transferDate && "text-muted-foreground"
              )}
              data-testid="button-select-date"
            >
              <CalendarIcon className="mr-2 h-4 w-4" />
              {transferDate ? format(transferDate, "MMM dd, yyyy") : "Pick date"}
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-0" align="end">
            <Calendar
              mode="single"
              selected={transferDate}
              onSelect={(date) => date && setTransferDate(date)}
              initialFocus
            />
          </PopoverContent>
        </Popover>

        <div className="flex items-center gap-2">
          <Switch
            id="optional-mode"
            checked={isOptional}
            onCheckedChange={setIsOptional}
            data-testid="switch-optional"
          />
          <Label htmlFor="optional-mode" className="text-sm cursor-pointer">
            Optional
          </Label>
        </div>
      </div>
    </div>
  );
}

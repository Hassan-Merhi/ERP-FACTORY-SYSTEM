import { useState } from "react";

export const formatCurrency = (num: number) => {
  return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });
};
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Supplier } from "@shared/schema";

export interface SupplierComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  suppliers: Supplier[];
  placeholder?: string;
  testId?: string;
  isLoading?: boolean;
  hasError?: boolean;
}

export interface POImportItem {
  poNumber: string;
  supplierCode?: string;
  barcode?: string | null;
  stockItemId?: number | null;
  itemName: string;
  quantity: string | number;
  rate: string | number;
  lineTotal: string | number;
  currency?: string;
}

export interface POImportCharges {
  freight: string | number;
  surcharge: string | number;
  fumigation: string | number;
  discount: string | number;
  documentCharges: string | number;
}

export interface POImportContainer {
  containerNumber: string;
  supplierCode?: string;
  itemsCount: number;
  posCount: number;
  itemsTotal: string | number;
  grandTotal: string | number;
  charges: POImportCharges;
  items: POImportItem[];
}

export interface POImportPreview {
  fileHash: string;
  fileName: string;
  preview: POImportContainer[];
}

export interface POValidationResult {
  errors: React.ReactNode[];
  resolvedItems?: { index: number; stockItemId: number; itemName: string }[];
}

export interface POImportDraft {
  preview: POImportPreview;
  selectedSupplier: string;
  containerNumber: string;
  importDate: string;
  freightPaidBy: "supplier" | "parent";
  freightParentAccountId: string;
  importCurrency: "" | "USD" | "ZMW";
}

export const draftStorageKey = (companyId: number) => `po-import-draft:${companyId}`;

/** Merge server-resolved names into the parsed file without touching its amounts. */
export function withResolvedStockItems(
  current: POImportPreview | null,
  payload: POImportPayload,
  result: POValidationResult
): POImportPreview | null {
  if (!current || current.fileHash !== payload.fileHash || !result.resolvedItems?.length) return current;
  const resolved = new Map(result.resolvedItems.map((item) => [item.index, item]));
  let changed = false;
  const containers = current.preview.map((container) => {
    if (container.containerNumber !== payload.containerNumber) return container;
    const items = container.items.map((item, index) => {
      const match = resolved.get(index);
      if (!match || (item.itemName === match.itemName && item.stockItemId === match.stockItemId)) return item;
      changed = true;
      return { ...item, itemName: match.itemName, stockItemId: match.stockItemId };
    });
    return changed ? { ...container, items } : container;
  });
  return changed ? { ...current, preview: containers } : current;
}

export type POImportPayload = POImportPreview & {
  containerNumber: string;
  supplierId: number;
  importDate: string;
  exchangeRate?: string;
  /** Explicit invoice currency for a USD/ZMW company; absent elsewhere. */
  currency?: "USD" | "ZMW";
  freightPaidBy: "supplier" | "parent";
  freightParentAccountId: number | null;
};

export function SupplierCombobox({
  value,
  onValueChange,
  suppliers,
  placeholder = "Select supplier",
  testId,
  isLoading = false,
  hasError = false,
}: SupplierComboboxProps) {
  const [open, setOpen] = useState(false);
  const selectedSupplier = suppliers.find((supplier) => supplier.id.toString() === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
          data-testid={testId}
          disabled={isLoading || hasError}
        >
          {isLoading
            ? "Loading suppliers..."
            : hasError
              ? "Unable to load suppliers"
              : selectedSupplier
                ? selectedSupplier.legalName
                : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <Command>
          <CommandInput placeholder="Search suppliers..." />
          <CommandList>
            <CommandEmpty>No supplier found for this company.</CommandEmpty>
            <CommandGroup>
              {suppliers.map((supplier) => (
                <CommandItem
                  key={supplier.id}
                  value={supplier.legalName}
                  onSelect={() => {
                    onValueChange(supplier.id.toString());
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn("mr-2 h-4 w-4", value === supplier.id.toString() ? "opacity-100" : "opacity-0")}
                  />
                  {supplier.legalName}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

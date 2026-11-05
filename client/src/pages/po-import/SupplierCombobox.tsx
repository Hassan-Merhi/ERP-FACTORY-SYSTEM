import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Supplier } from "@shared/schema";

interface SupplierComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  suppliers: Supplier[];
  placeholder?: string;
  testId?: string;
  isLoading?: boolean;
  hasError?: boolean;
}

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

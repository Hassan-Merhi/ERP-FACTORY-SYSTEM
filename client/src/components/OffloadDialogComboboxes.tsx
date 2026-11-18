// Extracted from ./OffloadDialog.tsx: account and location pickers.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Location } from "@shared/schema";
import type { LedgerAccountOption } from "./offloadDialogTypes";

export interface AccountComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  accounts: LedgerAccountOption[];
  placeholder?: string;
  disabled?: boolean;
  testId?: string;
}

export function AccountCombobox({
  value,
  onValueChange,
  accounts,
  placeholder = "Select account",
  disabled = false,
  testId,
}: AccountComboboxProps) {
  const [open, setOpen] = useState(false);
  const selectedAccount = accounts.find((account) => account.id.toString() === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
          disabled={disabled}
          data-testid={testId}
        >
          {selectedAccount ? selectedAccount.name : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <Command>
          <CommandInput placeholder="Search accounts..." />
          <CommandList>
            <CommandEmpty>No account found.</CommandEmpty>
            <CommandGroup>
              {accounts.map((account) => (
                <CommandItem
                  key={account.id}
                  value={account.name}
                  onSelect={() => {
                    onValueChange(account.id.toString());
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn("mr-2 h-4 w-4", value === account.id.toString() ? "opacity-100" : "opacity-0")}
                  />
                  {account.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export interface LocationComboboxProps {
  value: string;
  onValueChange: (value: string) => void;
  locations: Location[];
  placeholder?: string;
  testId?: string;
}

export function LocationCombobox({
  value,
  onValueChange,
  locations,
  placeholder = "Select location",
  testId,
}: LocationComboboxProps) {
  const [open, setOpen] = useState(false);
  const selectedLocation = locations.find((location) => location.id.toString() === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between"
          data-testid={testId}
        >
          {selectedLocation ? selectedLocation.name : placeholder}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-full p-0" align="start">
        <Command>
          <CommandInput placeholder="Search locations..." />
          <CommandList>
            <CommandEmpty>No location found.</CommandEmpty>
            <CommandGroup>
              {locations.map((location) => (
                <CommandItem
                  key={location.id}
                  value={location.name}
                  onSelect={() => {
                    onValueChange(location.id.toString());
                    setOpen(false);
                  }}
                >
                  <Check
                    className={cn("mr-2 h-4 w-4", value === location.id.toString() ? "opacity-100" : "opacity-0")}
                  />
                  {location.name}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

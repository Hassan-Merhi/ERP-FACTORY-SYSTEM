import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { cn } from "@/lib/utils";
import type { LedgerAccount, BankAccount, Supplier, Employee, FixedAsset } from "./types";

export function AccountCombobox({
  value,
  onChange,
  ledgerAccounts,
  bankAccounts,
  suppliers,
  employees,
  fixedAssets,
  rowIndex,
  testIdPrefix = "button-account",
}: {
  value: { type: string; id: number; name: string } | null;
  onChange: (type: "ledger" | "bank" | "supplier" | "employee" | "fixedAsset", id: number, name: string) => void;
  ledgerAccounts: LedgerAccount[];
  bankAccounts: BankAccount[];
  suppliers: Supplier[];
  employees: Employee[];
  fixedAssets: FixedAsset[];
  rowIndex: number;
  testIdPrefix?: string;
  onArrowUp?: () => void;
  onArrowDown?: () => void;
  onArrowRight?: () => void;
}) {
  const [open, setOpen] = useState(false);

  const allAccounts = [
    ...ledgerAccounts.map((a) => ({
      type: "ledger" as const,
      id: a.id,
      name: a.name,
    })),
    ...bankAccounts.map((a) => ({
      type: "bank" as const,
      id: a.id,
      name: a.bankName,
    })),
    ...suppliers.map((s) => ({
      type: "supplier" as const,
      id: s.id,
      name: s.legalName,
    })),
    ...employees.map((e) => ({
      type: "employee" as const,
      id: e.id,
      name: `${e.firstName} ${e.lastName}`,
    })),
    ...fixedAssets.map((f) => ({
      type: "fixedAsset" as const,
      id: f.id,
      name: f.assetName,
    })),
  ].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          data-testid={`${testIdPrefix}-${rowIndex}`}
        >
          {value ? value.name : "Select account..."}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[min(400px,calc(100vw-2rem))] p-0 bg-popover text-popover-foreground">
        <Command className="bg-popover text-popover-foreground">
          <CommandInput placeholder="Search accounts..." className="bg-popover text-popover-foreground" />
          <CommandList className="bg-popover text-popover-foreground">
            <CommandEmpty>No account found.</CommandEmpty>
            <CommandGroup>
              {allAccounts.map((account) => (
                <CommandItem
                  key={`${account.type}-${account.id}`}
                  value={account.name}
                  onSelect={() => {
                    onChange(account.type, account.id, account.name);
                    setOpen(false);
                  }}
                  data-testid={`option-account-${account.type}-${account.id}`}
                >
                  <Check
                    className={cn(
                      "mr-2 h-4 w-4",
                      value?.type === account.type && value?.id === account.id ? "opacity-100" : "opacity-0"
                    )}
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

import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Button } from "@/components/ui/button";
import { Check, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useCompany } from "@/contexts/CompanyContext";
import type { LedgerAccount, BankAccount, Supplier, Customer } from "@shared/schema";

export function AccountCombobox({
  value,
  onChange,
  ledgerAccounts,
  bankAccounts,
  suppliers: suppliersProp = [],
  customers: customersProp = [],
  rowIndex,
  onFocus,
  onKeyDown,
  testIdPrefix = "button-account",
}: {
  value: { type: string; id: number; name: string } | null;
  onChange: (type: "ledger" | "bank" | "supplier" | "customer", id: number, name: string) => void;
  ledgerAccounts: LedgerAccount[];
  bankAccounts: BankAccount[];
  suppliers?: Supplier[];
  customers?: Customer[];
  rowIndex: number;
  onFocus?: () => void;
  onKeyDown?: (e: React.KeyboardEvent) => void;
  testIdPrefix?: string;
}) {
  const [open, setOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const { selectedCompany } = useCompany();

  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(searchTerm), 300);
    return () => clearTimeout(debounceRef.current);
  }, [searchTerm]);

  useEffect(() => {
    if (!open) {
      setSearchTerm("");
      setDebouncedSearch("");
    }
  }, [open]);

  const ownFetchMode = open && suppliersProp.length === 0;
  const canSearch = ownFetchMode && debouncedSearch.length >= 2;

  const { data: fetchedSuppliers = [] } = useQuery<Supplier[]>({
    queryKey: ["/api/suppliers", selectedCompany?.id, "combobox", debouncedSearch],
    queryFn: async () => {
      const res = await fetch(`/api/suppliers?search=${encodeURIComponent(debouncedSearch)}`, {
        credentials: "include",
      });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: canSearch,
    staleTime: 60_000,
  });

  const { data: fetchedCustomers = [] } = useQuery<Customer[]>({
    queryKey: ["/api/customers", selectedCompany?.id, "combobox", debouncedSearch],
    queryFn: async () => {
      const res = await fetch(`/api/customers?search=${encodeURIComponent(debouncedSearch)}`, {
        credentials: "include",
      });
      if (!res.ok) return [];
      return res.json();
    },
    enabled: canSearch,
    staleTime: 60_000,
  });

  const suppliers = suppliersProp.length > 0 ? suppliersProp : fetchedSuppliers;
  const customers = customersProp.length > 0 ? customersProp : fetchedCustomers;

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
    ...customers.map((c) => ({
      type: "customer" as const,
      id: c.id,
      // legal_name is NOT NULL, so there is no second name field to fall back to.
      name: c.legalName,
    })),
  ].sort((a, b) => (a.name || "").localeCompare(b.name || ""));

  const showSearchHint = ownFetchMode && searchTerm.length < 2;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          className="w-full justify-between font-normal"
          data-testid={`${testIdPrefix}-${rowIndex}`}
          onFocus={onFocus}
          onKeyDown={onKeyDown}
        >
          {value ? value.name : "Select account..."}
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[calc(100vw-2rem)] sm:w-[400px] p-0 bg-popover text-popover-foreground">
        <Command className="bg-popover text-popover-foreground">
          <CommandInput
            placeholder={ownFetchMode ? "Type name to search..." : "Search accounts..."}
            className="bg-popover text-popover-foreground"
            value={searchTerm}
            onValueChange={setSearchTerm}
          />
          <CommandList className="bg-popover text-popover-foreground">
            {showSearchHint ? (
              <p className="px-4 py-3 text-sm text-muted-foreground">
                Type at least 2 characters to search suppliers or customers.
              </p>
            ) : (
              <CommandEmpty>No account found.</CommandEmpty>
            )}
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

// Stock Item Combobox Component

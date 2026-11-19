import { useState } from "react";
import { Check, ChevronsUpDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

interface Account {
  id: number;
  name: string;
}

interface Props {
  id: string;
  accounts: Account[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export function FactoryLoadingDispatchLedgerAccountPicker({
  id,
  accounts,
  value,
  onChange,
  placeholder = "Search ledger account",
}: Props) {
  const [open, setOpen] = useState(false);
  const selected = accounts.find((account) => String(account.id) === value);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-required="true"
          variant="outline"
          className="h-9 w-full justify-between gap-2 px-3 font-normal"
        >
          <span className="truncate">{selected?.name ?? placeholder}</span>
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(420px,calc(100vw-3rem))] p-0">
        <Command>
          <CommandInput placeholder="Search account name..." />
          <CommandList>
            <CommandEmpty>No matching accounts.</CommandEmpty>
            <CommandGroup>
              {accounts.map((account) => (
                <CommandItem
                  key={account.id}
                  value={account.name + " " + account.id}
                  onSelect={() => {
                    onChange(String(account.id));
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">{account.name}</span>
                  {value === String(account.id) && <Check className="ml-auto h-4 w-4 shrink-0" />}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

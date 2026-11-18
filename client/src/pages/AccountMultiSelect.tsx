// Extracted from ./AccountMigration.tsx to keep that module under the source-size cap.
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Check, ChevronsUpDown, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Company, LedgerAccount } from "@shared/schema";

export interface AccountPreviewItem {
  account: LedgerAccount;
  entryCount: number;
  postedEntryCount: number;
  closingBalance: number;
  totalDebit: number;
  totalCredit: number;
  touchedVoucherCount: number;
  exclusiveVoucherCount: number;
  sharedVoucherCount: number;
  codeConflict: { id: number; name: string } | null;
}

export interface PreviewResult {
  accounts: AccountPreviewItem[];
  srcCompany: Company;
  destCompany: Company;
  grandTotalEntries: number;
  grandHistoryEntries: number;
  grandClosing: number;
  grandTotalDebit: number;
  grandTotalCredit: number;
}

interface ExecuteAccountResult {
  accountId: number;
  accountName: string;
  originalCode: string;
  finalCode: string;
  entryCount: number;
  wasRenamed: boolean;
}

export interface PendingMigration {
  migrationId: string;
  srcCompanyId: number;
  destCompanyId: number;
  accountIds: number[];
  movedVoucherIds: number[];
  accounts: Array<{ accountId: number; originalCode: string; finalCode: string }>;
}

export interface ExecuteResult {
  success: boolean;
  srcCompanyId: number;
  destCompanyId: number;
  totalEntries: number;
  movedVoucherIds: number[];
  movedVoucherCount: number;
  sharedVoucherCount: number;
  accounts: ExecuteAccountResult[];
}

export function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtSigned(n: number) {
  return `$ ${fmt(Math.abs(n))} ${n < 0 ? "Cr" : "Dr"}`;
}

export function CompanyBadge({ company }: { company?: Company }) {
  if (!company) return null;
  const typeColors: Record<string, string> = {
    erp: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    factory: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    factory_v2: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    properties: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  };
  const label =
    company.companyType === "erp"
      ? "ERP"
      : company.companyType === "factory" || company.companyType === "factory_v2"
        ? "Factory"
        : "Properties";
  return (
    <span
      className={`text-xs font-medium px-1.5 py-0.5 rounded-sm ${typeColors[company.companyType] ?? typeColors.erp}`}
    >
      {label}
    </span>
  );
}

interface AccountMultiSelectProps {
  accounts: LedgerAccount[];
  selectedIds: number[];
  onChange: (ids: number[]) => void;
  disabled?: boolean;
}

export function AccountMultiSelect({ accounts, selectedIds, onChange, disabled }: AccountMultiSelectProps) {
  const [open, setOpen] = useState(false);
  const selectedSet = new Set(selectedIds);
  const sorted = [...accounts].sort((a, b) => a.name.localeCompare(b.name));

  function toggle(id: number) {
    if (selectedSet.has(id)) onChange(selectedIds.filter((x) => x !== id));
    else onChange([...selectedIds, id]);
  }

  return (
    <div className="space-y-2">
      <Popover open={open} onOpenChange={disabled ? undefined : setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className="w-full justify-between font-normal"
            data-testid="select-accounts"
          >
            <span className="text-muted-foreground">
              {selectedIds.length === 0
                ? "Search and select accounts…"
                : `${selectedIds.length} account${selectedIds.length === 1 ? "" : "s"} selected`}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[560px] p-0" align="start">
          <Command>
            <CommandInput placeholder="Type account name or code…" />
            <CommandList className="max-h-80">
              <CommandEmpty>No accounts found.</CommandEmpty>
              <CommandGroup>
                {sorted.map((a) => {
                  const selected = selectedSet.has(a.id);
                  return (
                    <CommandItem
                      key={a.id}
                      value={`${a.code} ${a.name} ${a.accountType}`}
                      onSelect={() => toggle(a.id)}
                      className="flex items-center gap-2"
                    >
                      <div
                        className={cn(
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border",
                          selected ? "bg-primary border-primary" : "border-muted-foreground/40"
                        )}
                      >
                        {selected && <Check className="h-3 w-3 text-primary-foreground" />}
                      </div>
                      <span className="flex-1 truncate">{a.name}</span>
                      <Badge variant="secondary" className="text-xs shrink-0">
                        {a.accountType}
                      </Badge>
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            </CommandList>
          </Command>
          {selectedIds.length > 0 && (
            <div className="border-t p-2 flex justify-end">
              <Button
                size="sm"
                variant="ghost"
                className="text-xs text-muted-foreground"
                onClick={() => {
                  onChange([]);
                  setOpen(false);
                }}
              >
                Clear all
              </Button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {selectedIds.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selectedIds.map((id) => {
            const acc = accounts.find((a) => a.id === id);
            if (!acc) return null;
            return (
              <div key={id} className="flex items-center gap-1 px-2 py-1 rounded-md bg-muted text-sm max-w-[240px]">
                <span className="font-mono text-xs text-muted-foreground shrink-0">{acc.code}</span>
                <span className="truncate">{acc.name}</span>
                <button
                  onClick={() => toggle(id)}
                  className="ml-0.5 shrink-0 text-muted-foreground hover:text-foreground"
                  data-testid={`remove-account-${id}`}
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

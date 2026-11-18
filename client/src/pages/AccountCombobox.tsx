// Extracted from ./AccountTransfer.tsx to keep that module under the source-size cap.
import { searchAny } from "@shared/searchNormalization";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Check, Search, X } from "lucide-react";
import { formatUsd } from "@/lib/moneyDisplay";

export type Account = { id: number; name: string; code: string; accountType: string };

type Entry = {
  id: number;
  voucherId: number;
  narration: string | null;
  debitAmount: string;
  creditAmount: string;
  voucherNumber: string;
  voucherType: string;
  voucherDate: string;
  voucherDescription: string | null;
};

export type EntryPage = {
  items: Entry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

export const ENTRY_PAGE_SIZE = 100;

export function fmtMoney(v: string | number | null | undefined) {
  if (!v || v === "0" || v === "0.00") return null;
  return formatUsd(Number(v), 2);
}

export function AccountCombobox({
  accounts,
  value,
  onChange,
  placeholder,
  excludeId,
  testId,
}: {
  accounts: Account[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder: string;
  excludeId?: number | null;
  testId: string;
}) {
  const [search, setSearch] = useState("");
  const [open, setOpen] = useState(false);

  const filtered = useMemo(
    () =>
      accounts
        .filter((a) => a.id !== excludeId)
        .filter((a) => searchAny(search, a.name, a.code))
        .slice(0, 50),
    [accounts, search, excludeId]
  );

  const selected = accounts.find((a) => a.id === value);

  return (
    <div className="relative">
      <div
        className="flex items-center gap-2 border rounded-md px-3 py-2 cursor-pointer bg-background hover-elevate"
        onClick={() => setOpen((o) => !o)}
        data-testid={testId}
      >
        {selected ? (
          <span className="flex-1 text-sm font-medium truncate">
            {selected.name}
            <span className="ml-2 text-xs text-muted-foreground font-normal">{selected.code}</span>
          </span>
        ) : (
          <span className="flex-1 text-sm text-muted-foreground">{placeholder}</span>
        )}
        {selected && (
          <X
            className="h-4 w-4 text-muted-foreground shrink-0"
            onClick={(e) => {
              e.stopPropagation();
              onChange(null);
              setSearch("");
            }}
          />
        )}
      </div>
      {open && (
        <div className="absolute z-50 top-full mt-1 left-0 right-0 bg-popover border rounded-md shadow-md">
          <div className="p-2 border-b">
            <div className="flex items-center gap-2">
              <Search className="h-4 w-4 text-muted-foreground shrink-0" />
              <Input
                className="h-7 border-0 p-0 focus-visible:ring-0 text-sm"
                placeholder="Search accounts…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
                data-testid={`${testId}-search`}
              />
            </div>
          </div>
          <div className="max-h-60 overflow-y-auto">
            {filtered.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-4">No accounts found</p>
            )}
            {filtered.map((a) => (
              <div
                key={a.id}
                className="flex items-center gap-3 px-3 py-2 text-sm cursor-pointer hover-elevate"
                onClick={() => {
                  onChange(a.id);
                  setSearch("");
                  setOpen(false);
                }}
                data-testid={`${testId}-option-${a.id}`}
              >
                <span className="flex-1 font-medium truncate">{a.name}</span>
                <span className="text-xs text-muted-foreground">{a.code}</span>
                <Badge variant="outline" className="text-xs">
                  {a.accountType}
                </Badge>
                {a.id === value && <Check className="h-4 w-4 text-primary shrink-0" />}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

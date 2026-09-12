import type { ClientErrorLike } from "@/lib/clientError";
import { useDeferredValue, useState, useMemo } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useCompany } from "@/contexts/CompanyContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ArrowLeftRight, ArrowRight, Check, Search, X } from "lucide-react";
import { format } from "date-fns";
import { PageHeader } from "@/components/PageHeader";

type Account = { id: number; name: string; code: string; accountType: string };
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
type EntryPage = {
  items: Entry[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
};

const ENTRY_PAGE_SIZE = 100;

function fmtMoney(v: string | number | null | undefined) {
  if (!v || v === "0" || v === "0.00") return null;
  return Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function AccountCombobox({
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
        .filter(
          (a) =>
            a.name.toLowerCase().includes(search.toLowerCase()) || a.code.toLowerCase().includes(search.toLowerCase())
        )
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

export default function AccountTransfer() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();

  const [fromAccountId, setFromAccountId] = useState<number | null>(null);
  const [toAccountId, setToAccountId] = useState<number | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [searchEntries, setSearchEntries] = useState("");
  const [entryPage, setEntryPage] = useState(1);
  const [done, setDone] = useState<{ moved: number; toAccount: string } | null>(null);
  const deferredEntrySearch = useDeferredValue(searchEntries.trim());

  const { data: accounts = [] } = useQuery<Account[]>({
    queryKey: ["/api/ledger-accounts"],
    enabled: !!selectedCompany,
  });

  const { data: entryData, isLoading: loadingEntries } = useQuery<EntryPage>({
    queryKey: ["/api/voucher-entries/by-account", fromAccountId, entryPage, deferredEntrySearch],
    queryFn: async () => {
      const params = new URLSearchParams({
        pagination: "1",
        page: String(entryPage),
        pageSize: String(ENTRY_PAGE_SIZE),
      });
      if (deferredEntrySearch) params.set("search", deferredEntrySearch);
      const response = await fetch(`/api/voucher-entries/by-account/${fromAccountId}?${params}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error(response.statusText || String(response.status));
      return response.json();
    },
    enabled: !!fromAccountId,
  });
  const entries = useMemo(() => entryData?.items ?? [], [entryData?.items]);

  const filteredEntries = useMemo(() => {
    if (!searchEntries.trim()) return entries;
    const q = searchEntries.toLowerCase();
    return entries.filter(
      (e) =>
        e.voucherNumber?.toLowerCase().includes(q) ||
        e.narration?.toLowerCase().includes(q) ||
        e.voucherDescription?.toLowerCase().includes(q) ||
        e.voucherType?.toLowerCase().includes(q)
    );
  }, [entries, searchEntries]);

  const allChecked = filteredEntries.length > 0 && filteredEntries.every((e) => selectedIds.has(e.id));
  const someChecked = filteredEntries.some((e) => selectedIds.has(e.id));

  function toggleAll() {
    if (allChecked) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filteredEntries.forEach((e) => next.delete(e.id));
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        filteredEntries.forEach((e) => next.add(e.id));
        return next;
      });
    }
  }

  function toggleOne(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const selectedEntries = entries.filter((e) => selectedIds.has(e.id));
  const totalDebit = selectedEntries.reduce((s, e) => s + Number(e.debitAmount || 0), 0);
  const totalCredit = selectedEntries.reduce((s, e) => s + Number(e.creditAmount || 0), 0);

  const fromAccount = accounts.find((a) => a.id === fromAccountId);
  const toAccount = accounts.find((a) => a.id === toAccountId);

  const transfer = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/voucher-entries/transfer-account", {
        entryIds: Array.from(selectedIds),
        toAccountId,
      });
      return (await res.json()) as { moved: number; toAccount: string };
    },
    onSuccess: (data) => {
      setDone({ moved: data.moved, toAccount: data.toAccount });
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["/api/voucher-entries/by-account", fromAccountId] });
      queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
    },
    onError: (e: ClientErrorLike) =>
      toast({ title: "Transfer failed", description: e.message, variant: "destructive" }),
  });

  function resetAll() {
    setFromAccountId(null);
    setToAccountId(null);
    setSelectedIds(new Set());
    setSearchEntries("");
    setEntryPage(1);
    setDone(null);
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">
      <PageHeader
        title="Account Transfer"
        subtitle="Move voucher entries from one ledger account to another"
        icon={<ArrowLeftRight className="h-6 w-6" />}
      />

      {done && (
        <Card className="border-green-500/30 bg-green-500/5">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-full bg-green-500/10">
                  <Check className="h-5 w-5 text-green-600 dark:text-green-400" />
                </div>
                <div>
                  <p className="font-semibold text-green-700 dark:text-green-300">Transfer complete</p>
                  <p className="text-sm text-muted-foreground">
                    {done.moved} {done.moved === 1 ? "entry" : "entries"} moved to{" "}
                    <span className="font-medium">{done.toAccount}</span>
                  </p>
                </div>
              </div>
              <Button variant="outline" size="sm" onClick={resetAll} data-testid="button-transfer-again">
                Transfer again
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Source Account</CardTitle>
            <p className="text-sm text-muted-foreground">Entries will be moved away from this account</p>
          </CardHeader>
          <CardContent>
            <AccountCombobox
              accounts={accounts}
              value={fromAccountId}
              onChange={(id) => {
                setFromAccountId(id);
                setSelectedIds(new Set());
                setEntryPage(1);
                setSearchEntries("");
                setDone(null);
              }}
              placeholder="Select source account…"
              excludeId={toAccountId}
              testId="combobox-from-account"
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">Destination Account</CardTitle>
            <p className="text-sm text-muted-foreground">Selected entries will be re-assigned here</p>
          </CardHeader>
          <CardContent>
            <AccountCombobox
              accounts={accounts}
              value={toAccountId}
              onChange={(id) => {
                setToAccountId(id);
                setDone(null);
              }}
              placeholder="Select destination account…"
              excludeId={fromAccountId}
              testId="combobox-to-account"
            />
          </CardContent>
        </Card>
      </div>

      {fromAccountId && (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <CardTitle className="text-base">
                  Entries under <span className="text-primary">{fromAccount?.name}</span>
                  {!loadingEntries && (
                    <Badge variant="secondary" className="ml-2">
                      {entryData?.total ?? entries.length}
                    </Badge>
                  )}
                </CardTitle>
                <p className="text-sm text-muted-foreground mt-0.5">Select which entries to transfer</p>
              </div>
              <div className="flex items-center gap-2">
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    className="pl-8 h-8 text-sm w-52"
                    placeholder="Filter entries…"
                    value={searchEntries}
                    onChange={(e) => {
                      setSearchEntries(e.target.value);
                      setEntryPage(1);
                      setSelectedIds(new Set());
                    }}
                    data-testid="input-search-entries"
                  />
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {loadingEntries ? (
              <div className="text-center py-10 text-muted-foreground text-sm">Loading entries…</div>
            ) : entries.length === 0 ? (
              <div className="text-center py-10 text-muted-foreground text-sm">No entries found for this account</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="px-4 py-2 text-left w-10">
                        <Checkbox
                          checked={allChecked}
                          onCheckedChange={toggleAll}
                          data-testid="checkbox-select-all"
                          ref={(el) => {
                            if (el)
                              (el as unknown as HTMLButtonElement & { indeterminate: boolean }).indeterminate =
                                someChecked && !allChecked;
                          }}
                        />
                      </th>
                      <th className="px-3 py-2 text-left font-semibold text-xs uppercase tracking-wide">Voucher #</th>
                      <th className="px-3 py-2 text-left font-semibold text-xs uppercase tracking-wide">Date</th>
                      <th className="px-3 py-2 text-left font-semibold text-xs uppercase tracking-wide">Type</th>
                      <th className="px-3 py-2 text-left font-semibold text-xs uppercase tracking-wide">
                        Description / Narration
                      </th>
                      <th className="px-3 py-2 text-right font-semibold text-xs uppercase tracking-wide">Debit</th>
                      <th className="px-3 py-2 text-right font-semibold text-xs uppercase tracking-wide">Credit</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredEntries.map((e) => {
                      const checked = selectedIds.has(e.id);
                      const label = e.narration || e.voucherDescription || "—";
                      const dr = fmtMoney(e.debitAmount);
                      const cr = fmtMoney(e.creditAmount);
                      return (
                        <tr
                          key={e.id}
                          className={`border-t cursor-pointer hover-elevate ${checked ? "bg-primary/5" : ""}`}
                          onClick={() => toggleOne(e.id)}
                          data-testid={`row-entry-${e.id}`}
                        >
                          <td className="px-4 py-2" onClick={(ev) => ev.stopPropagation()}>
                            <Checkbox
                              checked={checked}
                              onCheckedChange={() => toggleOne(e.id)}
                              data-testid={`checkbox-entry-${e.id}`}
                            />
                          </td>
                          <td className="px-3 py-2 font-mono text-xs">{e.voucherNumber}</td>
                          <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">
                            {e.voucherDate ? format(new Date(e.voucherDate), "dd MMM yyyy") : "—"}
                          </td>
                          <td className="px-3 py-2">
                            <Badge variant="outline" className="text-xs">
                              {e.voucherType}
                            </Badge>
                          </td>
                          <td className="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate" title={label}>
                            {label}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-xs">
                            {dr ? (
                              <span className="font-medium">${dr}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums text-xs">
                            {cr ? (
                              <span className="font-medium">${cr}</span>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {entryData && entryData.totalPages > 1 && (
                  <div className="flex items-center justify-between gap-3 border-t px-4 py-3">
                    <p className="text-xs text-muted-foreground">
                      Page {entryData.page} of {entryData.totalPages} · {entryData.total} entries
                    </p>
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!entryData.hasPreviousPage}
                        onClick={() => {
                          setSelectedIds(new Set());
                          setEntryPage((page) => Math.max(1, page - 1));
                        }}
                        data-testid="button-entries-previous-page"
                      >
                        Previous
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!entryData.hasNextPage}
                        onClick={() => {
                          setSelectedIds(new Set());
                          setEntryPage((page) => page + 1);
                        }}
                        data-testid="button-entries-next-page"
                      >
                        Next
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {selectedIds.size > 0 && (
        <Card className="border-primary/20 bg-primary/5">
          <CardContent className="pt-4">
            <div className="flex items-center justify-between flex-wrap gap-4">
              <div className="space-y-1">
                <p className="text-sm font-semibold">
                  {selectedIds.size} {selectedIds.size === 1 ? "entry" : "entries"} selected
                </p>
                <div className="flex items-center gap-4 text-xs text-muted-foreground">
                  {totalDebit > 0 && (
                    <span>
                      Debit:{" "}
                      <span className="font-medium text-foreground">
                        ${totalDebit.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </span>
                    </span>
                  )}
                  {totalCredit > 0 && (
                    <span>
                      Credit:{" "}
                      <span className="font-medium text-foreground">
                        ${totalCredit.toLocaleString("en-US", { minimumFractionDigits: 2 })}
                      </span>
                    </span>
                  )}
                </div>
                {fromAccount && toAccount && (
                  <div className="flex items-center gap-2 text-xs mt-1">
                    <span className="font-medium text-foreground">{fromAccount.name}</span>
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                    <span className="font-medium text-foreground">{toAccount.name}</span>
                  </div>
                )}
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setSelectedIds(new Set())}
                  data-testid="button-clear-selection"
                >
                  Clear selection
                </Button>
                <Button
                  size="sm"
                  onClick={() => transfer.mutate()}
                  disabled={!toAccountId || transfer.isPending}
                  data-testid="button-execute-transfer"
                >
                  <ArrowLeftRight className="h-4 w-4 mr-1.5" />
                  {transfer.isPending
                    ? "Transferring…"
                    : !toAccountId
                      ? "Choose destination first"
                      : `Transfer ${selectedIds.size} ${selectedIds.size === 1 ? "entry" : "entries"}`}
                </Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

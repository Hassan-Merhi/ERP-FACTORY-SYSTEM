import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { PageHeader } from "@/components/PageHeader";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import {
  ArrowRight,
  BookOpen,
  CheckCircle,
  ChevronsUpDown,
  Check,
  Undo2,
  X,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { Company, LedgerAccount } from "@shared/schema";

interface AccountPreviewItem {
  account: LedgerAccount;
  entryCount: number;
  totalDebit: number;
  totalCredit: number;
  touchedVoucherCount: number;
  exclusiveVoucherCount: number;
  sharedVoucherCount: number;
  codeConflict: { id: number; name: string } | null;
}

interface PreviewResult {
  accounts: AccountPreviewItem[];
  srcCompany: Company;
  destCompany: Company;
  grandTotalEntries: number;
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

interface ExecuteResult {
  success: boolean;
  srcCompanyId: number;
  destCompanyId: number;
  totalEntries: number;
  movedVoucherIds: number[];
  movedVoucherCount: number;
  sharedVoucherCount: number;
  accounts: ExecuteAccountResult[];
}

function fmt(n: number) {
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function CompanyBadge({ company }: { company?: Company }) {
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
    <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${typeColors[company.companyType] ?? typeColors.erp}`}>
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

function AccountMultiSelect({ accounts, selectedIds, onChange, disabled }: AccountMultiSelectProps) {
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
                          "flex h-4 w-4 shrink-0 items-center justify-center rounded border",
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

function AccountPreviewRow({ item }: { item: AccountPreviewItem }) {
  const [expanded, setExpanded] = useState(false);
  const ob = parseFloat(item.account.openingBalance || "0");
  return (
    <div className="rounded-md border">
      <button
        className="w-full flex items-center justify-between gap-2 p-3 text-left hover-elevate"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="font-medium truncate">{item.account.name}</span>
          <span className="font-mono text-xs text-muted-foreground shrink-0">{item.account.code}</span>
          {item.codeConflict && (
            <Badge
              variant="outline"
              className="text-xs text-amber-700 border-amber-300 dark:text-amber-300 dark:border-amber-700 shrink-0"
            >
              Renamed
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs text-muted-foreground">{item.entryCount} entries</span>
          {expanded ? (
            <ChevronUp className="h-4 w-4 text-muted-foreground" />
          ) : (
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          )}
        </div>
      </button>
      {expanded && (
        <div className="px-3 pb-3 space-y-2 border-t pt-3">
          <div className="grid grid-cols-3 gap-2 text-sm">
            <div>
              <p className="text-xs text-muted-foreground">Debits</p>
              <p className="font-mono font-medium">{fmt(item.totalDebit)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Credits</p>
              <p className="font-mono font-medium">{fmt(item.totalCredit)}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Opening balance</p>
              <p className="font-mono font-medium">
                {ob !== 0 ? `${fmt(ob)} ${item.account.openingBalanceSide}` : "—"}
              </p>
            </div>
          </div>
          {item.touchedVoucherCount > 0 && (
            <p className="text-xs text-muted-foreground">
              {item.exclusiveVoucherCount} voucher{item.exclusiveVoucherCount !== 1 ? "s" : ""} will move
              {item.sharedVoucherCount > 0 && `, ${item.sharedVoucherCount} shared (stay in source)`}
            </p>
          )}
          {item.codeConflict && (
            <p className="text-xs text-amber-700 dark:text-amber-300">
              Code <span className="font-mono">{item.account.code}</span> conflicts with existing account "
              {item.codeConflict.name}" — will be renamed to{" "}
              <span className="font-mono">{item.account.code}-MIGRATED</span>
            </p>
          )}
        </div>
      )}
    </div>
  );
}

export default function AccountMigration() {
  const { toast } = useToast();

  const [srcCompanyId, setSrcCompanyId] = useState<string>("");
  const [destCompanyId, setDestCompanyId] = useState<string>("");
  const [selectedAccountIds, setSelectedAccountIds] = useState<number[]>([]);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [undoConfirmOpen, setUndoConfirmOpen] = useState(false);
  const [lastResult, setLastResult] = useState<ExecuteResult | null>(null);
  const [undoDone, setUndoDone] = useState(false);

  const {
    data: companies = [],
    isLoading: loadingCompanies,
    isError: companiesError,
    refetch: refetchCompanies,
  } = useQuery<Company[]>({
    queryKey: ["/api/admin/account-migration/companies"],
    queryFn: async () => {
      const res = await fetch("/api/admin/account-migration/companies", {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to load companies (${res.status})`);
      }
      const body = await res.json();
      return Array.isArray(body) ? body : Array.isArray(body?.companies) ? body.companies : [];
    },
    staleTime: 0,
  });

  const {
    data: srcAccounts = [],
    isLoading: loadingSrcAccounts,
    isError: srcAccountsError,
    error: srcAccountsQueryError,
    refetch: refetchSrcAccounts,
  } = useQuery<LedgerAccount[]>({
    queryKey: ["/api/admin/account-migration/accounts", srcCompanyId],
    queryFn: async () => {
      const res = await fetch(
        `/api/ledger-accounts?companyId=${encodeURIComponent(srcCompanyId)}&includeHidden=true`,
        {
          credentials: "include",
          cache: "no-store",
        }
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.message || `Failed to load accounts (${res.status})`);
      }
      const body = await res.json();
      return Array.isArray(body) ? body : Array.isArray(body?.accounts) ? body.accounts : [];
    },
    enabled: !!srcCompanyId,
  });

  const previewMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/account-migration/preview", {
        accountIds: selectedAccountIds,
        srcCompanyId: parseInt(srcCompanyId),
        destCompanyId: parseInt(destCompanyId),
      });
      return res.json() as Promise<PreviewResult>;
    },
    onSuccess: (data) => setPreview(data),
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      toast({ title: "Preview failed", description: err.message, variant: "destructive" });
    },
  });

  const executeMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest("POST", "/api/admin/account-migration/execute", {
        accountIds: selectedAccountIds,
        srcCompanyId: parseInt(srcCompanyId),
        destCompanyId: parseInt(destCompanyId),
      });
      return res.json() as Promise<ExecuteResult>;
    },
    onSuccess: (data) => {
      setLastResult(data);
      setUndoDone(false);
      setConfirmOpen(false);
      setPreview(null);
      setSelectedAccountIds([]);
      setSrcCompanyId("");
      setDestCompanyId("");
      const count = data.accounts.length;
      toast({
        title: "Migration complete",
        description: `${count} account${count === 1 ? "" : "s"} moved with ${data.totalEntries} entries.`,
      });
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      setConfirmOpen(false);
      toast({ title: "Migration failed", description: err.message, variant: "destructive" });
    },
  });

  const undoMutation = useMutation({
    mutationFn: async () => {
      if (!lastResult) throw new Error("Nothing to undo");
      const res = await apiRequest("POST", "/api/admin/account-migration/undo", {
        accounts: lastResult.accounts.map((a) => ({
          accountId: a.accountId,
          originalCode: a.originalCode,
        })),
        movedVoucherIds: lastResult.movedVoucherIds,
        srcCompanyId: lastResult.srcCompanyId,
        destCompanyId: lastResult.destCompanyId,
      });
      return res.json();
    },
    onSuccess: () => {
      setUndoConfirmOpen(false);
      setUndoDone(true);
      toast({
        title: "Migration undone",
        description: `${lastResult?.accounts.length} account${lastResult?.accounts.length === 1 ? "" : "s"} moved back to the original company.`,
      });
    },
    onError: (err: Error) => {
      if ((err as { _handledGlobally?: boolean })?._handledGlobally) return;
      setUndoConfirmOpen(false);
      toast({ title: "Undo failed", description: err.message, variant: "destructive" });
    },
  });

  const srcCompany = companies.find((c) => String(c.id) === srcCompanyId);
  const destCompany = companies.find((c) => String(c.id) === destCompanyId);
  const canPreview =
    !!srcCompanyId && !!destCompanyId && selectedAccountIds.length > 0 && srcCompanyId !== destCompanyId;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Account Migration"
        subtitle="Move one or more ledger accounts with their complete statement history to another company"
      />

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
              1
            </span>
            Source — pick company and accounts
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium">Source company</label>
            {loadingCompanies ? (
              <Skeleton className="h-10 w-full" />
            ) : companiesError ? (
              <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p className="font-medium text-destructive">Companies could not be loaded.</p>
                <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => refetchCompanies()}>
                  Retry
                </Button>
              </div>
            ) : (
              <Select
                value={srcCompanyId}
                onValueChange={(v) => {
                  setSrcCompanyId(v);
                  setSelectedAccountIds([]);
                  setPreview(null);
                }}
              >
                <SelectTrigger data-testid="select-source-company">
                  <SelectValue placeholder="Select company..." />
                </SelectTrigger>
                <SelectContent>
                  {companies.map((company) => (
                    <SelectItem
                      key={company.id}
                      value={String(company.id)}
                      disabled={String(company.id) === destCompanyId}
                    >
                      <div className="flex items-center gap-2">
                        <span>{company.name}</span>
                        <CompanyBadge company={company} />
                      </div>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>

          {srcCompanyId && (
            <div className="space-y-2">
              <label className="text-sm font-medium">Accounts</label>
              {loadingSrcAccounts ? (
                <Skeleton className="h-10 w-full" />
              ) : srcAccountsError ? (
                <div className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
                  <p className="font-medium text-destructive">Accounts could not be loaded.</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {srcAccountsQueryError instanceof Error
                      ? srcAccountsQueryError.message
                      : "The source company accounts request failed."}
                  </p>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="mt-2"
                    onClick={() => refetchSrcAccounts()}
                  >
                    Retry
                  </Button>
                </div>
              ) : (
                <AccountMultiSelect
                  accounts={srcAccounts}
                  selectedIds={selectedAccountIds}
                  onChange={(ids) => {
                    setSelectedAccountIds(ids);
                    setPreview(null);
                  }}
                />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary text-xs text-primary-foreground">
              2
            </span>
            Destination company
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loadingCompanies ? (
            <Skeleton className="h-10 w-full" />
          ) : (
            <Select
              value={destCompanyId}
              onValueChange={(v) => {
                setDestCompanyId(v);
                setPreview(null);
              }}
            >
              <SelectTrigger data-testid="select-destination-company">
                <SelectValue placeholder="Select destination company..." />
              </SelectTrigger>
              <SelectContent>
                {companies.map((company) => (
                  <SelectItem
                    key={company.id}
                    value={String(company.id)}
                    disabled={String(company.id) === srcCompanyId}
                  >
                    <div className="flex items-center gap-2">
                      <span>{company.name}</span>
                      <CompanyBadge company={company} />
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </CardContent>
      </Card>

      <Button
        className="w-full"
        disabled={!canPreview || previewMutation.isPending}
        onClick={() => previewMutation.mutate()}
      >
        {previewMutation.isPending ? "Preparing preview..." : "Preview migration"}
      </Button>

      {preview && (
        <Card>
          <CardHeader>
            <CardTitle>Migration preview</CardTitle>
            <CardDescription>
              {srcCompany?.name} <ArrowRight className="inline h-3 w-3" /> {destCompany?.name}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 md:grid-cols-3">
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Accounts</p>
                <p className="text-xl font-semibold">{preview.accounts.length}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Entries</p>
                <p className="text-xl font-semibold">{preview.grandTotalEntries}</p>
              </div>
              <div className="rounded-md border p-3">
                <p className="text-xs text-muted-foreground">Net</p>
                <p className="text-xl font-semibold font-mono">
                  {fmt(preview.grandTotalDebit - preview.grandTotalCredit)}
                </p>
              </div>
            </div>
            <div className="space-y-2">
              {preview.accounts.map((item) => (
                <AccountPreviewRow key={item.account.id} item={item} />
              ))}
            </div>
            <Button className="w-full" variant="destructive" onClick={() => setConfirmOpen(true)}>
              Execute migration
            </Button>
          </CardContent>
        </Card>
      )}

      {lastResult && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <CheckCircle className="h-5 w-5" /> Migration complete
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {lastResult.accounts.length} account{lastResult.accounts.length === 1 ? "" : "s"} and{" "}
              {lastResult.totalEntries} entries were moved.
            </p>
            {!undoDone && (
              <Button variant="outline" onClick={() => setUndoConfirmOpen(true)}>
                <Undo2 className="mr-2 h-4 w-4" /> Undo migration
              </Button>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Confirm account migration</DialogTitle>
            <DialogDescription>
              This will move {selectedAccountIds.length} account{selectedAccountIds.length === 1 ? "" : "s"} from{" "}
              {srcCompany?.name} to {destCompany?.name}.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={executeMutation.isPending} onClick={() => executeMutation.mutate()}>
              {executeMutation.isPending ? "Migrating..." : "Confirm migration"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={undoConfirmOpen} onOpenChange={setUndoConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Undo migration?</DialogTitle>
            <DialogDescription>
              This moves the migrated accounts and vouchers back to the original company.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setUndoConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={undoMutation.isPending} onClick={() => undoMutation.mutate()}>
              {undoMutation.isPending ? "Undoing..." : "Undo migration"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

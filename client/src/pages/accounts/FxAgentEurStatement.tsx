import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Clock, FileDown, FileSpreadsheet, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { Skeleton } from "@/components/ui/skeleton";
import { Card, CardContent } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { PeriodFilterValue } from "@/components/ui/period-filter";

interface EurOperation {
  id: number;
  date: string;
  kind: string;
  description: string;
  detail: string;
  eurIn: string;
  eurOut: string;
  balance: string;
  rateUsdPerEur: string;
  voucherId: number | null;
  deleted?: boolean;
}
interface EurStatement {
  accountName: string;
  activatedOn: string;
  fromDate: string | null;
  toDate: string;
  openingEur: string;
  totalEurIn: string;
  totalEurOut: string;
  closingEur: string;
  rows: EurOperation[];
}

const eur = (amount: string) =>
  Number(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  });

export function fxEurStatementUrl(walletId: number, period: PeriodFilterValue, extension = "", showDeleted = false) {
  const params = new URLSearchParams();
  if (period.fromDate) params.set("startDate", period.fromDate);
  if (period.toDate) params.set("endDate", period.toDate);
  if (showDeleted) params.set("showDeleted", "true");
  return "/api/factory/fx-agent-wallets/" + walletId + "/statement" + extension + "?" + params.toString();
}

/** Native EUR operations only; historical USD GL is shown in the other tab. */
export function FxAgentEurStatement({
  walletId,
  periodFilter,
  hideBalances,
}: {
  walletId: number;
  periodFilter: PeriodFilterValue;
  hideBalances: boolean;
}) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [showDeleted, setShowDeleted] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reverseId, setReverseId] = useState<number | null>(null);
  const [reverseReason, setReverseReason] = useState("");

  const { data, isPending, error } = useQuery<EurStatement>({
    queryKey: ["fx-agent-eur-statement", selectedCompany?.id, walletId, periodFilter.fromDate || null, periodFilter.toDate || null, showDeleted],
    queryFn: async () => {
      const response = await fetch(fxEurStatementUrl(walletId, periodFilter, "", showDeleted), { credentials: "include" });
      if (!response.ok) {
        const issue = await response.json().catch(() => null);
        throw new Error(issue?.message || "Could not load EUR movements");
      }
      return response.json();
    },
    enabled: walletId > 0 && !!selectedCompany?.id,
    staleTime: 0,
  });

  const selectable = useMemo(() =>
    (data?.rows || []).filter(op => op.kind === "EUR_SETTLEMENT" && !op.deleted && op.voucherId != null),
    [data?.rows]
  );
  const selectedPayments = selectable.filter(op => selectedIds.has(op.id));
  const allSelected = selectable.length > 0 && selectedPayments.length === selectable.length;
  const toggle = (id: number) => setSelectedIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  const invalidateFx = () => {
    queryClient.invalidateQueries({ queryKey: ["fx-agent-eur-statement"] });
    queryClient.invalidateQueries({ queryKey: ["/api/factory/fx-agent-wallets"] });
    queryClient.invalidateQueries({ queryKey: ["/api/factory/net-position"] });
    queryClient.invalidateQueries({ queryKey: ["/api/accounts/all"] });
    queryClient.invalidateQueries({ queryKey: ["/api/ledger-accounts"] });
    queryClient.invalidateQueries({ queryKey: ["account-statement"] });
    queryClient.invalidateQueries({ queryKey: ["/api/vouchers"] });
    queryClient.invalidateQueries({ queryKey: ["/api/factory/daybook"] });
    setSelectedIds(new Set());
  };
  const deleteMutation = useMutation({
    // FX EUR payment vouchers must be deleted individually: the generic bulk
    // endpoint deliberately rejects wallet-linked vouchers.
    mutationFn: async (voucherIds: number[]) => {
      let deleted = 0;
      for (const id of voucherIds) {
        try {
          await apiRequest("DELETE", "/api/vouchers/" + id);
          deleted++;
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          throw new Error(deleted + " of " + voucherIds.length + " payment(s) deleted. " + message);
        }
      }
      return deleted;
    },
    onSuccess: count => toast({ title: count + " EUR payment(s) deleted", description: "EUR restored; linked USD postings and FX gain/loss reversed." }),
    onError: (error: Error) => toast({ title: "EUR payment deletion failed", description: error.message, variant: "destructive" }),
    onSettled: () => { invalidateFx(); setConfirmDelete(false); },
  });
  const reverseMutation = useMutation({
    mutationFn: async (params: { conversionId: number; reason: string }) =>
      apiRequest("POST", "/api/factory/fx-agent-wallets/" + walletId + "/reverse-conversion", {
        conversionId: params.conversionId, reason: params.reason,
        requestKey: "eur-ledger-reverse-" + params.conversionId + "-" + Date.now(),
      }),
    onSuccess: () => {
      toast({ title: "EUR conversion reversed", description: "Original USD basis restored to the wallet." });
      invalidateFx(); setReverseId(null); setReverseReason("");
    },
    onError: (error: Error) => toast({ title: "Conversion reversal failed", description: error.message, variant: "destructive" }),
  });

  if (isPending) return <Skeleton className="h-44 w-full" />;
  if (error) return <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">{error.message}</div>;
  if (!data) return null;

  const format = (amount: string) => hideBalances ? "••••" : "EUR " + eur(amount);
  const operations = data.rows;
  const exportUrl = (extension: string) => fxEurStatementUrl(walletId, periodFilter, extension, showDeleted);

  return (
    <section className="space-y-3" data-testid="fx-agent-eur-statement">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="font-semibold text-sm">EUR Transactions</h4>
          <p className="text-xs text-muted-foreground">Native EUR conversions and payments. Historical USD vouchers stay in the USD tab.</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-muted-foreground">{data.fromDate || data.activatedOn} — {data.toDate}</span>
          {selectedPayments.length > 0 && (
            <Button size="sm" variant="destructive" disabled={deleteMutation.isPending} onClick={() => setConfirmDelete(true)} data-testid="fx-agent-eur-delete-selected">
              <Trash2 className="w-4 h-4 mr-1" /> Delete Selected ({selectedPayments.length})
            </Button>
          )}
          <Button size="sm" variant={showDeleted ? "secondary" : "outline"} onClick={() => { setShowDeleted(v => !v); setSelectedIds(new Set()); }} data-testid="fx-agent-eur-show-deleted">
            <Clock className="w-4 h-4 mr-1" /> {showDeleted ? "Hide Deleted" : "Show Deleted"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.open(exportUrl(".pdf"), "_blank")} data-testid="fx-agent-export-eur-pdf">
            <FileDown className="w-4 h-4 mr-1" /> EUR PDF
          </Button>
          <Button size="sm" variant="outline" onClick={() => window.open(exportUrl(".xlsx"), "_blank")} data-testid="fx-agent-export-eur-excel">
            <FileSpreadsheet className="w-4 h-4 mr-1" /> EUR Excel
          </Button>
        </div>
      </div>

      {!hideBalances && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="fx-agent-eur-summary">
          {([
            ["Transactions", String(operations.filter(op => !op.deleted).length)],
            ["EUR Debit", data.totalEurIn],
            ["EUR Credit", data.totalEurOut],
            ["EUR Closing", data.closingEur],
          ] as const).map(([label, amount]) => (
            <Card key={label} className="bg-muted/20">
              <CardContent className="p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="font-mono text-base font-semibold tabular-nums">{label === "Transactions" ? amount : format(amount)}</p>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="rounded-xl border overflow-auto max-h-[70vh] hidden md:block" data-testid="fx-agent-eur-scroll-region">
        <Table>
          <TableHeader className="sticky top-0 z-10 bg-background">
            <TableRow className="bg-muted/40 hover:bg-muted/40">
              <TableHead className="w-[40px]"><Checkbox aria-label="Select all EUR payments" checked={allSelected} disabled={selectable.length === 0} onCheckedChange={() => setSelectedIds(allSelected ? new Set() : new Set(selectable.map(op => op.id)))} data-testid="fx-agent-eur-select-all" /></TableHead>
              <TableHead className="w-[110px] text-xs uppercase">Date</TableHead>
              <TableHead className="text-xs uppercase">Particulars</TableHead>
              <TableHead className="text-xs uppercase">Notes</TableHead>
              {!hideBalances && <TableHead className="text-right text-xs uppercase">Debit</TableHead>}
              {!hideBalances && <TableHead className="text-right text-xs uppercase">Credit</TableHead>}
              {!hideBalances && <TableHead className="text-right text-xs uppercase">Balance</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow className="bg-accent/20" data-testid="fx-agent-eur-opening">
              <TableCell />
              <TableCell colSpan={3} className="font-semibold text-sm">Opening Balance</TableCell>
              {!hideBalances && <><TableCell /><TableCell /><TableCell className="text-right font-mono font-semibold">{format(data.openingEur)}</TableCell></>}
            </TableRow>
            {operations.map(op => {
              const canDelete = op.kind === "EUR_SETTLEMENT" && !op.deleted && op.voucherId != null;
              const canReverse = op.kind === "USD_TO_EUR" && !op.deleted;
              return (
                <TableRow key={op.id} className={op.deleted ? "opacity-55" : undefined} data-testid={"fx-agent-eur-operation-" + op.id}>
                  <TableCell>
                    {canDelete && <Checkbox checked={selectedIds.has(op.id)} onCheckedChange={() => toggle(op.id)} aria-label={"Select EUR payment " + op.id} />}
                  </TableCell>
                  <TableCell className="whitespace-nowrap font-mono text-xs">{op.date}</TableCell>
                  <TableCell className={"font-medium text-sm " + (op.deleted ? "line-through" : "")}>
                    {op.description}
                    <p className="text-xs text-muted-foreground">{op.kind === "EUR_SETTLEMENT" ? "Payment" : op.kind === "USD_TO_EUR" ? "Conversion" : "Reversal"}</p>
                    {canReverse && <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" onClick={() => { setReverseReason(""); setReverseId(op.id); }} data-testid={"fx-agent-eur-reverse-" + op.id}><RotateCcw className="w-3 h-3 mr-1" /> Reverse conversion</Button>}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {op.detail && <div className="max-w-[380px] break-words">{op.detail}</div>}
                    <div>USD/EUR {Number(op.rateUsdPerEur).toFixed(4)}{op.voucherId ? " · Voucher #" + op.voucherId : ""}</div>
                    {op.deleted && <span className="font-semibold">Deleted · Excluded from balances</span>}
                  </TableCell>
                  {!hideBalances && <TableCell className="text-right font-mono whitespace-nowrap">{Number(op.eurIn) > 0 ? format(op.eurIn) : "—"}</TableCell>}
                  {!hideBalances && <TableCell className="text-right font-mono whitespace-nowrap">{Number(op.eurOut) > 0 ? format(op.eurOut) : "—"}</TableCell>}
                  {!hideBalances && <TableCell className="text-right font-mono font-semibold whitespace-nowrap">{op.deleted ? "—" : format(op.balance)}</TableCell>}
                </TableRow>
              );
            })}
            {operations.length === 0 && <TableRow><TableCell colSpan={hideBalances ? 4 : 7} className="text-center py-6 text-sm text-muted-foreground">No EUR transactions in this period.</TableCell></TableRow>}
            <TableRow className="bg-muted/50 font-semibold">
              <TableCell />
              <TableCell colSpan={3}>Closing Balance</TableCell>
              {!hideBalances && <>
                <TableCell className="text-right font-mono">{format(data.totalEurIn)}</TableCell>
                <TableCell className="text-right font-mono">{format(data.totalEurOut)}</TableCell>
                <TableCell className="text-right font-mono">{format(data.closingEur)}</TableCell>
              </>}
            </TableRow>
          </TableBody>
        </Table>
      </div>

      <div className="space-y-2 md:hidden" data-testid="fx-agent-eur-mobile-rows">
        <div className="rounded-lg border bg-muted/20 p-3 flex items-center justify-between text-sm">
          <span>Opening Balance</span><span className="font-mono font-semibold">{format(data.openingEur)}</span>
        </div>
        {operations.map(op => {
          const canDelete = op.kind === "EUR_SETTLEMENT" && !op.deleted && op.voucherId != null;
          return (
            <div key={op.id} className={"rounded-lg border p-3 space-y-2 text-sm " + (op.deleted ? "opacity-55" : "")}>
              <div className="flex items-start gap-2">
                {canDelete && <Checkbox checked={selectedIds.has(op.id)} onCheckedChange={() => toggle(op.id)} aria-label={"Select EUR payment " + op.id} />}
                <div className="flex-1">
                  <p className="text-xs text-muted-foreground">{op.date} · {op.kind === "EUR_SETTLEMENT" ? "Payment" : op.kind === "USD_TO_EUR" ? "Conversion" : "Reversal"}</p>
                  <p className="font-medium">{op.description}</p>
                </div>
                {op.kind === "USD_TO_EUR" && <Button size="sm" variant="outline" onClick={() => { setReverseReason(""); setReverseId(op.id); }}><RotateCcw className="w-4 h-4" /></Button>}
              </div>
              {op.detail && <p className="text-xs text-muted-foreground">{op.detail}</p>}
              <p className="text-xs text-muted-foreground">USD/EUR {Number(op.rateUsdPerEur).toFixed(4)}{op.voucherId ? " · Voucher #" + op.voucherId : ""}</p>
              {op.deleted && <p className="text-xs font-semibold">Deleted · Excluded from balances</p>}
              {!hideBalances && <div className="flex justify-between font-mono text-xs">
                <span>{Number(op.eurIn) > 0 ? "+ " + format(op.eurIn) : "− " + format(op.eurOut)}</span>
                <span className="font-semibold">{op.deleted ? "—" : format(op.balance)}</span>
              </div>}
            </div>
          );
        })}
        {operations.length === 0 && <p className="py-4 text-center text-sm text-muted-foreground">No EUR transactions in this period.</p>}
      </div>
      <p className="text-xs text-muted-foreground">Native EUR is not additional USD cash. Deleted payments are retained in the audit log and excluded from balances.</p>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {selectedPayments.length} EUR payment(s)?</AlertDialogTitle>
            <AlertDialogDescription>
              This cancels each linked payment voucher, restores its exact EUR amount to the FX wallet and removes its USD and FX gain/loss from active balances. The deleted payment remains in the audit trail. Conversions must be reversed separately.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-destructive text-destructive-foreground hover:bg-destructive/90" disabled={deleteMutation.isPending || selectedPayments.length === 0} onClick={event => { event.preventDefault(); deleteMutation.mutate(selectedPayments.map(op => op.voucherId!)); }} data-testid="fx-agent-eur-confirm-delete">
              {deleteMutation.isPending ? "Deleting..." : "Delete Payments"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={reverseId != null} onOpenChange={open => { if (!open && !reverseMutation.isPending) { setReverseId(null); setReverseReason(""); } }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse EUR conversion</DialogTitle>
            <DialogDescription>Restores the original USD amount and deducts the matching EUR. A conversion cannot be reversed after any later EUR settlement.</DialogDescription>
          </DialogHeader>
          <Textarea value={reverseReason} onChange={event => setReverseReason(event.target.value)} maxLength={500} placeholder="Reason for reversing this conversion" data-testid="fx-agent-eur-reverse-reason" />
          <DialogFooter>
            <Button variant="outline" disabled={reverseMutation.isPending} onClick={() => setReverseId(null)}>Cancel</Button>
            <Button disabled={reverseMutation.isPending || !reverseReason.trim() || reverseId == null} onClick={() => { if (reverseId != null) reverseMutation.mutate({ conversionId: reverseId, reason: reverseReason.trim() }); }} data-testid="fx-agent-eur-confirm-reverse">
              {reverseMutation.isPending ? "Reversing..." : "Reverse Conversion"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

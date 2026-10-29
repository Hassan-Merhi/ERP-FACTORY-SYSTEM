import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Banknote, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { localDateStr } from "../factoryProductionTargetsModel";

type Account = { id: number; name: string; code: string; accountType: string; openingCurrency: string | null };
type PaymentRow = {
  reviewId: number;
  date: string;
  workerId: number;
  workerName: string;
  decisionStatus: "approved" | "rejected";
  approvedAmount: string;
  paymentId: number | null;
  paymentStatus: "POSTED" | "REVERSED" | null;
  paymentDate: string | null;
  cashAccountId: number | null;
  cashAccountName: string | null;
  voucherId: number | null;
  reversalVoucherId: number | null;
};
type PaymentSummary = { payments: PaymentRow[]; start: string; end: string };
type AccountResponse = { accounts: Account[]; currency: string };
type PostResult = { posted: number; replayed: number };

async function api<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  const response = await factoryApiRequest(method, path, body);
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || "Bonus payment request failed");
  return result as T;
}
const fmtAmount = (amount: string | number) =>
  Number(amount).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** Separate financial confirmation from the Phase 4 approve/reject workflow. */
export function ProductionTargetBonusPaymentsPanel({ initialDate }: { initialDate: string }) {
  const { toast } = useToast();
  const [start, setStart] = useState(initialDate);
  const [end, setEnd] = useState(initialDate);
  const [selected, setSelected] = useState<number[]>([]);
  const [accountId, setAccountId] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => localDateStr(new Date()));
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reverseRow, setReverseRow] = useState<PaymentRow | null>(null);
  const [reversalDate, setReversalDate] = useState(() => localDateStr(new Date()));
  const [reversalReason, setReversalReason] = useState("");

  useEffect(() => {
    setStart(initialDate);
    setEnd(initialDate);
    setSelected([]);
  }, [initialDate]);

  const datesValid = Boolean(start && end && start <= end) &&
    (Date.parse(end) - Date.parse(start)) / 86400000 <= 366;
  // Share the Phase 4 cached authorization response. Non-Admin users never
  // fetch payment accounts/history or see financial payment controls.
  const { data: reviewAccess } = useQuery<{ canDecide: boolean }>({
    queryKey: ["/api/factory/staff-tracking/production-bonuses", start, end],
    enabled: datesValid,
    queryFn: () => api("GET", "/api/factory/staff-tracking/production-bonuses?" +
      new URLSearchParams({ start, end }).toString()),
  });
  const canViewPayments = reviewAccess?.canDecide === true;
  const key = ["/api/factory/staff-tracking/production-bonuses/payments", start, end];
  const { data, error, isLoading } = useQuery<PaymentSummary>({
    queryKey: key,
    enabled: datesValid && canViewPayments,
    queryFn: () => api("GET", `/api/factory/staff-tracking/production-bonuses/payments?` +
      new URLSearchParams({ start, end }).toString()),
  });
  const { data: accountResponse, error: accountsError } = useQuery<AccountResponse>({
    queryKey: ["/api/factory/staff-tracking/production-bonuses/payment-accounts"],
    enabled: canViewPayments,
    queryFn: () => api("GET", "/api/factory/staff-tracking/production-bonuses/payment-accounts"),
  });

  const rows = data?.payments ?? [];
  const payable = rows.filter((row) =>
    row.decisionStatus === "approved" && !row.paymentStatus && Number(row.approvedAmount) > 0
  );
  const chosen = useMemo(() => rows.filter((row) =>
    selected.includes(row.reviewId) && row.decisionStatus === "approved" &&
    !row.paymentStatus && Number(row.approvedAmount) > 0
  ), [rows, selected]);
  const total = chosen.reduce((sum, row) => sum + Number(row.approvedAmount), 0);
  const allChosen = payable.length > 0 && payable.every((row) => selected.includes(row.reviewId));
  const cashAccounts = (accountResponse?.accounts ?? []).filter((account) =>
    !account.openingCurrency || account.openingCurrency.toUpperCase() === "USD"
  );
  const canPost = chosen.length > 0 && !!accountId && !!paymentDate && !isLoading;

  const postMutation = useMutation({
    mutationFn: () => api<PostResult>("POST", "/api/factory/staff-tracking/production-bonuses/pay", {
      confirm: true,
      paymentDate,
      currency: "USD",
      cashAccountId: Number(accountId),
      selections: chosen.map((row) => ({
        date: row.date, workerId: row.workerId, expectedAmount: String(row.approvedAmount),
      })),
    }),
    onSuccess: (result) => {
      toast({ title: "Production bonus payment posted",
        description: `${result.posted} payments posted; ${result.replayed} safe retries. Check Factory Daybook and accounting.` });
      setSelected([]);
      setReviewOpen(false);
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/staff-tracking/production-bonuses"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/staff-tracking/production-bonuses/payments"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/worker-bonuses"] });
    },
    onError: (error: Error) => {
      setReviewOpen(false);
      toast({ title: "Payment not posted", description: error.message, variant: "destructive" });
    },
  });

  const reverseMutation = useMutation({
    mutationFn: () => api("POST",
      `/api/factory/staff-tracking/production-bonuses/payments/${reverseRow!.paymentId}/reverse`, {
        confirm: true, reversalDate, reason: reversalReason,
      }),
    onSuccess: () => {
      toast({ title: "Production bonus payment reversed", description: "The original payment remains in audit history." });
      setReverseRow(null); setReversalReason("");
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/staff-tracking/production-bonuses/payments"] });
    },
    onError: (error: Error) => toast({
      title: "Reversal not posted", description: error.message, variant: "destructive",
    }),
  });

  if (!canViewPayments) return null;

  return (
    <Card className="overflow-hidden shadow-none" data-testid="production-target-bonus-payments">
      <CardHeader className="border-b bg-muted/20">
        <div className="flex items-center gap-2">
          <Banknote className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">Approved Bonus Payments</CardTitle>
        </div>
        <p className="text-sm text-muted-foreground">
          Pay approved extra-bale bonuses separately from salary. Choose the paying account and payment date,
          review the total, then explicitly post to Payroll Deposit Expense. USD only until verified FX is available.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            Production from
            <Input type="date" aria-label="Payment production from" value={start}
              onChange={(e) => { setStart(e.target.value); setSelected([]); }} className="w-[165px]" />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            To
            <Input type="date" aria-label="Payment production to" value={end}
              onChange={(e) => { setEnd(e.target.value); setSelected([]); }} className="w-[165px]" />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Payment date
            <Input type="date" aria-label="Bonus payment date" value={paymentDate}
              onChange={(e) => setPaymentDate(e.target.value)} className="w-[165px]" />
          </label>
          <label className="min-w-[220px] flex-1 space-y-1 text-xs text-muted-foreground">
            Pay from Cash / Bank (USD)
            <Select value={accountId} onValueChange={setAccountId}>
              <SelectTrigger aria-label="Pay bonus from account"><SelectValue placeholder="Select paying account" /></SelectTrigger>
              <SelectContent>
                {cashAccounts.map((account) =>
                  <SelectItem key={account.id} value={String(account.id)}>
                    {account.name} ({account.code})
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </label>
        </div>
        {!datesValid && <p className="text-sm text-destructive" role="alert">Choose a valid date range of up to one year.</p>}
        {error && <p className="text-sm text-destructive" role="alert">{(error as Error).message}</p>}
        {accountsError && <p className="text-sm text-muted-foreground">{(accountsError as Error).message}</p>}
        <div className="flex flex-wrap items-center gap-3 rounded-md border p-3">
          <Button variant="outline" size="sm" disabled={!payable.length}
            onClick={() => setSelected(allChosen ? [] : payable.map((row) => row.reviewId))}>
            {allChosen ? "Clear selection" : "Select all unpaid"}
          </Button>
          <div className="mr-auto text-sm text-muted-foreground">
            <strong className="text-foreground">{chosen.length}</strong> approved bonuses selected
            <span className="ml-2 font-semibold tabular-nums text-foreground">{fmtAmount(total)}</span>
          </div>
          <Button disabled={!canPost || postMutation.isPending}
            onClick={() => setReviewOpen(true)} data-testid="button-review-production-bonus-payment">
            <CheckCircle2 className="mr-2 h-4 w-4" /> Review and Post
          </Button>
        </div>
        <div className="overflow-x-auto rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">Select</TableHead>
                <TableHead>Date / Worker</TableHead>
                <TableHead className="text-right">Approved</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Payment / Account</TableHead>
                <TableHead className="text-right">Correction</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                <TableRow><TableCell colSpan={6} className="py-8 text-center">Loading approved bonuses...</TableCell></TableRow>
              ) : rows.length === 0 ? (
                <TableRow><TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No reviewed bonuses in this date range.
                </TableCell></TableRow>
              ) : rows.map((row) => {
                const unpaid = row.decisionStatus === "approved" && !row.paymentStatus && Number(row.approvedAmount) > 0;
                return <TableRow key={row.reviewId}>
                  <TableCell>
                    <Checkbox aria-label={`Select payment for ${row.workerName} on ${row.date}`}
                      disabled={!unpaid} checked={selected.includes(row.reviewId)}
                      onCheckedChange={(checked) => setSelected((previous) =>
                        checked ? Array.from(new Set([...previous, row.reviewId])) :
                          previous.filter((id) => id !== row.reviewId)
                      )} />
                  </TableCell>
                  <TableCell>
                    <div className="font-medium">{row.workerName}</div>
                    <div className="text-xs text-muted-foreground">{row.date}</div>
                  </TableCell>
                  <TableCell className="text-right font-semibold tabular-nums">{fmtAmount(row.approvedAmount)}</TableCell>
                  <TableCell>
                    <Badge variant={row.paymentStatus === "POSTED" ? "default" : "secondary"}>
                      {row.paymentStatus === "POSTED" ? "Paid" :
                        row.paymentStatus === "REVERSED" ? "Reversed — locked" : row.decisionStatus === "rejected" ? "Rejected" : "Unpaid"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {row.paymentDate ? <div>{row.paymentDate} · {row.cashAccountName}</div> : "Not yet posted"}
                    {row.voucherId && <div>Voucher #{row.voucherId}</div>}
                  </TableCell>
                  <TableCell className="text-right">
                    {row.paymentStatus === "POSTED" && <Button variant="outline" size="sm" type="button"
                      onClick={() => { setReverseRow(row); setReversalDate(localDateStr(new Date())); setReversalReason(""); }}>
                      <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reverse
                    </Button>}
                  </TableCell>
                </TableRow>;
              })}
            </TableBody>
          </Table>
        </div>
        <p className="text-xs text-muted-foreground">
          A paid or reversed worker/date can never be posted again automatically. Reversals create their own audit voucher.
          Approval and payment are separate steps.
        </p>
      </CardContent>

      <AlertDialog open={reviewOpen} onOpenChange={setReviewOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Production Targets bonus payment</AlertDialogTitle>
            <AlertDialogDescription>
              Pay {chosen.length} approved bonuses totaling <strong>{fmtAmount(total)}</strong> from
              <strong> {cashAccounts.find((account) => String(account.id) === accountId)?.name || "selected account"}</strong>
              {" "}on {paymentDate}. This creates a Payment voucher (Debit Payroll Deposit Expense / Credit selected account).
              It also records each payment in Factory Daybook. Review before posting.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={postMutation.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={!canPost || postMutation.isPending}
              onClick={(event) => { event.preventDefault(); postMutation.mutate(); }}>
              {postMutation.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              Confirm and Post
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Dialog open={reverseRow != null} onOpenChange={(open) => { if (!open) setReverseRow(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reverse posted bonus</DialogTitle>
            <DialogDescription>
              This creates a reversing Receipt voucher; the original payment stays in history.
              The same bonus cannot be paid a second time automatically.
            </DialogDescription>
          </DialogHeader>
          <p className="text-sm">{reverseRow?.workerName} · {reverseRow?.date} · {fmtAmount(reverseRow?.approvedAmount ?? "0")}</p>
          <label className="space-y-1 text-sm">
            Reversal date
            <Input type="date" value={reversalDate} onChange={(event) => setReversalDate(event.target.value)} />
          </label>
          <label className="space-y-1 text-sm">
            Reason (required)
            <Input value={reversalReason} onChange={(event) => setReversalReason(event.target.value)} maxLength={400}
              placeholder="Explain why this payment is being reversed" />
          </label>
          <DialogFooter>
            <Button variant="outline" disabled={reverseMutation.isPending} onClick={() => setReverseRow(null)}>Cancel</Button>
            <Button variant="destructive" disabled={reverseMutation.isPending || !reversalReason.trim() || !reversalDate}
              onClick={() => reverseMutation.mutate()}>
              {reverseMutation.isPending ? "Reversing..." : "Confirm Reversal"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

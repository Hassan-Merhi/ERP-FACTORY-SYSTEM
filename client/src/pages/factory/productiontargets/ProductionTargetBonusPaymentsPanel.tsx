import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Banknote, CheckCircle2, Loader2, RotateCcw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";

type PayingAccount = { id: number; name: string; code: string; accountType: string };
type ReviewedBonus = {
  reviewId: number;
  workerId: number;
  workerName: string;
  productionDate: string;
  targetBales: number;
  actualBales: number;
  extraBales: number;
  amount: string;
  decisionStatus: string;
  paymentId: number | null;
  paymentStatus: string | null;
  paymentDate: string | null;
  cashAccountId: number | null;
  voucherId: number | null;
  reversalVoucherId: number | null;
  relatedFinalPayrollCount: number;
  legacyPlannerApprovedCount: number;
};
const usd = (value: string | number) => "$" + Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const isDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) &&
  new Date(value + "T00:00:00Z").toISOString().slice(0, 10) === value;

async function getJson<T>(url: string): Promise<T | null> {
  const response = await factoryApiRequest("GET", url);
  if (response.status === 403) return null;
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || "Unable to load bonus payments");
  return response.json() as Promise<T>;
}

async function postJson<T>(url: string, data: unknown): Promise<T> {
  const response = await factoryApiRequest("POST", url, data);
  if (!response.ok) throw new Error((await response.json().catch(() => null))?.message || "Payment action failed");
  return response.json() as Promise<T>;
}

/** The independent Phase 5/6 payment surface; approval is completed in Phase 4. */
export function ProductionTargetBonusPaymentsPanel({ initialDate }: { initialDate: string }) {
  const { toast } = useToast();
  const [start, setStart] = useState(initialDate);
  const [end, setEnd] = useState(initialDate);
  const [paymentDate, setPaymentDate] = useState(initialDate);
  const [cashAccountId, setCashAccountId] = useState("");
  const [payReview, setPayReview] = useState<ReviewedBonus | null>(null);
  const [reverse, setReverse] = useState<ReviewedBonus | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => { setStart(initialDate); setEnd(initialDate); setPaymentDate(initialDate); }, [initialDate]);

  const rangeValid = isDate(start) && isDate(end) && start <= end &&
    (Date.parse(end) - Date.parse(start)) / 86400000 <= 31;
  const { data: accounts, isLoading: accountsLoading } = useQuery<PayingAccount[] | null>({
    queryKey: ["/api/factory/production-target-bonuses/payment-accounts"],
    queryFn: () => getJson<PayingAccount[]>("/api/factory/production-target-bonuses/payment-accounts"),
    staleTime: 15_000,
  });
  const { data: rows, error, isLoading } = useQuery<ReviewedBonus[] | null>({
    queryKey: ["/api/factory/production-target-bonuses/payments", start, end],
    queryFn: () => getJson<ReviewedBonus[]>("/api/factory/production-target-bonuses/payments?" +
      new URLSearchParams({ startDate: start, endDate: end }).toString()),
    enabled: rangeValid && Array.isArray(accounts),
  });

  const summary = useMemo(() => {
    const list = rows ?? [];
    return {
      pending: list.filter((item) => item.decisionStatus === "approved" && !item.paymentId &&
        Number(item.relatedFinalPayrollCount) === 0 && Number(item.legacyPlannerApprovedCount) === 0),
      paid: list.filter((item) => item.paymentStatus === "POSTED"),
    };
  }, [rows]);

  const post = useMutation({
    mutationFn: () => postJson("/api/factory/production-target-bonuses/payments", {
      reviewId: payReview!.reviewId, cashAccountId: Number(cashAccountId),
      paymentDate, currency: "USD", confirm: true,
    }),
    onSuccess: () => {
      toast({ title: "Production bonus posted", description: "Cash/Bank, Deposit Expense and Daybook were posted together." });
      setPayReview(null);
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/production-target-bonuses/payments"] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/production-target-bonuses/payment-accounts"] });
    },
    onError: (err: Error) => toast({ title: "Payment not posted", description: err.message, variant: "destructive" }),
  });
  const reverseMutation = useMutation({
    mutationFn: () => postJson("/api/factory/production-target-bonuses/payments/" + reverse!.paymentId + "/reverse", {
      confirm: true, reversalDate: paymentDate, reason,
    }),
    onSuccess: () => {
      toast({ title: "Bonus reversal posted", description: "The original payment remains in the audit trail." });
      setReverse(null); setReason("");
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/production-target-bonuses/payments"] });
    },
    onError: (err: Error) => toast({ title: "Reversal failed", description: err.message, variant: "destructive" }),
  });

  if (accounts === null) return null; // Non-Admin/Owner users have no payment access.
  return (
    <Card className="shadow-none" data-testid="production-target-bonus-payments">
      <CardHeader className="border-b bg-muted/20 pb-3">
        <div className="flex items-center gap-2">
          <Banknote className="h-5 w-5 text-primary" />
          <CardTitle className="text-lg">Production Bonus Payments</CardTitle>
        </div>
        <p className="text-xs text-muted-foreground">
          Pay individually approved, finalized extra-bale bonuses. Choose your paying account and confirm each voucher.
          Any award already in payroll or previously paid is blocked.
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1"><Label>From</Label><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} className="w-[160px]" /></div>
          <div className="space-y-1"><Label>To</Label><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} className="w-[160px]" /></div>
          <div className="space-y-1"><Label>Payment date</Label><Input type="date" value={paymentDate} onChange={(e) => setPaymentDate(e.target.value)} className="w-[160px]" /></div>
          <div className="min-w-[210px] flex-1 space-y-1">
            <Label>Pay from Cash / Bank</Label>
            <Select value={cashAccountId} onValueChange={setCashAccountId}>
              <SelectTrigger><SelectValue placeholder="Choose account" /></SelectTrigger>
              <SelectContent>{(accounts ?? []).map((item) =>
                <SelectItem key={item.id} value={String(item.id)}>{item.name} ({item.accountType})</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Ready for payment</p>
            <p className="font-semibold">{summary.pending.length}</p></div>
          <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Awaiting payment</p>
            <p className="font-semibold">{usd(summary.pending.reduce((sum, item) => sum + Number(item.amount), 0))}</p></div>
          <div className="rounded-lg border p-3"><p className="text-xs text-muted-foreground">Paid</p>
            <p className="font-semibold">{usd(summary.paid.reduce((sum, item) => sum + Number(item.amount), 0))}</p></div>
        </div>
        {!rangeValid && <p role="alert" className="text-sm text-destructive">Select up to 32 valid days.</p>}
        {error && <p role="alert" className="text-sm text-destructive">{(error as Error).message}</p>}
        {(isLoading || accountsLoading) && <p className="text-sm text-muted-foreground"><Loader2 className="inline h-4 w-4 animate-spin" /> Loading bonus payment reviews...</p>}
        <div className="space-y-2">
          {(rows ?? []).map((item) => {
            const conflict = Number(item.relatedFinalPayrollCount) > 0 || Number(item.legacyPlannerApprovedCount) > 0;
            const canPay = item.decisionStatus === "approved" && !item.paymentId && !conflict;
            return (
              <div key={item.reviewId} className="flex flex-wrap items-center gap-3 rounded-lg border p-3">
                <div className="min-w-[190px] flex-1">
                  <div className="font-medium">{item.workerName}</div>
                  <div className="text-xs text-muted-foreground">{item.productionDate} · Target {item.targetBales} · Produced {item.actualBales} · Extra {item.extraBales}</div>
                </div>
                <div className="text-right">
                  <div className="font-semibold tabular-nums">{usd(item.amount)}</div>
                  <Badge variant={item.paymentStatus === "POSTED" ? "default" : "outline"}>
                    {item.paymentStatus === "POSTED" ? "Paid" : item.paymentStatus === "REVERSED" ? "Reversed" :
                      conflict ? "Payroll conflict" : item.decisionStatus === "approved" ? "Approved" : "Rejected"}
                  </Badge>
                </div>
                {canPay && <Button size="sm" disabled={!cashAccountId || !isDate(paymentDate) || post.isPending}
                  onClick={() => setPayReview(item)}><CheckCircle2 className="mr-1.5 h-4 w-4" /> Review &amp; Pay</Button>}
                {item.paymentStatus === "POSTED" && <Button size="sm" variant="outline" onClick={() => setReverse(item)}>
                  <RotateCcw className="mr-1.5 h-4 w-4" /> Reverse</Button>}
              </div>
            );
          })}
          {!isLoading && (rows ?? []).length === 0 && <p className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">No reviewed bonuses for these dates.</p>}
        </div>
      </CardContent>
      <Dialog open={payReview !== null} onOpenChange={(open) => { if (!open && !post.isPending) setPayReview(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Confirm production bonus payment</DialogTitle>
            <DialogDescription>This posts a real balanced voucher, Payroll Deposit Expense and a Daybook entry.</DialogDescription></DialogHeader>
          {payReview && <div className="space-y-1 text-sm">
            <p><strong>Worker:</strong> {payReview.workerName}</p>
            <p><strong>Production date:</strong> {payReview.productionDate}</p>
            <p><strong>Pay:</strong> {usd(payReview.amount)}</p>
            <p><strong>Paying account:</strong> {accounts?.find((item) => String(item.id) === cashAccountId)?.name || "None"}</p>
            <p><strong>Payment date:</strong> {paymentDate}</p>
          </div>}
          <DialogFooter><Button variant="outline" disabled={post.isPending} onClick={() => setPayReview(null)}>Cancel</Button>
            <Button disabled={post.isPending || !cashAccountId || !isDate(paymentDate)} onClick={() => post.mutate()}>
              {post.isPending ? "Posting..." : "Confirm & Post"}</Button></DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={reverse !== null} onOpenChange={(open) => { if (!open && !reverseMutation.isPending) setReverse(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Reverse posted bonus</DialogTitle>
            <DialogDescription>A counter-voucher is posted; the original payment stays in the ledger history and cannot be paid again.</DialogDescription></DialogHeader>
          {reverse && <p className="text-sm">{reverse.workerName} · {usd(reverse.amount)}</p>}
          <Label htmlFor="bonus-reverse-reason">Required reason</Label>
          <Input id="bonus-reverse-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for reversal" />
          <DialogFooter><Button variant="outline" disabled={reverseMutation.isPending} onClick={() => setReverse(null)}>Cancel</Button>
            <Button variant="destructive" disabled={reverseMutation.isPending || !reason.trim() || !isDate(paymentDate)}
              onClick={() => reverseMutation.mutate()}>Post reversal</Button></DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

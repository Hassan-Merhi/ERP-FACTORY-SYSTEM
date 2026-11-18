// Extracted from ./ProductionTargetWeeklyBonusPaymentsPanel.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useState } from "react";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Banknote, Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { useToast } from "@/hooks/use-toast";
import { factoryApiRequest } from "@/lib/factoryApi";
import { queryClient } from "@/lib/queryClient";
import { mondayOfProductionBonusWeek } from "@shared/productionTargetBonusWeeklyMethod";
import { localDateStr } from "../factoryProductionTargetsModel";
import type { WeeklyBonusPaymentExportRow } from "./weeklyBonusPaymentsExcel";

type WeeklyRow = WeeklyBonusPaymentExportRow & {
  paymentStatus: "POSTED" | "REVERSED" | null;
  paymentId: number | string | null;
  cashAccountId: number | null;
};

type WeeklyHistory = { start: string; end: string; currency: "USD"; payments: WeeklyRow[] };

type Account = { id: number; name: string; code: string; accountType: string; openingCurrency: string | null };

type Accounts = { accounts: Account[] };

type PostResult = { posted: number; replayed: number };

type WeeklyReconciliation = {
  paymentCount: number;
  passed: number;
  failed: number;
  discrepancies: Array<{ paymentId: number; workerId: number; weekStart: string; issues: string[] }>;
  note: string;
};

const base = "/api/factory/production-target-bonuses/weekly-payments";

async function api<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
  const response = await factoryApiRequest(method, url, body);
  const result = await response.json().catch(() => null);
  if (!response.ok) throw new Error(result?.message || "Weekly bonus payment request failed");
  return result as T;
}

export const usd = (v: string | number) => Number(v).toLocaleString("en-US", { style: "currency", currency: "USD" });

export function useProductionTargetWeeklyBonusPaymentsPanelState({ initialDate }: { initialDate: string }) {
  const { toast } = useToast();
  const recordChanges = useExistingRecordChangeAccess();
  const monday = mondayOfProductionBonusWeek(initialDate) ?? initialDate;
  const [start, setStart] = useState(monday);
  const [end, setEnd] = useState(monday);
  const [selected, setSelected] = useState<number[]>([]);
  const [accountId, setAccountId] = useState("");
  const [paymentDate, setPaymentDate] = useState(() => localDateStr(new Date()));
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reverseRow, setReverseRow] = useState<WeeklyRow | null>(null);
  const [reversalDate, setReversalDate] = useState(() => localDateStr(new Date()));
  const [reason, setReason] = useState("");
  const [exporting, setExporting] = useState(false);
  const [audit, setAudit] = useState<WeeklyReconciliation | null>(null);
  useEffect(() => {
    const day = mondayOfProductionBonusWeek(initialDate) ?? initialDate;
    setStart(day);
    setEnd(day);
    setSelected([]);
    setAudit(null);
  }, [initialDate]);
  const valid = Boolean(
    mondayOfProductionBonusWeek(start) === start &&
    mondayOfProductionBonusWeek(end) === end &&
    start <= end &&
    (Date.parse(end) - Date.parse(start)) / 86400000 <= 366
  );
  const { data, error, isLoading } = useQuery<WeeklyHistory>({
    queryKey: [base, start, end],
    enabled: valid,
    queryFn: () => api("GET", base + "?" + new URLSearchParams({ start, end }).toString()),
  });
  const { data: accountData, error: accountError } = useQuery<Accounts>({
    queryKey: ["/api/factory/staff-tracking/production-bonuses/payment-accounts"],
    queryFn: () => api("GET", "/api/factory/staff-tracking/production-bonuses/payment-accounts"),
  });
  const cashAccounts = (accountData?.accounts ?? []).filter(
    (a) => !a.openingCurrency || a.openingCurrency.toUpperCase() === "USD"
  );
  const rows = useMemo(() => data?.payments ?? [], [data]);
  const payable = rows.filter(
    (r) => r.decisionStatus === "approved" && !r.paymentStatus && Number(r.approvedAmount) > 0
  );
  const chosen = useMemo(
    () =>
      rows.filter(
        (r) =>
          selected.includes(Number(r.reviewId)) &&
          r.decisionStatus === "approved" &&
          !r.paymentStatus &&
          Number(r.approvedAmount) > 0
      ),
    [rows, selected]
  );
  const allSelected = payable.length > 0 && payable.every((r) => selected.includes(Number(r.reviewId)));
  const total = chosen.reduce((sum, r) => sum + Number(r.approvedAmount), 0);
  const canPay = chosen.length > 0 && Boolean(accountId) && Boolean(paymentDate) && !isLoading;
  const reconcile = useMutation({
    mutationFn: () =>
      api<WeeklyReconciliation>(
        "GET",
        "/api/factory/production-target-bonuses/weekly-reconciliation?" + new URLSearchParams({ start, end }).toString()
      ),
    onSuccess: (data) => setAudit(data),
    onError: (error: Error) =>
      toast({
        title: "Could not reconcile weekly bonuses",
        description: error.message,
        variant: "destructive",
      }),
  });
  const payment = useMutation({
    mutationFn: () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return api<PostResult>("POST", base + "/post", {
        confirm: true,
        currency: "USD",
        paymentDate,
        cashAccountId: Number(accountId),
        selections: chosen.map((r) => ({
          weekStart: r.weekStart,
          workerId: Number(r.workerId),
          expectedAmount: String(r.approvedAmount),
        })),
      });
    },
    onSuccess: (result) => {
      toast({
        title: "Weekly flat bonus payments posted",
        description: result.posted + " new vouchers; " + result.replayed + " exact retries. Check Daybook.",
      });
      setSelected([]);
      setConfirmOpen(false);
      void queryClient.invalidateQueries({ queryKey: [base] });
      void queryClient.invalidateQueries({ queryKey: ["/api/factory/production-target-bonuses/weekly-reviews"] });
    },
    onError: (error: Error) => {
      setConfirmOpen(false);
      toast({ title: "No weekly bonus payment posted", description: error.message, variant: "destructive" });
    },
  });
  const reversal = useMutation({
    mutationFn: () => {
      if (!recordChanges.allowed) throw new Error(recordChanges.reason ?? "");
      return api("POST", base + "/" + reverseRow!.paymentId + "/reverse", {
        confirm: true,
        reversalDate,
        reason: reason.trim(),
      });
    },
    onSuccess: () => {
      toast({
        title: "Weekly bonus payment reversed",
        description: "A reversing Receipt voucher was created; the worker/week cannot be paid twice.",
      });
      setReverseRow(null);
      setReason("");
      void queryClient.invalidateQueries({ queryKey: [base] });
    },
    onError: (error: Error) =>
      toast({ title: "Reversal not posted", description: error.message, variant: "destructive" }),
  });
  return {
    accountError,
    accountId,
    allSelected,
    audit,
    canPay,
    cashAccounts,
    chosen,
    confirmOpen,
    data,
    end,
    error,
    exporting,
    isLoading,
    payable,
    payment,
    paymentDate,
    reason,
    reconcile,
    recordChanges,
    reversal,
    reversalDate,
    reverseRow,
    rows,
    selected,
    setAccountId,
    setAudit,
    setConfirmOpen,
    setEnd,
    setExporting,
    setPaymentDate,
    setReason,
    setReversalDate,
    setReverseRow,
    setSelected,
    setStart,
    start,
    toast,
    total,
    valid,
  };
}

export function ProductionTargetWeeklyBonusPaymentsPanelSection({
  isLoading,
  recordChanges,
  rows,
  selected,
  setConfirmOpen,
  setReason,
  setReversalDate,
  setReverseRow,
  setSelected,
}: Pick<
  ReturnType<typeof useProductionTargetWeeklyBonusPaymentsPanelState>,
  | "isLoading"
  | "recordChanges"
  | "rows"
  | "selected"
  | "setConfirmOpen"
  | "setReason"
  | "setReversalDate"
  | "setReverseRow"
  | "setSelected"
>) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-left">
          <tr>
            <th className="px-3 py-2">Select</th>
            <th className="px-3 py-2">Worker / Week</th>
            <th className="px-3 py-2 text-right">Target / Credited</th>
            <th className="px-3 py-2 text-right">Approved USD</th>
            <th className="px-3 py-2">Review / Payment</th>
            <th className="px-3 py-2">Account / Voucher</th>
            <th className="px-3 py-2 text-right">Correction</th>
          </tr>
        </thead>
        <tbody>
          {isLoading && (
            <tr>
              <td colSpan={7} className="px-3 py-5 text-center">
                <Loader2 className="inline h-4 w-4 animate-spin" /> Loading weekly approvals…
              </td>
            </tr>
          )}
          {!isLoading && !rows.length && (
            <tr>
              <td colSpan={7} className="px-3 py-5 text-center text-muted-foreground">
                No reviewed weekly bonuses in this date range.
              </td>
            </tr>
          )}
          {rows.map((r) => {
            const unpaid = r.decisionStatus === "approved" && !r.paymentStatus && Number(r.approvedAmount) > 0;
            return (
              <tr key={String(r.reviewId)} className="border-t align-top">
                <td className="px-3 py-2">
                  <Checkbox
                    disabled={!unpaid}
                    checked={selected.includes(Number(r.reviewId))}
                    aria-label={"Select weekly payment for " + r.workerName}
                    onCheckedChange={(checked) =>
                      setSelected((prior) =>
                        checked
                          ? [...new Set([...prior, Number(r.reviewId)])]
                          : prior.filter((id) => id !== Number(r.reviewId))
                      )
                    }
                  />
                </td>
                <td className="px-3 py-2">
                  <p className="font-medium">{r.workerName}</p>
                  <p className="text-xs text-muted-foreground">
                    {r.weekStart} – {r.weekEnd}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {(r.snapshot?.categories ?? []).map((c) => c.categoryLabel + " " + c.creditedBales).join(" · ")}
                  </p>
                </td>
                <td className="px-3 py-2 text-right tabular-nums">
                  {r.targetBales} / {r.creditedBales}
                </td>
                <td className="px-3 py-2 text-right font-semibold tabular-nums">{usd(r.approvedAmount)}</td>
                <td className="px-3 py-2">
                  <Badge variant={r.paymentStatus === "POSTED" ? "default" : "secondary"}>
                    {r.paymentStatus === "POSTED"
                      ? "Paid"
                      : r.paymentStatus === "REVERSED"
                        ? "Reversed · locked"
                        : r.decisionStatus === "rejected"
                          ? "Rejected"
                          : "Approved · unpaid"}
                  </Badge>
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {r.paymentDate ? r.paymentDate + " · " + (r.cashAccountName ?? "") : "Not posted"}
                  {r.voucherId && <p>Voucher #{r.voucherId}</p>}
                </td>
                <td className="px-3 py-2 text-right">
                  {recordChanges.allowed && unpaid && (
                    <Button
                      type="button"
                      size="sm"
                      data-testid={"pay-weekly-production-bonus-" + r.reviewId}
                      onClick={() => {
                        setSelected([Number(r.reviewId)]);
                        setConfirmOpen(true);
                      }}
                    >
                      <Banknote className="mr-1 h-3.5 w-3.5" /> Pay
                    </Button>
                  )}
                  {recordChanges.allowed && r.paymentStatus === "POSTED" && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setReverseRow(r);
                        setReversalDate(localDateStr(new Date()));
                        setReason("");
                      }}
                    >
                      <RotateCcw className="mr-1 h-3.5 w-3.5" /> Reverse
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

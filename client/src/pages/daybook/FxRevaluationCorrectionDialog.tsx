import { useEffect, useState } from "react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import type { Voucher } from "./types";

type Preview = {
  status: "ready" | "blocked";
  originalVoucherNumber: string;
  originalDate: string;
  targetDate: string;
  reversalDate: string;
  originalUsdTotal: string;
  correctedUsdTotal: string;
  netGainUsd: string;
  lines: {
    accountKind: "ledger" | "bank" | "customer";
    accountId: number; accountName: string; currency: string; adjustmentUsd: string;
    automaticAdjustmentUsd: string; manuallyOverridden: boolean;
  }[];
  blockers: string[];
  previewKey: string | null;
};
function accountKey(line: Preview["lines"][number]) {
  return line.accountKind + ":" + line.accountId;
}
function previousDay(iso: string) {
  const base = iso.slice(0, 10);
  const ms = Date.parse(base + "T00:00:00Z");
  return Number.isFinite(ms) ? new Date(ms - 86400000).toISOString().slice(0, 10) : "";
}
async function responseData(res: Response) {
  const data = await res.json();
  if (!res.ok) throw new Error(data.message || "FX correction request failed.");
  return data;
}

export function FxRevaluationCorrectionDialog({
  open, onOpenChange, voucher,
}: {
  open: boolean; onOpenChange: (open: boolean) => void; voucher: Voucher;
}) {
  const [date, setDate] = useState(() => previousDay(voucher.voucherDate));
  const [reason, setReason] = useState("FX revaluation posted on the wrong business date");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [finished, setFinished] = useState("");
  const [draftAmounts, setDraftAmounts] = useState<Record<string, string>>({});
  const [amountsChanged, setAmountsChanged] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDate(previousDay(voucher.voucherDate));
    setReason("FX revaluation posted on the wrong business date");
    setPreview(null);
    setError("");
    setFinished("");
    setDraftAmounts({});
    setAmountsChanged(false);
  }, [open, voucher.id, voucher.voucherDate]);

  function editedUsdLines(currentPreview: Preview) {
    return currentPreview.lines
      .filter((line) => draftAmounts[accountKey(line)] !== line.automaticAdjustmentUsd)
      .map((line) => ({
        accountKind: line.accountKind,
        accountId: line.accountId,
        adjustmentUsd: draftAmounts[accountKey(line)] ?? line.adjustmentUsd,
      }));
  }

  async function loadPreview() {
    setBusy(true);
    setError("");
    try {
      const overrides = preview ? editedUsdLines(preview) : [];
      const search = new URLSearchParams({ targetDate: date });
      if (overrides.length) search.set("overrides", JSON.stringify(overrides));
      const url = "/api/accounting/monetary-fx/revaluation/" + voucher.id +
        "/correction-preview?" + search.toString();
      const result = await responseData(await apiRequest("GET", url)) as Preview;
      setPreview(result);
      setDraftAmounts(Object.fromEntries(result.lines.map((line) => [accountKey(line), line.adjustmentUsd])));
      setAmountsChanged(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to preview FX correction.");
    } finally {
      setBusy(false);
    }
  }

  async function correct() {
    if (!preview?.previewKey || preview.targetDate !== date || amountsChanged) return;
    setBusy(true);
    setError("");
    try {
      const result = await responseData(await apiRequest(
        "POST", "/api/accounting/monetary-fx/revaluation/" + voucher.id + "/correct",
        { targetDate: date, previewKey: preview.previewKey, reason: reason.trim(),
          amountOverrides: preview.lines.filter((line) => line.manuallyOverridden).map((line) => ({
            accountKind: line.accountKind, accountId: line.accountId, adjustmentUsd: line.adjustmentUsd,
          })) }
      )) as { reversalVoucherNumber: string; correctedVoucherNumber: string };
      setFinished("Posted " + result.correctedVoucherNumber +
        " dated " + date + ". Reversal: " + result.reversalVoucherNumber + ".");
      setPreview(null);
      await queryClient.invalidateQueries({
        predicate: (query) => {
          const key = JSON.stringify(query.queryKey);
          return [
            "/api/vouchers", "/api/daybook", "/api/accounts",
            "/api/ledger-accounts", "/api/bank-accounts", "/api/customers",
            "/api/stats", "/api/accounting/monetary-fx",
            "/api/factory/net-position",
          ].some((path) => key.includes(path));
        },
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not post the correction.");
      setPreview(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full max-w-[95vw] sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Correct FX Revaluation</DialogTitle>
          <DialogDescription>
            {voucher.voucherNumber}: correct the accounting date without changing native CFA cash.
            This creates an audited reversal and a corrected journal.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-2">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label>Original voucher date</Label>
              <Input readOnly value={voucher.voucherDate.slice(0, 10)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="fx-correction-date">Correct accounting date</Label>
              <Input id="fx-correction-date" type="date" value={date}
                max={previousDay(voucher.voucherDate)}
                disabled={busy || !!finished}
                onChange={(event) => { setDate(event.target.value); setPreview(null); setDraftAmounts({}); setAmountsChanged(false); }} />
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="fx-correction-reason">Audit reason</Label>
            <Input id="fx-correction-reason" value={reason} maxLength={1000}
              disabled={busy || !!finished}
              onChange={(event) => setReason(event.target.value)} />
          </div>
          {!finished && (
            <Button type="button" variant="outline" disabled={busy || !date}
              onClick={() => void loadPreview()}>
              {busy ? "Checking..." : amountsChanged ? "Recalculate edited amounts" : "Preview correction"}
            </Button>
          )}
          {preview && (
            <div className="space-y-3 rounded-lg border p-3 text-sm">
              <div className="flex flex-wrap gap-4">
                <span>Original: <strong>{"$"}{preview.originalUsdTotal}</strong></span>
                <span>Recalculated: <strong>{"$"}{preview.correctedUsdTotal}</strong></span>
                <span>FX gain/loss: <strong>{"$"}{preview.netGainUsd}</strong></span>
              </div>
              <div className="space-y-1">
                <p className="font-medium">Edit USD adjustments per account</p>
                <p className="text-muted-foreground">
                  Positive = debit. Negative = credit. These adjust USD book values only, not the actual CFA amount.
                </p>
              </div>
              <div className="max-h-64 space-y-2 overflow-y-auto">
                {preview.lines.map((line) => {
                  const key = accountKey(line);
                  return (
                    <div className="grid grid-cols-[1fr_9rem] items-center gap-3 border-t py-2" key={key}>
                      <div className="min-w-0">
                        <Label htmlFor={"fx-usd-" + key}>{line.accountName} ({line.currency})</Label>
                        <p className="text-xs text-muted-foreground">
                          Calculated USD: {line.automaticAdjustmentUsd}
                        </p>
                      </div>
                      <Input id={"fx-usd-" + key} type="text" inputMode="decimal"
                        aria-label={"USD adjustment for " + line.accountName}
                        value={draftAmounts[key] ?? line.adjustmentUsd}
                        disabled={busy || !!finished || preview.status !== "ready"}
                        onChange={(event) => {
                          setDraftAmounts((current) => ({ ...current, [key]: event.target.value }));
                          setAmountsChanged(true);
                        }} />
                    </div>
                  );
                })}
              </div>
              {preview.lines.some((line) => line.manuallyOverridden) && (
                <p className="text-muted-foreground">
                  Manual USD adjustments require a documented accounting reason.
                  The FX gain/loss entry will be recalculated to balance the journal.
                </p>
              )}
              {amountsChanged && (
                <p role="status" className="text-amber-500">
                  Amounts changed. Click Recalculate edited amounts before confirming.
                </p>
              )}
              {preview.blockers.length > 0 && (
                <div role="alert" className="space-y-1 text-destructive">
                  {preview.blockers.map((blocker, index) => <p key={index}>{blocker}</p>)}
                </div>
              )}
              {preview.status === "ready" && (
                <p className="text-muted-foreground">
                  No foreign-currency cash will be withdrawn or deposited.
                  The original and reversal stay in the audit trail.
                </p>
              )}
            </div>
          )}
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
          {finished && <p className="text-sm font-medium" role="status">{finished}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Close</Button>
          {!finished && (
            <Button disabled={busy || preview?.status !== "ready" ||
              !preview.previewKey || amountsChanged || reason.trim().length < 10 || date !== preview.targetDate}
              onClick={() => void correct()}>
              {busy ? "Posting..." : "Confirm correction"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

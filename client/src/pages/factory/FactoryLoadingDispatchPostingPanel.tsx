/**
 * Phase 4 — controlled trip financial finalization and posted-voucher history.
 * A POST affects Factory customer accounts, not ERP supplier PO imports.
 */
import { CheckCircle2, ClipboardCheck, FileClock, Loader2, RotateCcw, ShieldAlert, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ExportButton } from "@/components/export/ReportExportMenu";
import {
  useFactoryLoadingDispatchPostingPanelState,
  roleCanPost,
  errorText,
  type Props,
} from "./useFactoryLoadingDispatchPostingPanelState";

const dollars = (n: string | undefined) => {
  const value = Number(n ?? "");
  return Number.isFinite(value)
    ? value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";
};
export default function FactoryLoadingDispatchPostingPanel({ orderId, dispatchId, companyId, status, role }: Props) {
  const {
    setMode,
    mode,
    setConfirmed,
    confirmed,
    setReason,
    reason,
    enabled,
    preview,
    history,
    financialStatus,
    canPost,
    mutation,
    submitDisabled,
    exportingInvoice,
    exportTripInvoice,
    existingPostings,
  } = useFactoryLoadingDispatchPostingPanelState({ orderId, dispatchId, companyId, status, role });

  if (!roleCanPost(role)) return null;

  return (
    <>
      <Card
        className="border-emerald-200 bg-white dark:border-emerald-800/40 dark:bg-card"
        data-testid="dispatch-trip-financial-posting"
      >
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2">
              <Wallet className="mt-0.5 h-5 w-5 text-emerald-600" />
              <div>
                <h3 className="text-sm font-bold">Trip accounting</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Separate from End Dispatch. Posted trips appear in Factory customer ledgers before the combined
                  invoice.
                </p>
              </div>
            </div>
            <Badge variant="outline">{financialStatus}</Badge>
          </div>
          {!enabled && <p className="rounded-lg bg-muted p-3 text-xs">End Dispatch before financial finalization.</p>}
          {enabled && preview.isError && (
            <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
              {errorText(preview.error)}
            </p>
          )}
          {enabled && preview.data?.sourceError && (
            <p className="rounded-lg bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">
              {preview.data.sourceError.message}
            </p>
          )}
          {enabled && preview.data?.totals && (
            <div className="grid grid-cols-2 gap-2 rounded-xl bg-emerald-50/60 p-3 dark:bg-emerald-900/10">
              <div>
                <p className="text-[11px] text-muted-foreground">Customer receivable</p>
                <p className="font-mono text-lg font-bold">$ {dollars(preview.data.totals.customerTotal)}</p>
              </div>
              <div>
                <p className="text-[11px] text-muted-foreground">Trip goods</p>
                <p className="font-mono text-lg font-bold">$ {dollars(preview.data.totals.goodsSubtotal)}</p>
              </div>
            </div>
          )}
          {canPost && (
            <Button
              type="button"
              className="w-full"
              disabled={mutation.isPending}
              onClick={() => {
                setMode("post");
                setConfirmed(false);
              }}
              data-testid="dispatch-trip-financial-finalize-button"
            >
              <ClipboardCheck className="mr-2 h-4 w-4" /> Financially Finalize Trip
            </Button>
          )}
          {financialStatus === "POSTED" && (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4" /> Customer receivable has been recorded in Factory accounting.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={mutation.isPending}
                onClick={() => {
                  setMode("reverse");
                  setConfirmed(false);
                  setReason("");
                }}
                data-testid="dispatch-trip-financial-reverse-button"
              >
                <RotateCcw className="mr-1.5 h-4 w-4" /> Request controlled reversal
              </Button>
            </div>
          )}
          {["POSTED", "CONSOLIDATED"].includes(financialStatus) && (
            <ExportButton
              className="w-full"
              busy={exportingInvoice}
              label="Export Excel (Trip Invoice)"
              onClick={() => void exportTripInvoice()}
              data-testid="dispatch-export-trip-invoice"
            />
          )}
          {financialStatus === "CONSOLIDATED" && (
            <p className="text-xs text-muted-foreground">
              This trip belongs to the one combined Factory invoice and cannot be reversed independently.
            </p>
          )}
          {enabled && history.isPending && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading posting history…
            </p>
          )}
          {existingPostings.length > 0 && (
            <div className="space-y-1 border-t pt-3">
              <p className="flex items-center gap-2 text-xs font-semibold">
                <FileClock className="h-3.5 w-3.5" /> Financial posting history
              </p>
              {existingPostings.slice(0, 8).map((p, i) => (
                <div key={i} className="rounded-lg bg-muted/40 p-2 text-xs">
                  <div className="flex justify-between gap-2">
                    <span>
                      {p.kind} · Revision {p.revision}
                    </span>
                    <span>$ {dollars(p.amount)}</span>
                  </div>
                  <p className="break-words text-[11px] text-muted-foreground">
                    Voucher IDs:{" "}
                    {Array.isArray(p.voucherIds) && p.voucherIds.length
                      ? p.voucherIds.join(", ")
                      : "No monetary voucher"}
                  </p>
                </div>
              ))}
            </div>
          )}
          <p className="border-t pt-2 text-[11px] text-muted-foreground">
            ERP supplier PO import is manual and separate. Financially finalizing a trip does not create the final
            customer invoice.
          </p>
        </CardContent>
      </Card>

      <Dialog
        open={mode !== null}
        onOpenChange={(open) => {
          if (!open && !mutation.isPending) setMode(null);
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {mode === "post" ? "Financially finalize this truck?" : "Reverse this trip's accounting?"}
            </DialogTitle>
            <DialogDescription>
              {mode === "post"
                ? "This action posts real vouchers to the Factory customer receivable and charge accounts. The truck's signed bales and charges will be locked."
                : "This creates mirror journals instead of deleting old vouchers. An exported or consolidated trip cannot be reversed here."}
            </DialogDescription>
          </DialogHeader>
          {mode === "post" && preview.data?.totals && (
            <div className="space-y-1 rounded-lg border p-3 text-sm">
              <p>
                Signed bales: <strong>{preview.data.source?.baleCount ?? "—"}</strong>
              </p>
              <p>
                Goods: <strong>$ {dollars(preview.data.totals.goodsSubtotal)}</strong>
              </p>
              <p>
                Billable charges: <strong>$ {dollars(preview.data.totals.billableChargesTotal)}</strong>
              </p>
              <p>
                Discounts: <strong>$ {dollars(preview.data.totals.discountTotal)}</strong>
              </p>
              <p>
                Internal expenses: <strong>$ {dollars(preview.data.totals.internalExpenseTotal)}</strong>
              </p>
              <p className="border-t pt-2 font-semibold">
                Factory customer receivable: $ {dollars(preview.data.totals.customerTotal)}
              </p>
            </div>
          )}
          {mode === "reverse" && (
            <div className="space-y-2">
              <Label htmlFor="dispatch-financial-reversal-reason">Reversal reason</Label>
              <Textarea
                id="dispatch-financial-reversal-reason"
                rows={3}
                maxLength={1000}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Explain why this posted trip must be corrected…"
              />
              <p className="text-[11px] text-muted-foreground">
                Corrections after ERP export or consolidated invoicing require a linked cross-company correction
                instead.
              </p>
            </div>
          )}
          <label className="flex items-start gap-2 rounded-lg border p-3 text-xs">
            <Checkbox checked={confirmed} onCheckedChange={(v) => setConfirmed(v === true)} />
            <span>I have reviewed the amounts and understand this affects real Factory accounting records.</span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => setMode(null)}>
              Cancel
            </Button>
            <Button type="button" disabled={submitDisabled} onClick={() => mutation.mutate()}>
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {mode === "post" ? "Confirm Financial Finalization" : "Confirm Reversal"}
            </Button>
          </DialogFooter>
          {mutation.isError && (
            <p className="flex items-start gap-2 text-xs text-destructive">
              <ShieldAlert className="h-4 w-4 shrink-0" />
              {errorText(mutation.error)}
            </p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

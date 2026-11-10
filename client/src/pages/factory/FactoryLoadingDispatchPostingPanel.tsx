/**
 * Phase 4 — controlled trip financial finalization and posted-voucher history.
 * A POST affects Factory customer accounts, not ERP supplier PO imports.
 */
import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, ClipboardCheck, FileClock, Download, Loader2, RotateCcw, ShieldAlert, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";

interface Preview {
  status: string;
  canEdit: boolean;
  chargeFingerprint: string;
  source: {
    baleCount: number; goodsSubtotal: string; totalWeightKg: string;
    sourceFingerprint: string; closureRevision: number;
  } | null;
  totals: {
    goodsSubtotal: string; billableChargesTotal: string;
    discountTotal: string; internalExpenseTotal: string; customerTotal: string;
  } | null;
  sourceError: { message: string } | null;
}
interface Posting {
  revision: number;
  kind: string;
  amount: string;
  voucherIds: number[];
  postedAt: string;
  reason?: string | null;
}
interface History {
  financial: {
    id: number; status: string; postingRevision: number;
    goodsSubtotal: string; billableChargesTotal: string; discountTotal: string;
    customerTotal: string; postedAt: string | null; valuationDate: string | null;
  } | null;
  postings: Posting[];
  events: Array<{ eventType: string; actorUsername: string; createdAt: string; reason?: string | null }>;
}
interface Props {
  orderId: number;
  dispatchId: number;
  companyId: number | null | undefined;
  status: string;
  role: string;
}
async function read<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include", cache: "no-store" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data?.message || "Could not load financial status");
  return data as T;
}
const roleCanPost = (role: string) => ["admin", "owner", "developer"].includes(role.trim().toLowerCase());
const dollars = (n: string | undefined) => {
  const value = Number(n ?? "");
  return Number.isFinite(value) ? value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";
};
const errorText = (error: unknown) => error instanceof Error ? error.message : "Posting failed";
export default function FactoryLoadingDispatchPostingPanel({ orderId, dispatchId, companyId, status, role }: Props) {
  const { toast } = useToast();
  const [mode, setMode] = useState<"post" | "reverse" | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [reason, setReason] = useState("");
  const base = "/api/factory/customer-orders/" + orderId + "/loading-dispatches/" + dispatchId;
  const previewUrl = base + "/financial-preview";
  const historyUrl = base + "/financial-history";
  const enabled = Boolean(companyId) && roleCanPost(role) && status === "CLOSED";
  const preview = useQuery<Preview>({
    queryKey: companyQueryKey(previewUrl, companyId),
    queryFn: () => read<Preview>(previewUrl),
    enabled,
    refetchInterval: mode ? false : 15000,
  });
  const history = useQuery<History>({
    queryKey: companyQueryKey(historyUrl, companyId),
    queryFn: () => read<History>(historyUrl),
    enabled,
    refetchInterval: mode ? false : 15000,
  });
  const financialStatus = history.data?.financial?.status ?? preview.data?.status ?? "DRAFT";
  const editable = Boolean(preview.data?.canEdit && preview.data.source && preview.data.totals);
  const canPost = enabled && editable && (financialStatus === "DRAFT" || financialStatus === "REVERSED");
  const canReverse = enabled && financialStatus === "POSTED";
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: companyQueryKey(previewUrl, companyId) });
    void queryClient.invalidateQueries({ queryKey: companyQueryKey(historyUrl, companyId) });
  };
  const mutation = useMutation({
    mutationFn: async () => {
      if (!mode || !confirmed) throw new Error("Explicit confirmation required");
      if (mode === "post") {
        if (!preview.data?.source || !preview.data.totals || !canPost) {
          throw new Error("Refresh the signed preview before financial finalization");
        }
        const response = await apiRequest("POST", base + "/financial-finalize", {
          confirm: true,
          sourceFingerprint: preview.data.source.sourceFingerprint,
          chargeFingerprint: preview.data.chargeFingerprint,
        });
        return response.json();
      }
      if (!canReverse || reason.trim().length < 10) throw new Error("An approved reversal reason is required");
      const response = await apiRequest("POST", base + "/financial-reverse", { confirm: true, reason: reason.trim() });
      return response.json();
    },
    onSuccess: () => {
      const action = mode;
      setMode(null); setConfirmed(false); setReason("");
      void queryClient.invalidateQueries();
      toast({
        title: action === "post" ? "Trip financially finalized" : "Trip financial posting reversed",
        description: action === "post"
          ? "Customer receivable and charge vouchers are posted. One final invoice will be created later."
          : "The original vouchers remain in history, with reversing journals.",
      });
    },
    onError: e => {
      refresh();
      toast({ title: "Financial action refused", description: errorText(e), variant: "destructive" });
    },
  });
  const submitDisabled = mutation.isPending || !confirmed || (mode === "post" ? !canPost : !canReverse || reason.trim().length < 10 || reason.trim().length > 1000);

  const [exportingInvoice, setExportingInvoice] = useState(false);
  const exportTripInvoice = async () => {
    setExportingInvoice(true);
    try {
      const overview = await read<{
        order: { customerName: string | null; containerNumber: string | null };
        trips: Array<{ id: string; dispatchNumber: number; financialStatus: string; scannedBales: number; scannedWeightKg: string; goodsSubtotal: string | null; billableCharges: string | null; discounts: string | null; customerTotal: string | null; postedAt: string | null }>;
        charges: Array<{ dispatchId: string | null; name: string; kind: string; amount: string }>;
      }>("/api/factory/customer-orders/" + orderId + "/loading-dispatches/order-overview");
      const trip = overview.trips.find(t => t.id === String(dispatchId));
      if (!trip || !["POSTED", "CONSOLIDATED"].includes(trip.financialStatus) || trip.customerTotal === null) {
        throw new Error("Financially finalize this trip before exporting its invoice.");
      }
      const invoiceLines = await read<{
        goodsSubtotal: string;
        lines: Array<{ articleCode: string; productName: string; pricingMode: string;
          unitPrice: string; weightKg: string; lineTotal: string }>;
      }>("/api/factory/customer-orders/" + orderId + "/loading-dispatches/order-overview/trips/" + dispatchId + "/invoice-lines");
      const toCents = (value: string) => Math.round(Number(value) * 100);
      const goodsCents = invoiceLines.lines.reduce((sum, line) => sum + toCents(line.lineTotal), 0);
      if (!Number.isSafeInteger(goodsCents) || goodsCents !== toCents(invoiceLines.goodsSubtotal) ||
          goodsCents !== toCents(trip.goodsSubtotal ?? "0")) {
        throw new Error("Frozen article totals do not match posted trip goods. Invoice export blocked.");
      }
      const grouped = new Map<string, { articleCode: string; productName: string; pricingMode: string;
        unitPrice: string; quantity: number; weight: number; cents: number }>();
      for (const line of invoiceLines.lines) {
        const key = JSON.stringify([line.articleCode, line.productName, line.pricingMode, line.unitPrice]);
        const current = grouped.get(key) ?? { articleCode: line.articleCode, productName: line.productName,
          pricingMode: line.pricingMode, unitPrice: line.unitPrice, quantity: 0, weight: 0, cents: 0 };
        current.quantity++;
        current.weight += Number(line.weightKg);
        current.cents += toCents(line.lineTotal);
        grouped.set(key, current);
      }
      const escapeHtml = (v: unknown) => String(v ?? "").replace(/[&<>"']/g, c => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
      })[c] || c);
      const currency = (v: string | null) => "$" + dollars(v ?? undefined);
      const charges = overview.charges.filter(c => c.dispatchId === String(dispatchId) && (c.kind === "BILLABLE" || c.kind === "DISCOUNT"));
      const articleRows = [...grouped.values()].map(line => `<tr>
        <td><strong>${escapeHtml(line.articleCode)}</strong></td>
        <td>${escapeHtml(line.productName)}</td>
        <td class="right">${line.quantity}</td>
        <td class="right">${escapeHtml(line.weight.toFixed(2))}</td>
        <td class="right">${escapeHtml(line.pricingMode === "per_kg" ? "per kg" : "per bale")}</td>
        <td class="right">${escapeHtml("$" + Number(line.unitPrice).toFixed(4))}</td>
        <td class="right">${escapeHtml("$" + (line.cents / 100).toFixed(2))}</td>
      </tr>`).join("");
      const chargeRows = charges.map(c => `<tr><td>${escapeHtml(c.name)} (${escapeHtml(c.kind)})</td><td class="right">${escapeHtml(currency(c.amount))}</td></tr>`).join("");
      const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Trip ${trip.dispatchNumber} — Customer Invoice</title>
        <style>
          :root{color-scheme:light}*{box-sizing:border-box}
          body{font-family:Arial,Helvetica,sans-serif;color:#15243b;background:#f1f5f9;margin:0;padding:32px 16px;font-size:13px}
          .sheet{max-width:850px;margin:auto;background:#fff;min-height:980px;padding:46px 52px;box-shadow:0 12px 45px #0f172a14}
          .toolbar{max-width:850px;margin:0 auto 16px;text-align:right}
          button{border:0;background:#173f76;color:#fff;border-radius:7px;padding:12px 20px;font-weight:700;cursor:pointer}
          .masthead{display:flex;justify-content:space-between;gap:20px;align-items:flex-start;border-bottom:3px solid #173f76;padding-bottom:25px}
          .brand{font-size:27px;letter-spacing:.08em;font-weight:800;color:#173f76}
          .subbrand{color:#64748b;font-size:11px;letter-spacing:.12em;margin-top:6px}
          h1{font-size:26px;margin:0;color:#173f76;text-align:right}
          .invoice-type{color:#64748b;text-align:right;font-size:12px;margin-top:6px}
          .details{display:grid;grid-template-columns:1fr 1fr;gap:26px;margin:32px 0}
          .detail{border:1px solid #e2e8f0;border-radius:8px;padding:18px;min-height:125px}
          .eyebrow{font-size:10px;text-transform:uppercase;letter-spacing:.12em;color:#64748b;font-weight:700;margin-bottom:10px}
          .customer{font-size:17px;font-weight:700;overflow-wrap:anywhere}
          .meta{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px}
          .meta span{color:#64748b}.meta strong{display:block;margin-top:4px;font-size:12px;color:#15243b}
          .section{font-size:15px;color:#173f76;font-weight:700;margin:28px 0 12px}
          table{width:100%;border-collapse:collapse;font-size:11px}th{background:#173f76;color:white;text-align:left;padding:13px 14px;font-size:11px;letter-spacing:.04em}
          td{padding:14px;border-bottom:1px solid #e2e8f0;vertical-align:top}
          tr:nth-child(even) td{background:#f8fafc}.right{text-align:right;white-space:nowrap}
          .summary{width:340px;max-width:100%;margin:26px 0 0 auto}
          .summary div{display:flex;justify-content:space-between;gap:20px;padding:9px 12px}
          .summary .grand{background:#eaf1fa;border-top:2px solid #173f76;font-size:17px;font-weight:800;color:#173f76;padding:16px 12px}
          .foot{margin-top:64px;border-top:1px solid #cbd5e1;padding-top:16px;color:#64748b;font-size:11px;line-height:1.7}
          @page{size:A4;margin:12mm}
          @media print{body{background:#fff;padding:0}.sheet{box-shadow:none;max-width:none;min-height:0;padding:0}.toolbar{display:none}
          .masthead,.details,.summary,.foot{break-inside:avoid}th{-webkit-print-color-adjust:exact;print-color-adjust:exact}
          .summary .grand{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
          @media(max-width:560px){.sheet{padding:25px 18px}.details{grid-template-columns:1fr}.masthead{flex-direction:column}h1,.invoice-type{text-align:left}}
        </style></head><body>
        <div class="toolbar"><button onclick="window.print()">Print / Save as PDF</button></div>
        <main class="sheet">
          <header class="masthead">
            <div><div class="brand">FACTORY</div><div class="subbrand">CUSTOMER DISPATCH DOCUMENT</div></div>
            <div><h1>TRIP INVOICE</h1><div class="invoice-type">Posted trip #${trip.dispatchNumber} · Order #${orderId}</div></div>
          </header>
          <section class="details">
            <div class="detail"><div class="eyebrow">Bill to</div><div class="customer">${escapeHtml(overview.order.customerName || "Customer not specified")}</div></div>
            <div class="detail"><div class="eyebrow">Shipment details</div><div class="meta">
              <div><span>Trip</span><strong>#${trip.dispatchNumber}</strong></div>
              <div><span>Order</span><strong>#${orderId}</strong></div>
              <div><span>Container</span><strong>${escapeHtml(overview.order.containerNumber || "—")}</strong></div>
              <div><span>Posted date</span><strong>${escapeHtml(trip.postedAt ? new Date(trip.postedAt).toLocaleDateString() : "—")}</strong></div>
            </div></div>
          </section>
          <div class="section">Shipment summary</div>
          <div class="meta" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-bottom:26px">
            <div><span>Signed bales</span><strong>${trip.scannedBales}</strong></div>
            <div><span>Total weight</span><strong>${escapeHtml(trip.scannedWeightKg)} kg</strong></div>
          </div>
          <div class="section">Invoice breakdown</div>
          <table><thead><tr><th>Description</th><th class="right">Amount (USD)</th></tr></thead><tbody>
            <tr><td>Goods — ${trip.scannedBales} signed bales</td><td class="right">${escapeHtml(currency(trip.goodsSubtotal))}</td></tr>
            ${chargeRows}
          </tbody></table>
          <div class="summary">
            <div><span>Goods subtotal</span><strong>${escapeHtml(currency(trip.goodsSubtotal))}</strong></div>
            <div><span>Billable charges</span><strong>${escapeHtml(currency(trip.billableCharges))}</strong></div>
            <div><span>Discounts</span><strong>−${escapeHtml(currency(trip.discounts))}</strong></div>
            <div class="grand"><span>Amount due (USD)</span><span>${escapeHtml(currency(trip.customerTotal))}</span></div>
          </div>
          <footer class="foot">This document represents only trip #${trip.dispatchNumber} under order #${orderId}.
          Amounts are sourced from existing posted Factory financial records. Exporting does not create
          additional accounting entries. The final consolidated order invoice is handled separately.</footer>
        </main></body></html>`;
      const blob = new Blob([html], { type: "text/html;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `Factory_Trip_${trip.dispatchNumber}_Invoice.html`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      toast({ title: "Trip invoice downloaded", description: "Open the HTML file and select Print / Save as PDF." });
    } catch (error) {
      toast({ title: "Invoice export unavailable", description: errorText(error), variant: "destructive" });
    } finally {
      setExportingInvoice(false);
    }
  };

  const existingPostings = history.data?.postings ?? [];

  if (!roleCanPost(role)) return null;

  return (
    <>
      <Card className="border-emerald-200 bg-white dark:border-emerald-800/40 dark:bg-[#101c34]" data-testid="dispatch-trip-financial-posting">
        <CardContent className="space-y-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-start gap-2">
              <Wallet className="mt-0.5 h-5 w-5 text-emerald-600" />
              <div>
                <h3 className="text-sm font-bold">Trip accounting</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  Separate from End Dispatch. Posted trips appear in Factory customer ledgers before the combined invoice.
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
            <Button type="button" className="w-full" disabled={mutation.isPending}
              onClick={() => { setMode("post"); setConfirmed(false); }}
              data-testid="dispatch-trip-financial-finalize-button">
              <ClipboardCheck className="mr-2 h-4 w-4" /> Financially Finalize Trip
            </Button>
          )}
          {financialStatus === "POSTED" && (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-xs text-emerald-700 dark:text-emerald-300">
                <CheckCircle2 className="h-4 w-4" /> Customer receivable has been recorded in Factory accounting.
              </p>
              <Button type="button" size="sm" variant="outline" disabled={mutation.isPending}
                onClick={() => { setMode("reverse"); setConfirmed(false); setReason(""); }}
                data-testid="dispatch-trip-financial-reverse-button">
                <RotateCcw className="mr-1.5 h-4 w-4" /> Request controlled reversal
              </Button>
            </div>
          )}
          {["POSTED", "CONSOLIDATED"].includes(financialStatus) && (
            <Button type="button" variant="outline" className="w-full" disabled={exportingInvoice}
              onClick={() => void exportTripInvoice()} data-testid="dispatch-export-trip-invoice">
              <Download className="mr-2 h-4 w-4" /> {exportingInvoice ? "Preparing invoice…" : "Export Trip Invoice"}
            </Button>
          )}
          {financialStatus === "CONSOLIDATED" && (
            <p className="text-xs text-muted-foreground">This trip belongs to the one combined Factory invoice and cannot be reversed independently.</p>
          )}
          {enabled && history.isPending && <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading posting history…</p>}
          {existingPostings.length > 0 && (
            <div className="space-y-1 border-t pt-3">
              <p className="flex items-center gap-2 text-xs font-semibold"><FileClock className="h-3.5 w-3.5" /> Financial posting history</p>
              {existingPostings.slice(0, 8).map((p, i) => (
                <div key={i} className="rounded-lg bg-muted/40 p-2 text-xs">
                  <div className="flex justify-between gap-2"><span>{p.kind} · Revision {p.revision}</span><span>$ {dollars(p.amount)}</span></div>
                  <p className="break-words text-[11px] text-muted-foreground">
                    Voucher IDs: {Array.isArray(p.voucherIds) && p.voucherIds.length ? p.voucherIds.join(", ") : "No monetary voucher"}
                  </p>
                </div>
              ))}
            </div>
          )}
          <p className="border-t pt-2 text-[11px] text-muted-foreground">
            ERP supplier PO import is manual and separate. Financially finalizing a trip does not create the final customer invoice.
          </p>
        </CardContent>
      </Card>

      <Dialog open={mode !== null} onOpenChange={open => { if (!open && !mutation.isPending) setMode(null); }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{mode === "post" ? "Financially finalize this truck?" : "Reverse this trip's accounting?"}</DialogTitle>
            <DialogDescription>
              {mode === "post"
                ? "This action posts real vouchers to the Factory customer receivable and charge accounts. The truck's signed bales and charges will be locked."
                : "This creates mirror journals instead of deleting old vouchers. An exported or consolidated trip cannot be reversed here."}
            </DialogDescription>
          </DialogHeader>
          {mode === "post" && preview.data?.totals && (
            <div className="space-y-1 rounded-lg border p-3 text-sm">
              <p>Signed bales: <strong>{preview.data.source?.baleCount ?? "—"}</strong></p>
              <p>Goods: <strong>$ {dollars(preview.data.totals.goodsSubtotal)}</strong></p>
              <p>Billable charges: <strong>$ {dollars(preview.data.totals.billableChargesTotal)}</strong></p>
              <p>Discounts: <strong>$ {dollars(preview.data.totals.discountTotal)}</strong></p>
              <p>Internal expenses: <strong>$ {dollars(preview.data.totals.internalExpenseTotal)}</strong></p>
              <p className="border-t pt-2 font-semibold">Factory customer receivable: $ {dollars(preview.data.totals.customerTotal)}</p>
            </div>
          )}
          {mode === "reverse" && (
            <div className="space-y-2">
              <Label htmlFor="dispatch-financial-reversal-reason">Reversal reason</Label>
              <Textarea id="dispatch-financial-reversal-reason" rows={3} maxLength={1000} value={reason}
                onChange={e => setReason(e.target.value)} placeholder="Explain why this posted trip must be corrected…" />
              <p className="text-[11px] text-muted-foreground">
                Corrections after ERP export or consolidated invoicing require a linked cross-company correction instead.
              </p>
            </div>
          )}
          <label className="flex items-start gap-2 rounded-lg border p-3 text-xs">
            <Checkbox checked={confirmed} onCheckedChange={v => setConfirmed(v === true)} />
            <span>I have reviewed the amounts and understand this affects real Factory accounting records.</span>
          </label>
          <DialogFooter>
            <Button type="button" variant="outline" disabled={mutation.isPending} onClick={() => setMode(null)}>Cancel</Button>
            <Button type="button" disabled={submitDisabled} onClick={() => mutation.mutate()}>
              {mutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {mode === "post" ? "Confirm Financial Finalization" : "Confirm Reversal"}
            </Button>
          </DialogFooter>
          {mutation.isError && (
            <p className="flex items-start gap-2 text-xs text-destructive"><ShieldAlert className="h-4 w-4 shrink-0" />{errorText(mutation.error)}</p>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

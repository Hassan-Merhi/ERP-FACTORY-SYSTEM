/**
 * Phase 5 — manually download one ERP PO Import file per posted Factory trip.
 * Article codes, NOT physical bale references. No "Import into ERP" action.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertTriangle, CheckCircle2, Download, FileSpreadsheet, Loader2, PackageSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { companyQueryKey } from "@/lib/companyQueryScope";

interface Article {
  articleCode: string;
  itemName: string;
  quantity: number;
  totalKg: string;
  factoryGoodsValue: string;
  distinctFactoryNames: string[];
}
interface Charges {
  freight: string; surcharge: string; fumigation: string;
  discount: string; documentCharges: string;
}
type ChargeKey = keyof Charges;
interface SavedExport {
  id: number;
  exportedAt: string;
  exportFingerprint: string;
  supplierCode: string;
  poNumber: string;
  containerNumber: string;
  preview: {
    rates?: Array<{ articleCode: string; rate: string }>;
    charges?: Charges;
  };
}
interface Setup {
  status: string;
  revision: number;
  sourceFingerprint: string;
  factoryCustomerTotal: string;
  factoryGoodsSubtotal: string;
  poNumber: string;
  containerNumber: string;
  articles: Article[];
  suggested: {
    charges: Charges;
    unmappedBillableCharges: Array<{ id: number; name: string; amount: string }>;
    internalExpenseTotal: string;
  };
  previousExport: SavedExport | null;
  importInstructions: string;
}
interface Preview {
  exportFingerprint: string;
  sourceFingerprint: string;
  revision: number;
  poNumber: string;
  containerNumber: string;
  supplierCode: string;
  goodsTotal: string;
  chargesTotal: string;
  supplierInvoiceTotal: string;
  factoryCustomerTotal: string;
  rowCount: number;
  alreadyGenerated: boolean;
}
interface Props {
  orderId: number;
  dispatchId: number;
  companyId: number | null | undefined;
  status: string;
  role: string;
}
const emptyCharges = (): Charges => ({
  freight: "0.00", surcharge: "0.00", fumigation: "0.00",
  discount: "0.00", documentCharges: "0.00",
});
const chargeFields: Array<{ key: ChargeKey; label: string }> = [
  { key: "freight", label: "Freight" },
  { key: "surcharge", label: "Surcharge" },
  { key: "fumigation", label: "Fumigation" },
  { key: "discount", label: "Discount" },
  { key: "documentCharges", label: "Document charges" },
];
const money = (value: string | undefined) => {
  const v = Number(value ?? "");
  return Number.isFinite(v)
    ? v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : "—";
};
const isMoney = (v: string, positive = false) =>
  /^(?:0|[1-9]\d{0,13})(?:\.\d{1,2})?$/.test(v.trim()) &&
  Number.isFinite(Number(v)) && (!positive || Number(v) > 0);
const canExport = (role: string) => ["admin", "owner", "developer"].includes(role.toLowerCase());
const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Could not export PO file";
async function readJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: "include", cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.message || "Unable to read posted trip");
  return body as T;
}
function safeFileName(number: string) {
  const clean = number.replace(/[^a-z0-9_-]+/gi, "_").slice(0, 90);
  return "Factory_ERP_PO_" + clean + ".xlsx";
}
export default function FactoryLoadingDispatchPoExport({ orderId, dispatchId, companyId, role, status }: Props) {
  const { toast } = useToast();
  const [supplierCode, setSupplierCode] = useState("");
  const [rates, setRates] = useState<Record<string, string>>({});
  const [charges, setCharges] = useState<Charges>(emptyCharges());
  const [ratesReviewed, setRatesReviewed] = useState(false);
  const [chargesReviewed, setChargesReviewed] = useState(false);
  const [previewResult, setPreviewResult] = useState<Preview | null>(null);
  const base = "/api/factory/customer-orders/" + orderId + "/loading-dispatches/" + dispatchId;
  const setupUrl = base + "/po-export/setup";
  const enabled = Boolean(companyId) && status === "CLOSED" && canExport(role);
  const setup = useQuery<Setup>({
    queryKey: companyQueryKey(setupUrl, companyId),
    queryFn: () => readJson<Setup>(setupUrl),
    enabled,
    staleTime: 15000,
    refetchOnWindowFocus: false,
  });
  const source = setup.data;
  const frozen = Boolean(source?.previousExport);
  useEffect(() => {
    if (!source) return;
    const prior = source.previousExport;
    setSupplierCode(prior?.supplierCode ?? "");
    setRates(Object.fromEntries(
      (prior?.preview.rates ?? []).map(r => [r.articleCode, r.rate])
    ));
    setCharges(prior?.preview.charges ?? source.suggested.charges ?? emptyCharges());
    setRatesReviewed(false);
    setChargesReviewed(false);
    setPreviewResult(null);
    // Reset only when the frozen source or prior export changes identity,
    // not on every refetch that returns an equal object.
  }, [source?.sourceFingerprint, source?.revision, source?.previousExport?.exportFingerprint]); // eslint-disable-line react-hooks/exhaustive-deps

  const choice = () => ({
    supplierCode: supplierCode.trim(),
    rates: (source?.articles ?? []).map(a => ({
      articleCode: a.articleCode, rate: rates[a.articleCode]?.trim() ?? "",
    })),
    charges: Object.fromEntries(
      chargeFields.map(c => [c.key, charges[c.key].trim()])
    ) as unknown as Charges,
  });
  const payload = () => ({
    expectedSourceFingerprint: source?.sourceFingerprint,
    expectedRevision: source?.revision,
    choice: choice(),
  });
  const valid = Boolean(source && source.articles.length > 0 &&
    supplierCode.trim().length > 0 && supplierCode.trim().length <= 100 &&
    source.articles.every(a => isMoney(rates[a.articleCode] ?? "", true)) &&
    chargeFields.every(c => isMoney(charges[c.key])));
  const change = () => {
    setPreviewResult(null);
    setRatesReviewed(false);
    setChargesReviewed(false);
  };
  const preview = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", base + "/po-export/preview", payload());
      return response.json() as Promise<Preview>;
    },
    onSuccess: data => {
      setPreviewResult(data);
      setRatesReviewed(false);
      setChargesReviewed(false);
    },
    onError: error => {
      setPreviewResult(null);
      toast({ title: "PO preview refused", description: errorMessage(error), variant: "destructive" });
    },
  });
  const download = useMutation({
    mutationFn: async () => {
      if (!source || !previewResult || !ratesReviewed || !chargesReviewed) {
        throw new Error("Preview and explicitly review the ERP purchase values first");
      }
      const response = await fetch(base + "/po-export/download", {
        method: "POST",
        credentials: "include",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...payload(), expectedExportFingerprint: previewResult.exportFingerprint,
          confirmRatesReviewed: true, confirmChargesReviewed: true,
        }),
      });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        throw new Error(error.message || "ERP PO download was refused");
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error("The ERP PO file was empty");
      const url = URL.createObjectURL(blob);
      try {
        const link = document.createElement("a");
        link.href = url;
        link.download = safeFileName(previewResult.containerNumber);
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
      } finally {
        // Browsers need time to start the native file save (especially Safari).
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    },
    onSuccess: () => {
      toast({
        title: "ERP PO Excel generated",
        description: "This file has NOT been imported into ERP. Switch to Normal ERP → PO Import to upload and validate it.",
      });
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(setupUrl, companyId) });
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(base + "/financial-history", companyId) });
    },
    onError: error => toast({
      title: "PO export failed", description: errorMessage(error), variant: "destructive",
    }),
  });
  const pending = preview.isPending || download.isPending;

  if (!canExport(role)) return null;
  return (
    <Card className="border-blue-200 bg-white dark:border-blue-800/40 dark:bg-card" data-testid="dispatch-trip-po-export">
      <CardContent className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-start gap-2">
            <FileSpreadsheet className="mt-0.5 h-5 w-5 text-blue-600" />
            <div>
              <h3 className="text-sm font-bold">ERP PO Excel export</h3>
              <p className="mt-1 text-xs text-muted-foreground">
                One manually imported .xlsx per financially posted truck, grouped by article code.
              </p>
            </div>
          </div>
          {frozen && <Badge variant="outline">File generated</Badge>}
        </div>
        {status !== "CLOSED" && <p className="rounded-lg bg-muted p-3 text-xs">Close the physical trip, then financially finalize it first.</p>}
        {enabled && setup.isPending && <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading posted trip evidence…
        </p>}
        {enabled && setup.isError && (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
            <AlertTriangle className="mr-2 inline h-4 w-4" />{errorMessage(setup.error)}
          </p>
        )}
        {enabled && source && (
          <>
            <div className="grid grid-cols-2 gap-2 text-xs">
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-muted-foreground">ERP Container Number</p>
                <p className="break-all font-mono font-semibold">{source.containerNumber}</p>
              </div>
              <div className="rounded-lg bg-muted/50 p-3">
                <p className="text-muted-foreground">ERP PO Number</p>
                <p className="break-all font-mono font-semibold">{source.poNumber}</p>
              </div>
            </div>
            {frozen && (
              <p className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50/50 p-3 text-xs dark:bg-blue-950/20">
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />
                A PO file was already generated for this truck. Its supplier, costs and charges are locked. You may re-download the same contents, but a different supplier invoice needs controlled reconciliation.
              </p>
            )}

            <div className="space-y-1">
              <Label htmlFor={"trip-po-supplier-" + dispatchId}>ERP supplier code</Label>
              <Input id={"trip-po-supplier-" + dispatchId}
                value={supplierCode} maxLength={100} disabled={frozen || pending}
                onChange={e => { setSupplierCode(e.target.value); change(); }}
                placeholder="Exact Supplier_Code in Normal ERP" data-testid="trip-po-erp-supplier-code" />
              <p className="text-[11px] text-muted-foreground">You will still choose and validate this supplier on Normal ERP → PO Import.</p>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-semibold">ERP purchase price per bale, by article</p>
              <p className="text-[11px] text-muted-foreground">
                These are ERP supplier purchase rates, not Factory customer selling prices.
                The exported Quantity is the number of physically scanned bales of each article.
                ERP code/alias matching is case-sensitive, so verify every exported article code exists in the target ERP.
              </p>
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {source.articles.map(article => (
                  <div key={article.articleCode} className="rounded-lg border p-3 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-all font-mono font-semibold">{article.articleCode}</p>
                        <p className="text-muted-foreground">{article.itemName}</p>
                        <p className="text-muted-foreground">{article.quantity} bales · {article.totalKg} kg</p>
                      </div>
                      <div className="w-28 shrink-0 space-y-1">
                        <Label htmlFor={"rate-" + dispatchId + "-" + article.articleCode} className="text-[11px]">ERP Rate (USD)</Label>
                        <Input id={"rate-" + dispatchId + "-" + article.articleCode}
                          inputMode="decimal" disabled={frozen || pending}
                          value={rates[article.articleCode] ?? ""}
                          placeholder="0.00"
                          onChange={e => {
                            setRates(p => ({ ...p, [article.articleCode]: e.target.value }));
                            change();
                          }} />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold">ERP PO invoice charges (USD)</p>
              <p className="text-[11px] text-muted-foreground">
                Values are suggested from mapped Factory charges and discounts. Review or change for the ERP supplier invoice.
                Internal Factory expenses are not imported.
              </p>
              {source.suggested.unmappedBillableCharges.length > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:bg-amber-950/25 dark:text-amber-200">
                  <div className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="h-4 w-4" /> Factory charges without PO mapping</div>
                  <p className="mt-1">
                    {source.suggested.unmappedBillableCharges.map(c => c.name + " ($" + money(c.amount) + ")").join(", ")}.
                    These are NOT added automatically to ERP. Add an appropriate ERP PO amount manually if needed.
                  </p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {chargeFields.map(field => (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={"po-charge-" + dispatchId + "-" + field.key} className="text-[11px]">{field.label}</Label>
                    <Input id={"po-charge-" + dispatchId + "-" + field.key}
                      inputMode="decimal" disabled={frozen || pending}
                      value={charges[field.key]}
                      onChange={e => {
                        setCharges(p => ({ ...p, [field.key]: e.target.value }));
                        change();
                      }} />
                  </div>
                ))}
              </div>
            </div>
            <Button type="button" variant="outline" className="w-full" disabled={!valid || pending}
              onClick={() => preview.mutate()} data-testid="trip-po-preview-button">
              {preview.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <PackageSearch className="mr-2 h-4 w-4" />}
              Preview ERP PO totals
            </Button>
            {previewResult && (
              <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50/40 p-3 text-xs dark:bg-blue-950/20">
                <div className="flex justify-between gap-2"><span>ERP goods purchase total</span><span className="font-mono">$ {money(previewResult.goodsTotal)}</span></div>
                <div className="flex justify-between gap-2"><span>ERP charges less discount</span><span className="font-mono">$ {money(previewResult.chargesTotal)}</span></div>
                <div className="flex justify-between gap-2 border-t pt-2 font-semibold">
                  <span>ERP supplier invoice total</span><span className="font-mono">$ {money(previewResult.supplierInvoiceTotal)}</span>
                </div>
                <p className="text-muted-foreground">Factory customer receivable is separate: $ {money(previewResult.factoryCustomerTotal)}</p>
                <p className="text-muted-foreground">{previewResult.rowCount} article rows · USD · Normal ERP PO template</p>
                <label className="flex items-start gap-2 pt-2">
                  <Checkbox checked={ratesReviewed} onCheckedChange={v => setRatesReviewed(v === true)} />
                  <span>I reviewed the ERP supplier and every purchase rate; they may differ from Factory selling prices.</span>
                </label>
                <label className="flex items-start gap-2">
                  <Checkbox checked={chargesReviewed} onCheckedChange={v => setChargesReviewed(v === true)} />
                  <span>I reviewed all ERP PO charges and discounts, including any unmapped Factory charges.</span>
                </label>
                <Button type="button" className="w-full" disabled={pending || !ratesReviewed || !chargesReviewed}
                  onClick={() => download.mutate()} data-testid="trip-po-download-button">
                  {download.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Download className="mr-2 h-4 w-4" />}
                  {frozen ? "Re-download original PO Excel" : "Export ERP PO Excel (.xlsx)"}
                </Button>
              </div>
            )}
            <p className="border-t pt-3 text-[11px] text-muted-foreground">
              <strong>Manual ERP step:</strong> Switch to Normal ERP → PO Import, upload this spreadsheet,
              validate that each ERP Item_Barcode matches the correct article code/alias (not only a similar item name),
              confirm the supplier and purchase rates, then import it yourself.
              Exporting never creates an ERP supplier balance, a purchase order, a voucher, or the combined Factory invoice.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

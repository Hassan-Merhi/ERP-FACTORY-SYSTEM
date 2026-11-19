/**
 * Phase 5 — manually download one ERP PO Import file per posted Factory trip.
 * Article codes, NOT physical bale references. No "Import into ERP" action.
 */
import { AlertTriangle, CheckCircle2, FileSpreadsheet, Loader2, PackageSearch } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ExportButton } from "@/components/export/ReportExportMenu";
import { chargeFields, money, canExport, errorMessage, type Props } from "./FactoryLoadingDispatchPoExportHelpers";
import { useFactoryLoadingDispatchPoExportState } from "./useFactoryLoadingDispatchPoExportState";

export default function FactoryLoadingDispatchPoExport({ orderId, dispatchId, companyId, role, status }: Props) {
  const {
    supplierCode,
    setSupplierCode,
    rates,
    setRates,
    charges,
    setCharges,
    ratesReviewed,
    setRatesReviewed,
    chargesReviewed,
    setChargesReviewed,
    previewResult,
    enabled,
    setup,
    source,
    frozen,
    valid,
    change,
    preview,
    download,
    pending,
  } = useFactoryLoadingDispatchPoExportState({ orderId, dispatchId, companyId, role, status });

  if (!canExport(role)) return null;
  return (
    <Card
      className="border-blue-200 bg-white dark:border-blue-800/40 dark:bg-card"
      data-testid="dispatch-trip-po-export"
    >
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
        {status !== "CLOSED" && (
          <p className="rounded-lg bg-muted p-3 text-xs">
            Close the physical trip, then financially finalize it first.
          </p>
        )}
        {enabled && setup.isPending && (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading posted trip evidence…
          </p>
        )}
        {enabled && setup.isError && (
          <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/20 dark:text-amber-200">
            <AlertTriangle className="mr-2 inline h-4 w-4" />
            {errorMessage(setup.error)}
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
                <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-600" />A PO file was already generated for this
                truck. Its supplier, costs and charges are locked. You may re-download the same contents, but a
                different supplier invoice needs controlled reconciliation.
              </p>
            )}

            <div className="space-y-1">
              <Label htmlFor={"trip-po-supplier-" + dispatchId}>ERP supplier code</Label>
              <Input
                id={"trip-po-supplier-" + dispatchId}
                value={supplierCode}
                maxLength={100}
                disabled={frozen || pending}
                onChange={(e) => {
                  setSupplierCode(e.target.value);
                  change();
                }}
                placeholder="Exact Supplier_Code in Normal ERP"
                data-testid="trip-po-erp-supplier-code"
              />
              <p className="text-[11px] text-muted-foreground">
                You will still choose and validate this supplier on Normal ERP → PO Import.
              </p>
            </div>
            <div className="space-y-2">
              <p className="text-xs font-semibold">ERP purchase price per bale, by article</p>
              <p className="text-[11px] text-muted-foreground">
                These are ERP supplier purchase rates, not Factory customer selling prices. The exported Quantity is the
                number of physically scanned bales of each article. ERP code/alias matching is case-sensitive, so verify
                every exported article code exists in the target ERP.
              </p>
              <div className="max-h-64 space-y-2 overflow-y-auto pr-1">
                {source.articles.map((article) => (
                  <div key={article.articleCode} className="rounded-lg border p-3 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="break-all font-mono font-semibold">{article.articleCode}</p>
                        <p className="text-muted-foreground">{article.itemName}</p>
                        <p className="text-muted-foreground">
                          {article.quantity} bales · {article.totalKg} kg
                        </p>
                      </div>
                      <div className="w-28 shrink-0 space-y-1">
                        <Label htmlFor={"rate-" + dispatchId + "-" + article.articleCode} className="text-[11px]">
                          ERP Rate (USD)
                        </Label>
                        <Input
                          id={"rate-" + dispatchId + "-" + article.articleCode}
                          inputMode="decimal"
                          disabled={frozen || pending}
                          value={rates[article.articleCode] ?? ""}
                          placeholder="0.00"
                          onChange={(e) => {
                            setRates((p) => ({ ...p, [article.articleCode]: e.target.value }));
                            change();
                          }}
                        />
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-2">
              <p className="text-xs font-semibold">ERP PO invoice charges (USD)</p>
              <p className="text-[11px] text-muted-foreground">
                Values are suggested from mapped Factory charges and discounts. Review or change for the ERP supplier
                invoice. Internal Factory expenses are not imported.
              </p>
              {source.suggested.unmappedBillableCharges.length > 0 && (
                <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-950 dark:bg-amber-950/25 dark:text-amber-200">
                  <div className="flex items-center gap-1.5 font-semibold">
                    <AlertTriangle className="h-4 w-4" /> Factory charges without PO mapping
                  </div>
                  <p className="mt-1">
                    {source.suggested.unmappedBillableCharges
                      .map((c) => c.name + " ($" + money(c.amount) + ")")
                      .join(", ")}
                    . These are NOT added automatically to ERP. Add an appropriate ERP PO amount manually if needed.
                  </p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {chargeFields.map((field) => (
                  <div key={field.key} className="space-y-1">
                    <Label htmlFor={"po-charge-" + dispatchId + "-" + field.key} className="text-[11px]">
                      {field.label}
                    </Label>
                    <Input
                      id={"po-charge-" + dispatchId + "-" + field.key}
                      inputMode="decimal"
                      disabled={frozen || pending}
                      value={charges[field.key]}
                      onChange={(e) => {
                        setCharges((p) => ({ ...p, [field.key]: e.target.value }));
                        change();
                      }}
                    />
                  </div>
                ))}
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full"
              disabled={!valid || pending}
              onClick={() => preview.mutate()}
              data-testid="trip-po-preview-button"
            >
              {preview.isPending ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <PackageSearch className="mr-2 h-4 w-4" />
              )}
              Preview ERP PO totals
            </Button>
            {previewResult && (
              <div className="space-y-2 rounded-lg border border-blue-200 bg-blue-50/40 p-3 text-xs dark:bg-blue-950/20">
                <div className="flex justify-between gap-2">
                  <span>ERP goods purchase total</span>
                  <span className="font-mono">$ {money(previewResult.goodsTotal)}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span>ERP charges less discount</span>
                  <span className="font-mono">$ {money(previewResult.chargesTotal)}</span>
                </div>
                <div className="flex justify-between gap-2 border-t pt-2 font-semibold">
                  <span>ERP supplier invoice total</span>
                  <span className="font-mono">$ {money(previewResult.supplierInvoiceTotal)}</span>
                </div>
                <p className="text-muted-foreground">
                  Factory customer receivable is separate: $ {money(previewResult.factoryCustomerTotal)}
                </p>
                <p className="text-muted-foreground">
                  {previewResult.rowCount} article rows · USD · Normal ERP PO template
                </p>
                <label className="flex items-start gap-2 pt-2">
                  <Checkbox checked={ratesReviewed} onCheckedChange={(v) => setRatesReviewed(v === true)} />
                  <span>
                    I reviewed the ERP supplier and every purchase rate; they may differ from Factory selling prices.
                  </span>
                </label>
                <label className="flex items-start gap-2">
                  <Checkbox checked={chargesReviewed} onCheckedChange={(v) => setChargesReviewed(v === true)} />
                  <span>I reviewed all ERP PO charges and discounts, including any unmapped Factory charges.</span>
                </label>
                <ExportButton
                  variant="default"
                  className="w-full"
                  busy={download.isPending}
                  disabled={pending || !ratesReviewed || !chargesReviewed}
                  label={frozen ? "Export Excel (Original ERP PO)" : "Export Excel (ERP PO)"}
                  onClick={() => download.mutate()}
                  data-testid="trip-po-download-button"
                />
              </div>
            )}
            <p className="border-t pt-3 text-[11px] text-muted-foreground">
              <strong>Manual ERP step:</strong> Switch to Normal ERP → PO Import, upload this spreadsheet, validate that
              each ERP Item_Barcode matches the correct article code/alias (not only a similar item name), confirm the
              supplier and purchase rates, then import it yourself. Exporting never creates an ERP supplier balance, a
              purchase order, a voucher, or the combined Factory invoice.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

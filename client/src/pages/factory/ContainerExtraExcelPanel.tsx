import { useMemo, useState } from "react";
import { Download, FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { getApiRequest } from "@/lib/factoryApi";
import { useAppMode } from "@/contexts/AppModeContext";
import { downloadContainerExtraTemplate, parseContainerExtraExcel, type ContainerExtraImportRow } from "./containerExtraExcel";

type Product = { articleCode: string | null; sellingPrice?: string | null };
type Price = { article_code: string; price_per_bale: string };

export function ContainerExtraExcelPanel({ endpoint, products, prices, onImported }: {
  endpoint: string; products: Product[]; prices: Price[]; onImported: () => void;
}) {
  const { toast } = useToast();
  const request = getApiRequest(useAppMode());
  const [rows, setRows] = useState<ContainerExtraImportRow[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const productPrices = useMemo(() => new Map(products.map((p) => [
    String(p.articleCode ?? "").trim().toUpperCase(), Number(p.sellingPrice ?? 0),
  ])), [products]);
  const agreedPrices = useMemo(() => new Map(prices.map((p) => [
    p.article_code.trim().toUpperCase(), Number(p.price_per_bale),
  ])), [prices]);
  const priceOf = (row: ContainerExtraImportRow) => {
    if (row.priceInput.trim()) return { price: Number(row.priceInput), source: "Manual" };
    const agreed = agreedPrices.get(row.articleCode) ?? 0;
    if (agreed > 0) return { price: agreed, source: "Agreed" };
    const selling = productPrices.get(row.articleCode) ?? 0;
    return selling > 0 ? { price: selling, source: "Selling" } : { price: 0, source: "Unpriced" };
  };
  const unknown = rows.filter((r) => !productPrices.has(r.articleCode));
  const unpriced = rows.filter((r) => priceOf(r).source === "Unpriced").length;
  const valid = rows.length > 0 && !unknown.length && rows.every((r) =>
    !r.priceInput.trim() || (/^\d+(?:\.\d{1,4})?$/.test(r.priceInput.trim()) && Number(r.priceInput) <= 99999999)
  );
  const openFile = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError("");
    try { setRows(await parseContainerExtraExcel(file)); }
    catch (cause) { setRows([]); setError(cause instanceof Error ? cause.message : "Could not read workbook"); }
    finally { setBusy(false); }
  };
  const submit = async () => {
    setBusy(true); setError("");
    try {
      const response = await request("POST", endpoint + "/import", {
        items: rows.map((r) => ({
          articleCode: r.articleCode, quantity: r.quantity,
          ...(r.priceInput.trim() ? { pricePerBale: r.priceInput.trim() } : {}),
        })),
      });
      const result = await response.json() as { imported: number; unpricedCount: number };
      setRows([]);
      onImported();
      toast({ title: String(result.imported) + " items imported",
        description: result.unpricedCount
          ? String(result.unpricedCount) + " unpriced items saved; add their prices here later."
          : "This loading was updated. Original proforma unchanged." });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Import failed";
      setError(message);
      toast({ title: "Import failed; nothing saved", description: message, variant: "destructive" });
    } finally { setBusy(false); }
  };
  return (
    <section className="space-y-3 rounded-xl border bg-muted/20 p-4" data-testid="panel-container-extra-excel">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileSpreadsheet className="h-5 w-5 text-emerald-600" />
          <div>
            <p className="text-sm font-semibold">Import by Excel</p>
            <p className="text-xs text-muted-foreground">Article Code · Quantity · Optional Price Per Bale</p>
          </div>
        </div>
        <Button size="sm" variant="outline" data-testid="button-download-container-extra-template"
          onClick={() => { void downloadContainerExtraTemplate().catch((cause) =>
            setError(cause instanceof Error ? cause.message : "Template download failed")); }}>
          <Download className="mr-1.5 h-4 w-4" /> Download Template
        </Button>
      </div>
      <Input type="file" accept=".xlsx" disabled={busy} aria-label="Select additional items Excel workbook"
        data-testid="input-container-extra-excel" onChange={(event) => {
          void openFile(event.target.files?.[0]); event.target.value = "";
        }} />
      {error && <p role="alert" className="rounded-lg border border-destructive/30 p-2 text-xs text-destructive">{error}</p>}
      {rows.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium">{rows.length} articles · {rows.reduce((n, r) => n + r.quantity, 0)} bales · {unpriced} unpriced</p>
          {unknown.length > 0 && <p role="alert" className="text-xs text-destructive">Unknown article codes: {unknown.map((r) => r.articleCode).join(", ")}</p>}
          <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border bg-background p-2">
            {rows.map((row, index) => {
              const resolved = priceOf(row);
              return (
                <div className="flex items-center justify-between gap-3 border-b py-1.5 last:border-0" key={row.articleCode}>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs font-medium">{row.articleCode} × {row.quantity}</p>
                    <p className="text-[11px] text-muted-foreground">{resolved.source} · {"$"}{resolved.price.toFixed(2)} / bale</p>
                  </div>
                  <Input className="h-8 w-28 text-xs" placeholder="Auto price" inputMode="decimal"
                    aria-label={"Price per bale for " + row.articleCode} value={row.priceInput}
                    onChange={(e) => setRows((current) => current.map((r, i) =>
                      i === index ? { ...r, priceInput: e.target.value } : r))} />
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between gap-2">
            <Button size="sm" variant="ghost" onClick={() => { setRows([]); setError(""); }}>Clear preview</Button>
            <Button size="sm" disabled={busy || !valid} data-testid="button-import-container-extras"
              onClick={() => { void submit(); }}>
              {busy ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Upload className="mr-1.5 h-4 w-4" />}
              Import {rows.length} items
            </Button>
          </div>
        </div>
      )}
      <p className="text-[11px] text-muted-foreground">
        Blank prices use agreed price, then selling price. If neither exists, save at $0 and edit later.
        Import replaces existing extras for matching codes, never the master proforma.
      </p>
    </section>
  );
}

import type { ClientErrorLike } from "@/lib/clientError";
import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Loader2, ArrowRight } from "lucide-react";

function fmt(v: number | string | undefined, dec = 2) {
  const n = parseFloat(String(v ?? "0"));
  return isNaN(n)
    ? `$0.${"0".repeat(dec)}`
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: dec, maximumFractionDigits: dec })}`;
}
function num(v: string) {
  return parseFloat(v || "0") || 0;
}

interface OpeningStockRow {
  id: number;
  article_code?: string;
  articleCode?: string;
  description?: string | null;
  qty_in?: string | number;
  qtyIn?: string | number;
  qty_remaining?: string | number;
  qtyRemaining?: string | number;
  base_unit_cost_usd?: string | number;
  baseUnitCostUsd?: string | number;
  final_unit_cost_usd?: string | number;
  finalUnitCostUsd?: string | number;
}

export default function SpOpeningStock() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [articleCode, setArticleCode] = useState("");
  const [qty, setQty] = useState("");
  const [baseUC, setBaseUC] = useState("");
  const [landedUC, setLandedUC] = useState("");
  const [finalUC, setFinalUC] = useState("");
  const [notes, setNotes] = useState("");

  // Auto-calculate final = base + landed whenever both change
  useEffect(() => {
    const b = num(baseUC);
    const l = num(landedUC);
    if (b > 0 || l > 0) setFinalUC(String((b + l).toFixed(6)));
  }, [baseUC, landedUC]);

  const { data: past = [], isLoading: pastLoading } = useQuery<OpeningStockRow[]>({
    queryKey: ["/api/sp/opening-stock"],
  });

  const mutation = useMutation({
    mutationFn: (body: {
      articleCode: string;
      qty: string;
      baseUnitCostUsd: string;
      landedUnitCostUsd: string;
      finalUnitCostUsd: string;
      notes: string;
    }) => apiRequest("POST", "/api/sp/opening-stock", body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/sp/opening-stock"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sp/report/stock"] });
      toast({ title: "Opening stock posted", description: "Stock movement and journal entry created." });
      setArticleCode("");
      setQty("");
      setBaseUC("");
      setLandedUC("");
      setFinalUC("");
      setNotes("");
    },
    onError: (e: ClientErrorLike) => toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const qtyN = num(qty);
  const baseN = num(baseUC);
  const landN = num(landedUC);
  const finalN = num(finalUC);
  const finalTotal = qtyN * finalN;
  const baseTotal = qtyN * baseN;
  const landTotal = qtyN * landN;
  const canSubmit = articleCode.trim() && qtyN > 0 && finalN > 0;

  const handleSubmit = () => {
    if (!canSubmit) {
      toast({ title: "Fill in article code, qty and final unit cost", variant: "destructive" });
      return;
    }
    mutation.mutate({
      articleCode: articleCode.trim(),
      qty,
      baseUnitCostUsd: baseUC || "0",
      landedUnitCostUsd: landedUC || "0",
      finalUnitCostUsd: finalUC,
      notes,
    });
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-xl font-semibold">Opening Stock</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Import existing inventory before recording new containers. Supplier payable is not posted here — it is created
          when you sell.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Add Opening Stock Entry</CardTitle>
          <CardDescription className="text-xs">
            Each entry creates a stock lot (FIFO-eligible) and posts: Dr SP-STOCK / Cr SP-COSTCLR (base) / Cr SP-OPNBAL
            (landed)
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground">Article Code *</label>
              <Input
                value={articleCode}
                onChange={(e) => setArticleCode(e.target.value)}
                className="mt-1"
                placeholder="e.g. RICE-25KG"
                data-testid="input-sp-opn-article"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Qty *</label>
              <Input
                type="number"
                step="0.01"
                value={qty}
                onChange={(e) => setQty(e.target.value)}
                className="mt-1"
                placeholder="0"
                data-testid="input-sp-opn-qty"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Base Unit Cost $ (supplier cost)</label>
              <Input
                type="number"
                step="0.0001"
                value={baseUC}
                onChange={(e) => setBaseUC(e.target.value)}
                className="mt-1"
                placeholder="0.0000"
                data-testid="input-sp-opn-base"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Landed Unit Cost $ (freight/duty etc.)</label>
              <Input
                type="number"
                step="0.0001"
                value={landedUC}
                onChange={(e) => setLandedUC(e.target.value)}
                className="mt-1"
                placeholder="0.0000"
                data-testid="input-sp-opn-landed"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Final Unit Cost $ (auto = base + landed) *</label>
              <Input
                type="number"
                step="0.0001"
                value={finalUC}
                onChange={(e) => setFinalUC(e.target.value)}
                className="mt-1"
                placeholder="0.0000"
                data-testid="input-sp-opn-final"
              />
            </div>
            <div className="col-span-2">
              <label className="text-xs text-muted-foreground">Notes / Description</label>
              <Input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="mt-1"
                placeholder="Optional"
                data-testid="input-sp-opn-notes"
              />
            </div>
          </div>

          {/* Voucher preview */}
          {qtyN > 0 && finalN > 0 && (
            <div className="rounded-md border border-border/60 bg-muted/30 p-3 space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">
                Journal Preview
              </p>
              <div className="flex items-center gap-2 text-xs">
                <span className="w-28 font-mono text-muted-foreground">Dr SP-STOCK</span>
                <span className="font-semibold">{fmt(finalTotal)}</span>
                <span className="text-muted-foreground text-xs">(final cost × {qtyN})</span>
              </div>
              <div className="flex items-center gap-2 text-xs pl-3">
                <ArrowRight className="h-3 w-3 text-muted-foreground" />
                <span className="w-28 font-mono text-muted-foreground">Cr SP-COSTCLR</span>
                <span className="font-semibold">{fmt(baseTotal)}</span>
                <span className="text-muted-foreground text-xs">(base — cleared to payable on sale)</span>
              </div>
              {landTotal > 0 && (
                <div className="flex items-center gap-2 text-xs pl-3">
                  <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  <span className="w-28 font-mono text-muted-foreground">Cr SP-OPNBAL</span>
                  <span className="font-semibold">{fmt(landTotal)}</span>
                  <span className="text-muted-foreground text-xs">(landed — opening equity)</span>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end">
            <Button
              onClick={handleSubmit}
              disabled={mutation.isPending || !canSubmit}
              data-testid="button-sp-post-opening"
            >
              {mutation.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Post Opening Stock
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Past entries */}
      <div className="space-y-2">
        <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide">
          Past Opening Stock Entries
        </h2>
        {pastLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading...
          </div>
        ) : past.length === 0 ? (
          <p className="text-sm text-muted-foreground">No opening stock entries yet.</p>
        ) : (
          <Card>
            <CardContent className="py-3">
              <div className="overflow-x-auto">
                <div className="space-y-0.5 min-w-[360px]">
                  <div className="grid grid-cols-6 text-xs font-medium text-muted-foreground pb-1 border-b border-border/40">
                    <span className="col-span-2">Article</span>
                    <span className="text-right">Qty In</span>
                    <span className="text-right">Remaining</span>
                    <span className="text-right">Base/u</span>
                    <span className="text-right">Final/u</span>
                  </div>
                  {past.map((p, i: number) => (
                    <div
                      key={p.id}
                      className="grid grid-cols-6 text-xs py-1.5 border-b border-border/30 last:border-0"
                      data-testid={`row-sp-opn-${i}`}
                    >
                      <div className="col-span-2">
                        <p className="font-mono">{p.article_code || p.articleCode}</p>
                        {p.description && <p className="text-muted-foreground">{p.description}</p>}
                      </div>
                      <span className="text-right tabular-nums text-muted-foreground">
                        {parseFloat(String(p.qty_in ?? p.qtyIn ?? "0")).toFixed(2)}
                      </span>
                      <span className="text-right tabular-nums font-semibold text-green-600">
                        {parseFloat(String(p.qty_remaining ?? p.qtyRemaining ?? "0")).toFixed(2)}
                      </span>
                      <span className="text-right tabular-nums">
                        {fmt(p.base_unit_cost_usd ?? p.baseUnitCostUsd, 4)}
                      </span>
                      <span className="text-right tabular-nums">
                        {fmt(p.final_unit_cost_usd ?? p.finalUnitCostUsd, 4)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}

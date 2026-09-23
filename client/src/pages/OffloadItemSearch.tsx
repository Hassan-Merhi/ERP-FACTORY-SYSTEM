import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Search, Package, Container, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { PageHeader } from "@/components/PageHeader";

interface OffloadResult {
  itemName: string;
  quantity: string;
  rate: string;
  lineTotal: string;
  poNumber: string;
  containerNumber: string;
  offloadDate: string | null;
  importDate: string | null;
  containerStatus: string;
  currency: string;
  supplierName: string | null;
}

export default function OffloadItemSearch() {
  const [input, setInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  const { data: results = [], isLoading } = useQuery<OffloadResult[]>({
    queryKey: ["/api/offload-item-search", searchTerm],
    queryFn: async () => {
      if (!searchTerm) return [];
      const r = await fetch(`/api/offload-item-search?q=${encodeURIComponent(searchTerm)}`);
      if (!r.ok) throw new Error("Search failed");
      return r.json();
    },
    enabled: !!searchTerm,
  });

  const handleSearch = () => {
    const trimmed = input.trim();
    if (trimmed) setSearchTerm(trimmed);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") handleSearch();
  };

  const totalQty = results.reduce((sum, r) => sum + parseFloat(r.quantity || "0"), 0);
  const totalValue = results.reduce((sum, r) => sum + parseFloat(r.lineTotal || "0"), 0);
  const uniqueContainers = new Set(results.map((r) => r.containerNumber)).size;

  const fmtQty = (v: string | number) =>
    Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  const fmtMoney = (v: string | number) =>
    "$\u200b" + Number(v).toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: 2 });

  return (
    <div className="flex flex-col gap-4 sm:p-4 md:p-6">
      {/* ── Header + Search ── */}
      <PageHeader
        title="Offload Item Search"
        subtitle="Search any item name to see every offloaded container it arrived in"
      />
      <div role="search" aria-label="Offload item search" className="flex w-full gap-2 sm:max-w-xl">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            className="pl-9"
            placeholder="e.g. MJS MIX CH WINTER BOOTS"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            data-testid="input-item-search"
          />
        </div>
        <Button onClick={handleSearch} disabled={!input.trim() || isLoading} data-testid="button-search">
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          <span className="ml-1.5">Search</span>
        </Button>
      </div>

      {/* ── Stats pill bar ── */}
      {results.length > 0 && (
        <div className="flex flex-wrap gap-3">
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm flex items-center gap-2">
            <Container className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Containers</span>
            <span className="font-semibold" data-testid="stat-containers">
              {uniqueContainers}
            </span>
          </div>
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm flex items-center gap-2">
            <Package className="h-4 w-4 text-muted-foreground" />
            <span className="text-muted-foreground">Total Qty</span>
            <span className="font-semibold" data-testid="stat-qty">
              {fmtQty(totalQty)} BL
            </span>
          </div>
          <div className="rounded-lg border bg-muted/40 px-3 py-2 text-sm flex items-center gap-2">
            <span className="text-muted-foreground">Total Value</span>
            <span className="font-semibold" data-testid="stat-value">
              {fmtMoney(totalValue)}
            </span>
          </div>
        </div>
      )}

      {/* ── Result label ── */}
      {results.length > 0 && (
        <p className="text-sm text-muted-foreground">
          <span className="font-medium text-foreground">{results.length}</span> line{results.length !== 1 ? "s" : ""}{" "}
          for &ldquo;{searchTerm}&rdquo;
        </p>
      )}

      {/* ── Initial empty state ── */}
      {!searchTerm && (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
          <Search className="h-10 w-10 opacity-25" />
          <p className="text-sm font-medium">Enter an item name above to search offloaded containers</p>
          <p className="text-xs">Shows supplier price (Dubai price) — not the offloaded landed cost</p>
        </div>
      )}

      {/* ── No results state ── */}
      {searchTerm && !isLoading && results.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
          <Package className="h-10 w-10 opacity-25" />
          <p className="text-sm font-medium">No offloaded containers found for &ldquo;{searchTerm}&rdquo;</p>
          <p className="text-xs">Try a different item name or partial name</p>
        </div>
      )}

      {/* ── Results table ── */}
      {results.length > 0 && (
        <>
          {/* Desktop table */}
          <div className="hidden md:block border rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="h-11 bg-muted/40 border-b">
                  <th className="text-left px-4 font-medium">Item Name</th>
                  <th className="text-left px-4 font-medium">Container</th>
                  <th className="text-left px-4 font-medium">Offload Date</th>
                  <th className="text-right px-4 font-medium">Qty</th>
                  <th className="text-right px-4 font-medium">Price / BL</th>
                  <th className="text-right px-4 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {results.map((row, i) => (
                  <tr key={i} className="border-t hover:bg-muted/30 transition-colors" data-testid={`row-result-${i}`}>
                    <td className="px-4 py-3 font-medium">{row.itemName}</td>
                    <td className="px-4 py-3">
                      <span className="font-mono text-xs bg-muted px-1.5 py-0.5 rounded">{row.containerNumber}</span>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {row.offloadDate ? format(new Date(row.offloadDate), "dd MMM yyyy") : "—"}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums">{fmtQty(row.quantity)}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-muted-foreground">{fmtMoney(row.rate)}</td>
                    <td className="px-4 py-3 text-right tabular-nums font-medium">{fmtMoney(row.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t bg-muted/40">
                  <td colSpan={3} className="px-4 py-2 text-sm font-medium">
                    Total
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums font-semibold">{fmtQty(totalQty)}</td>
                  <td />
                  <td className="px-4 py-2 text-right tabular-nums font-semibold">{fmtMoney(totalValue)}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {results.map((row, i) => (
              <div key={i} className="border rounded-xl p-4 space-y-2" data-testid={`card-result-${i}`}>
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-sm leading-tight">{row.itemName}</span>
                  <Badge variant="outline" className="font-mono text-xs shrink-0">
                    {row.containerNumber}
                  </Badge>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
                  <div>
                    <span className="text-foreground font-medium">Date:</span>{" "}
                    {row.offloadDate ? format(new Date(row.offloadDate), "dd MMM yyyy") : "—"}
                  </div>
                  <div>
                    <span className="text-foreground font-medium">Qty:</span> {fmtQty(row.quantity)} BL
                  </div>
                </div>
                <div className="flex justify-between items-center pt-1 border-t text-sm">
                  <span className="text-muted-foreground">{fmtMoney(row.rate)} / BL</span>
                  <span className="font-semibold">{fmtMoney(row.lineTotal)}</span>
                </div>
              </div>
            ))}
            <div className="border rounded-xl px-4 py-3 bg-muted/40 flex justify-between text-sm font-semibold">
              <span>
                Total ({uniqueContainers} container{uniqueContainers !== 1 ? "s" : ""})
              </span>
              <span>{fmtMoney(totalValue)}</span>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

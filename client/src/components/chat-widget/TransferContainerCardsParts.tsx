// Extracted from ./TransferContainerCards.tsx
import { FileCheck, X, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StockTransferDraft, VerifyContainerDraft, DataQueryResult } from "./chatWidgetTypes";

type OtwDetail = NonNullable<StockTransferDraft["items"][number]["otwDetails"]>[number];

// ── Compact OTW (on-the-way) line for the AI stock transfer confirmation card ──
// Examples: "OTW: 12 for Kolwezi in MSKU1234567, ETA 2026-07-20" / "OTW: 30 across 3 containers" / "OTW: none"
export function formatOtwLine(
  otwQty: number | null | undefined,
  details: OtwDetail[] | undefined,
  summary?: string
): string {
  if (!details || details.length === 0) {
    return `OTW: ${otwQty === null || otwQty === undefined || otwQty === 0 ? "none" : otwQty}`;
  }
  const counted = details.filter((d) => d.matchType !== "other");
  if (counted.length === 1) {
    const d = counted[0];
    const shopText =
      d.matchType === "direct" && d.shopName ? ` for ${d.shopName}` : d.matchType === "unknown" ? ", shop unknown" : "";
    const etaText = d.eta ? `, ETA ${d.eta}` : d.trackingStatus ? `, ${d.trackingStatus}` : ", ETA unavailable";
    return `OTW: ${d.quantity}${shopText} in ${d.containerNumber}${etaText}`;
  }
  if (counted.length > 1) {
    const total = counted.reduce((s, d) => s + d.quantity, 0);
    return `OTW: ${total} across ${counted.length} containers`;
  }
  // Only "other-shop" containers exist — none counted for this destination.
  return summary || "OTW exists but assigned to another shop, not counted for this destination";
}

// ── Verify Container Card ─────────────────────────────────────────────
export function VerifyContainerCard({ draft, onDismiss }: { draft: VerifyContainerDraft; onDismiss: () => void }) {
  const downloadUrl = (proformaId: number) =>
    `/api/suppliers/${draft.supplierId}/containers/${draft.containerId}/verification-export.xlsx?proformaId=${proformaId}`;

  return (
    <div
      className="mt-2 rounded-md border border-blue-500/30 bg-blue-500/5 overflow-hidden"
      data-testid="verify-container-card"
    >
      <div className="px-3 py-2 bg-blue-500/10 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FileCheck className="h-4 w-4 text-blue-600 dark:text-blue-400 shrink-0" />
          <span className="text-sm font-semibold text-blue-700 dark:text-blue-400">
            Container Verification: {draft.containerNumber}
          </span>
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5"
          onClick={onDismiss}
          data-testid="button-dismiss-verify-container"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      <div className="px-3 py-3">
        {draft.supplierName && <p className="text-xs text-muted-foreground mb-2">Supplier: {draft.supplierName}</p>}
        {draft.proformas.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No proformas found for this supplier. Please create a proforma first.
          </p>
        ) : draft.proformas.length === 1 ? (
          <div>
            <p className="text-xs text-muted-foreground mb-2">
              Proforma: <span className="font-medium text-foreground">{draft.proformas[0].reference}</span>
            </p>
            <a href={downloadUrl(draft.proformas[0].id)} target="_blank" rel="noreferrer">
              <Button size="sm" className="w-full h-7 text-xs" data-testid="button-download-verify-excel">
                <Download className="h-3 w-3 mr-1.5" />
                Download Verification Excel
              </Button>
            </a>
          </div>
        ) : (
          <div>
            <p className="text-xs text-muted-foreground mb-2">Select a proforma to compare against:</p>
            <div className="space-y-1">
              {draft.proformas.map((p) => (
                <a key={p.id} href={downloadUrl(p.id)} target="_blank" rel="noreferrer" className="block">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full h-7 text-xs justify-start"
                    data-testid={`button-verify-proforma-${p.id}`}
                  >
                    <Download className="h-3 w-3 mr-1.5 shrink-0" />
                    {p.reference}
                  </Button>
                </a>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Phase 1: Data Query Result Card ──────────────────────────────────
export function DataQueryResultCard({ result, onDismiss }: { result: DataQueryResult; onDismiss: () => void }) {
  const highlightClass = (h?: string) => {
    if (h === "positive") return "text-green-600 dark:text-green-400";
    if (h === "negative") return "text-red-600 dark:text-red-400";
    if (h === "muted") return "text-muted-foreground";
    return "";
  };

  return (
    <div
      className="mt-2 rounded-md border border-border bg-muted/20 overflow-hidden"
      data-testid="data-query-result-card"
    >
      <div className="px-3 py-2 bg-muted/30 flex items-start justify-between gap-2 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-semibold leading-tight">{result.title}</p>
          {result.subtitle && <p className="text-xs text-muted-foreground mt-0.5">{result.subtitle}</p>}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-5 w-5 shrink-0"
          onClick={onDismiss}
          data-testid="button-dismiss-data-query"
        >
          <X className="h-3 w-3" />
        </Button>
      </div>
      <div className="px-3 py-3 space-y-3">
        {result.summary && <p className="text-sm text-muted-foreground">{result.summary}</p>}
        {result.noData && !result.summary && (
          <p className="text-sm text-muted-foreground">No data found for this period.</p>
        )}
        {result.stats && result.stats.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {result.stats.map((stat, i) => (
              <div
                key={i}
                className={`rounded-md p-2 bg-background/60 border border-border/50 ${i === result.stats!.length - 1 && result.stats!.length % 2 !== 0 ? "col-span-2" : ""}`}
              >
                <p className="text-xs text-muted-foreground leading-tight">{stat.label}</p>
                <p className={`text-sm font-semibold mt-0.5 ${highlightClass(stat.highlight)}`}>{stat.value}</p>
                {stat.subtext && <p className="text-xs text-muted-foreground mt-0.5">{stat.subtext}</p>}
              </div>
            ))}
          </div>
        )}
        {result.table && result.table.rows.length > 0 && (
          <div className="overflow-auto max-h-52 rounded-md border border-border/50">
            <table className="w-full text-xs min-w-max">
              <thead>
                <tr className="bg-muted/40 border-b border-border">
                  {result.table.headers.map((h, i) => (
                    <th key={i} className="text-left py-1.5 px-2 font-medium text-muted-foreground whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {result.table.rows.map((row, i) => (
                  <tr key={i} className="border-b border-border/40 last:border-0 hover-elevate">
                    {row.map((cell, j) => (
                      <td key={j} className="py-1.5 px-2 whitespace-nowrap">
                        {cell}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result.table && result.table.rows.length === 0 && !result.noData && !result.summary && (
          <p className="text-sm text-muted-foreground">No records found.</p>
        )}
      </div>
    </div>
  );
}

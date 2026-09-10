import { useState, useMemo } from "react";
import { formatNumber } from "@/lib/formatNumber";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Layers, Pencil, Trash2, MessageCircle, Loader2 } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

interface MixBatchRow {
  id: number;
  batchCode: string;
  name: string | null;
  totalWeightKg: string;
  usedKg: string;
  remainingKg: string;
  costPerKg: string;
  totalCost: string;
  status: string;
  operatorUser: string | null;
  batchDate: string | null;
  carryForwardFromId: number | null;
  createdAt: string;
  displayTotalWeightKg?: string;
  displayTotalCost?: string;
  displayCostPerKg?: string;
}

interface MixBatchListProps {
  mixBatches: MixBatchRow[];
  isLoading: boolean;
  onEdit: (batch: MixBatchRow) => void;
  onDelete: (id: number) => void;
  onViewDetail: (batch: MixBatchRow) => void;
  onSendWhatsApp: () => void;
  isSendingWhatsApp: boolean;
  mixBatchDate: string;
  setMixBatchDate: (date: string) => void;
  mixBatchesByDate: any[];
  mixBatchesByDateLoading: boolean;
  mixBatchPrintRef: React.RefObject<HTMLDivElement | null>;
  formatDisplayDate: (date: string) => string;
}

export function MixBatchList({
  mixBatches,
  isLoading,
  onEdit,
  onDelete,
  onViewDetail,
  onSendWhatsApp,
  isSendingWhatsApp,
  mixBatchDate,
  setMixBatchDate,
  mixBatchesByDate,
  mixBatchesByDateLoading: _mixBatchesByDateLoading,
  mixBatchPrintRef,
  formatDisplayDate,
}: MixBatchListProps) {
  const [showAllMixBatches, setShowAllMixBatches] = useState(false);
  const BATCH_PREVIEW_COUNT = 15;

  const visibleMixBatches = useMemo(
    () => (showAllMixBatches ? mixBatches : mixBatches.slice(0, BATCH_PREVIEW_COUNT)),
    [mixBatches, showAllMixBatches]
  );

  const fmtKg = (n: number) => formatNumber(n, 3);
  const sumTotal = mixBatches.reduce((sum, batch) => sum + (parseFloat(batch.totalWeightKg) || 0), 0);
  const sumUsed = mixBatches.reduce((sum, batch) => sum + (parseFloat(batch.usedKg) || 0), 0);
  const sumRemaining = mixBatches.reduce((sum, batch) => sum + (parseFloat(batch.remainingKg) || 0), 0);
  const weightedCost = mixBatches.reduce(
    (sum, batch) => sum + (parseFloat(batch.totalWeightKg) || 0) * (parseFloat(batch.costPerKg) || 0),
    0
  );
  const blendedCost = sumTotal > 0 ? weightedCost / sumTotal : 0;

  return (
    <Card className="min-w-0 shadow-sm" data-testid="mix-batch-list">
      <CardHeader className="flex flex-col gap-4 pb-4 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
        <div className="min-w-0 space-y-1">
          <CardTitle className="flex items-center gap-2 text-lg">
            <Layers className="h-4.5 w-4.5 shrink-0 text-amber-500" />
            Recent Mix Batches
          </CardTitle>
          <p className="text-xs text-muted-foreground">Historical list of blends and their cost origins</p>
        </div>

        <div className="grid w-full grid-cols-1 gap-2 rounded-lg border border-border/50 bg-muted/50 p-2 min-[420px]:grid-cols-[minmax(0,1fr)_auto] sm:w-auto sm:p-1">
          <input
            type="date"
            value={mixBatchDate}
            onChange={(e) => setMixBatchDate(e.target.value)}
            className="min-h-11 min-w-0 w-full rounded-md border border-input bg-background px-2 py-1 text-base font-medium outline-none focus:ring-1 focus:ring-ring sm:min-h-0 sm:w-auto sm:border-none sm:bg-transparent sm:text-sm sm:focus:ring-0"
            data-testid="input-mix-batch-date"
          />
          <Button
            variant="outline"
            size="sm"
            onClick={onSendWhatsApp}
            disabled={isSendingWhatsApp || mixBatchesByDate.length === 0}
            data-testid="button-send-mix-batch-whatsapp"
            className="h-11 w-full gap-2 sm:h-8 sm:w-auto"
          >
            {isSendingWhatsApp ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <MessageCircle className="h-3.5 w-3.5" />
            )}
            Send WhatsApp
          </Button>
        </div>

        {/* Hidden printable card — screenshotted by html2canvas */}
        <div
          ref={mixBatchPrintRef as React.RefObject<HTMLDivElement>}
          style={{
            position: "fixed",
            top: "-9999px",
            left: "-9999px",
            width: "680px",
            backgroundColor: "#111827",
            color: "#f9fafb",
            padding: "24px",
            fontFamily: "Inter, system-ui, sans-serif",
            borderRadius: "12px",
            zIndex: -1,
          }}
        >
          <div style={{ marginBottom: "16px", borderBottom: "1px solid #374151", paddingBottom: "12px" }}>
            <div style={{ fontSize: "11px", color: "#9ca3af", marginBottom: "4px" }}>
              {new Date(mixBatchDate + "T00:00:00").toLocaleDateString("en-US", {
                month: "2-digit",
                day: "2-digit",
                year: "numeric",
              })}
            </div>
            <div style={{ fontSize: "18px", fontWeight: 700, color: "#f9fafb" }}>Mix Batch Details</div>
          </div>

          {mixBatchesByDate.map((batch) => (
            <div key={batch.id} style={{ marginBottom: "20px" }}>
              <div
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}
              >
                <div>
                  <div style={{ fontSize: "15px", fontWeight: 700, fontFamily: "monospace", color: "#f9fafb" }}>
                    {batch.batchCode}
                  </div>
                  {batch.name && (
                    <div style={{ fontSize: "12px", color: "#9ca3af", marginTop: "2px" }}>{batch.name}</div>
                  )}
                </div>
                <span
                  style={{
                    fontSize: "11px",
                    fontWeight: 600,
                    padding: "3px 10px",
                    borderRadius: "999px",
                    backgroundColor: batch.status === "COMPLETED" ? "#166534" : "#374151",
                    color: batch.status === "COMPLETED" ? "#bbf7d0" : "#d1d5db",
                    border: "1px solid " + (batch.status === "COMPLETED" ? "#16a34a" : "#4b5563"),
                  }}
                >
                  {batch.status}
                </span>
              </div>

              <div style={{ display: "flex", gap: "16px", marginBottom: "14px" }}>
                {[
                  { label: "Total Weight", value: formatNumber(batch.totalWeightKg) + " kg" },
                  { label: "Total Cost", value: "$" + formatNumber(batch.displayTotalCost ?? batch.totalCost) },
                  {
                    label: "Cost/kg",
                    value: "$" + (parseFloat(batch.displayCostPerKg ?? batch.costPerKg) || 0).toFixed(2),
                  },
                ].map((stat) => (
                  <div
                    key={stat.label}
                    style={{ flex: 1, backgroundColor: "#1f2937", borderRadius: "8px", padding: "10px 14px" }}
                  >
                    <div style={{ fontSize: "10px", color: "#6b7280", marginBottom: "4px" }}>{stat.label}</div>
                    <div style={{ fontSize: "14px", fontWeight: 700, fontFamily: "monospace", color: "#f9fafb" }}>
                      {stat.value}
                    </div>
                  </div>
                ))}
              </div>

              {batch.sources?.length > 0 && (
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "12px" }}>
                  <thead>
                    <tr style={{ backgroundColor: "#1f2937" }}>
                      {["SOURCE", "CONTAINER", "WEIGHT", "$/KG", "TOTAL"].map((h, i) => (
                        <th
                          key={h}
                          style={{
                            padding: "8px 10px",
                            textAlign: i > 1 ? "right" : "left",
                            color: "#6b7280",
                            fontWeight: 600,
                            fontSize: "10px",
                            borderBottom: "1px solid #374151",
                          }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {batch.sources.map((src: any, idx: number) => (
                      <tr key={src.id} style={{ backgroundColor: idx % 2 === 0 ? "transparent" : "#1a2332" }}>
                        <td style={{ padding: "7px 10px", color: "#f9fafb", fontWeight: 500 }}>{src.sourceName}</td>
                        <td
                          style={{ padding: "7px 10px", color: "#9ca3af", fontFamily: "monospace", fontSize: "11px" }}
                        >
                          {src.containerNumber || "—"}
                        </td>
                        <td
                          style={{ padding: "7px 10px", color: "#f9fafb", textAlign: "right", fontFamily: "monospace" }}
                        >
                          {formatNumber(src.weightKg)} kg
                        </td>
                        <td
                          style={{ padding: "7px 10px", color: "#f9fafb", textAlign: "right", fontFamily: "monospace" }}
                        >
                          ${(parseFloat(src.costPerKg) || 0).toFixed(2)}
                        </td>
                        <td
                          style={{ padding: "7px 10px", color: "#f9fafb", textAlign: "right", fontFamily: "monospace" }}
                        >
                          ${formatNumber(src.totalCost)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ))}

          <div
            style={{
              marginTop: "16px",
              borderTop: "1px solid #374151",
              paddingTop: "10px",
              fontSize: "10px",
              color: "#6b7280",
              textAlign: "right",
            }}
          >
            Generated {new Date().toLocaleString()}
          </div>
        </div>
      </CardHeader>

      <CardContent className="min-w-0">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-12 w-full" />
          </div>
        ) : mixBatches.length > 0 ? (
          <>
            <div className="space-y-3 md:hidden" data-testid="mix-batch-mobile-list">
              <div className="grid grid-cols-2 gap-2 rounded-xl border bg-muted/30 p-3">
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Total Weight</div>
                  <div className="mt-0.5 font-mono text-sm font-bold" data-testid="text-mix-mobile-summary-total">
                    {fmtKg(sumTotal)} kg
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Blended Cost</div>
                  <div className="mt-0.5 font-mono text-sm font-bold" data-testid="text-mix-mobile-summary-cost">
                    ${blendedCost.toFixed(4)}/kg
                  </div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Used</div>
                  <div className="mt-0.5 font-mono text-xs font-medium">{fmtKg(sumUsed)} kg</div>
                </div>
                <div>
                  <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Remaining</div>
                  <div className="mt-0.5 font-mono text-xs font-medium">{fmtKg(sumRemaining)} kg</div>
                </div>
              </div>

              {visibleMixBatches.map((batch) => {
                const total = parseFloat(batch.totalWeightKg) || 0;
                const used = parseFloat(batch.usedKg) || 0;
                const remaining = parseFloat(batch.remainingKg) || 0;
                const cost = parseFloat(batch.displayCostPerKg ?? batch.costPerKg ?? "0") || 0;
                return (
                  <div
                    key={`mobile-${batch.id}`}
                    className="rounded-xl border bg-card p-3 shadow-sm"
                    data-testid={`card-mix-batch-mobile-${batch.id}`}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <button
                        type="button"
                        className="min-w-0 text-left"
                        onClick={() => onViewDetail(batch)}
                        data-testid={`link-mix-batch-mobile-${batch.id}`}
                      >
                        <div className="break-all font-mono text-sm font-semibold text-primary">{batch.batchCode}</div>
                        <div className="mt-0.5 break-words text-xs text-muted-foreground">
                          {batch.name || "Unnamed batch"}
                        </div>
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {batch.batchDate ? formatDisplayDate(batch.batchDate) : formatDisplayDate(batch.createdAt)}
                        </div>
                      </button>
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => onEdit(batch)}
                          aria-label={`Edit ${batch.batchCode}`}
                          data-testid={`button-edit-mix-batch-mobile-${batch.id}`}
                        >
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button
                          size="icon"
                          variant="ghost"
                          onClick={() => onDelete(batch.id)}
                          aria-label={`Delete ${batch.batchCode}`}
                          data-testid={`button-delete-mix-batch-mobile-${batch.id}`}
                        >
                          <Trash2 className="h-4 w-4 text-destructive" />
                        </Button>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-xs">
                      <div className="rounded-lg bg-muted/40 p-2">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Total</div>
                        <div className="mt-0.5 font-mono font-semibold">{formatNumber(total)} kg</div>
                      </div>
                      <div className="rounded-lg bg-muted/40 p-2">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Cost / kg</div>
                        <div className="mt-0.5 font-mono font-semibold">${cost.toFixed(4)}</div>
                      </div>
                      <div className="rounded-lg bg-muted/40 p-2">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Used</div>
                        <div className="mt-0.5 font-mono font-medium">{fmtKg(used)} kg</div>
                      </div>
                      <div className="rounded-lg bg-muted/40 p-2">
                        <div className="text-[10px] uppercase tracking-wide text-muted-foreground">Remaining</div>
                        <div className="mt-0.5 font-mono font-medium">{fmtKg(remaining)} kg</div>
                      </div>
                    </div>
                  </div>
                );
              })}

              {mixBatches.length > BATCH_PREVIEW_COUNT && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowAllMixBatches(!showAllMixBatches)}
                  data-testid="button-toggle-show-all-batches-mobile"
                  className="w-full text-xs"
                >
                  {showAllMixBatches
                    ? "Show less"
                    : `Show all ${mixBatches.length} batches (${mixBatches.length - BATCH_PREVIEW_COUNT} hidden)`}
                </Button>
              )}
            </div>

            <div className="hidden overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="min-w-40">Batch Code</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead className="min-w-32 whitespace-nowrap">Date</TableHead>
                    <TableHead className="min-w-32 text-right whitespace-nowrap">Total (kg)</TableHead>
                    <TableHead className="min-w-36 text-right whitespace-nowrap">Blended Cost</TableHead>
                    <TableHead className="min-w-20"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {visibleMixBatches.map((batch) => {
                    const total = parseFloat(batch.totalWeightKg) || 0;
                    return (
                      <TableRow key={batch.id} data-testid={`row-mix-batch-${batch.id}`}>
                        <TableCell
                          className="font-mono font-medium text-sm cursor-pointer hover:underline text-primary"
                          onClick={() => onViewDetail(batch)}
                          data-testid={`link-mix-batch-detail-${batch.id}`}
                        >
                          {batch.batchCode}
                        </TableCell>
                        <TableCell className="text-sm cursor-pointer hover:underline" onClick={() => onViewDetail(batch)}>
                          {batch.name || <span className="text-muted-foreground">—</span>}
                        </TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {batch.batchDate ? formatDisplayDate(batch.batchDate) : formatDisplayDate(batch.createdAt)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">{formatNumber(total)}</TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          ${parseFloat(batch.displayCostPerKg ?? batch.costPerKg ?? "0").toFixed(4)}/kg
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => onEdit(batch)}
                              data-testid={`button-edit-mix-batch-${batch.id}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => onDelete(batch.id)}
                              data-testid={`button-delete-mix-batch-${batch.id}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                {mixBatches.length > BATCH_PREVIEW_COUNT && (
                  <tbody>
                    <tr>
                      <td colSpan={6} className="py-2 text-center">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setShowAllMixBatches(!showAllMixBatches)}
                          data-testid="button-toggle-show-all-batches"
                          className="text-xs text-muted-foreground"
                        >
                          {showAllMixBatches
                            ? "Show less"
                            : `Show all ${mixBatches.length} batches (${mixBatches.length - BATCH_PREVIEW_COUNT} hidden)`}
                        </Button>
                      </td>
                    </tr>
                  </tbody>
                )}
                <tfoot className="border-t-2 border-border bg-muted/40">
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={3} className="px-4 py-3 text-sm font-semibold text-foreground">
                      Combined Total
                      <div className="text-xs text-muted-foreground font-normal mt-0.5">
                        {mixBatches.length} batch{mixBatches.length !== 1 ? "es" : ""}
                        {" · "}Used: {fmtKg(sumUsed)}
                        {" · "}Remaining: {fmtKg(sumRemaining)}
                      </div>
                    </TableCell>
                    <TableCell
                      className="px-4 py-3 text-right font-mono font-semibold text-sm"
                      data-testid="text-mix-summary-total"
                    >
                      {fmtKg(sumTotal)}
                    </TableCell>
                    <TableCell
                      className="px-4 py-3 text-right font-mono font-semibold text-sm"
                      data-testid="text-mix-summary-cost"
                    >
                      ${blendedCost.toFixed(4)}/kg
                    </TableCell>
                    <TableCell />
                  </TableRow>
                </tfoot>
              </Table>
            </div>
          </>
        ) : (
          <div className="text-center py-10">
            <Layers className="mx-auto h-10 w-10 text-muted-foreground" />
            <h3 className="mt-3 text-base font-semibold">No mix batches</h3>
            <p className="text-muted-foreground text-sm mt-1">No mix batches yet. Create one to get started.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

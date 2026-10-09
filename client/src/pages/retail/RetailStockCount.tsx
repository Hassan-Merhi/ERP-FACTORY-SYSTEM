import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ClipboardList, FileDown, Lock, Play, RotateCcw, ScanLine, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCompany } from "@/contexts/CompanyContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { RetailNav } from "./RetailNav";
import { getJson, type Location } from "./retailInventoryTypes";
import {
  createRetailStockCountSession,
  fetchRetailStockCountReport,
  fetchRetailStockCountSession,
  fetchRetailStockCountVariance,
  listRetailStockCountSessions,
  retailStockCountReportCsvUrl,
  scanRetailStockCount,
  transitionRetailStockCount,
  updateRetailStockCountLine,
} from "@/pages/pos/retailWave2Api";
import type {
  RetailStockCountLineStatus,
  RetailStockCountSession,
  RetailStockCountSessionLine,
} from "@/pages/pos/retailWave2Types";

const STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  counting: "Counting",
  review: "Review",
  finalized: "Finalized",
  canceled: "Canceled",
};

const LINE_STATUS_LABELS: Record<RetailStockCountLineStatus, string> = {
  uncounted: "Uncounted",
  counted: "Counted",
  variance: "Variance",
  unexpected: "Unexpected",
};

function statusClass(status: string): string {
  if (status === "finalized") return "bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300";
  if (status === "canceled") return "bg-muted text-muted-foreground";
  if (status === "counting") return "bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300";
  if (status === "review") return "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-300";
  return "bg-muted text-foreground";
}

function lineStatusClass(status: RetailStockCountLineStatus): string {
  if (status === "variance") return "text-amber-700 dark:text-amber-400 font-medium";
  if (status === "unexpected") return "text-destructive font-medium";
  if (status === "uncounted") return "text-muted-foreground";
  return "";
}

/**
 * Physical stock count workspace.
 *
 * Sessions move Draft → Counting → Review → Finalized (with an optional Recount loop).
 * Cashiers scan barcodes repeatedly or key quantities; finalization writes one
 * `retail_stock_movements` row per counted line and is atomic + idempotent.
 */
export default function RetailStockCount() {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const retailEnabled = selectedCompany?.companyType === "retail";
  const [locationId, setLocationId] = useState<number | "">("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [scanText, setScanText] = useState("");
  const [includeAllVariants, setIncludeAllVariants] = useState(false);
  const [finalizeOpen, setFinalizeOpen] = useState(false);
  const [allowUncounted, setAllowUncounted] = useState(false);
  const [confirmVariance, setConfirmVariance] = useState(false);
  const [finalizeNotes, setFinalizeNotes] = useState("");
  const scanRef = useRef<HTMLInputElement | null>(null);

  const locationsQuery = useQuery({
    queryKey: ["retail-stock-count-locations"],
    queryFn: () => getJson<Location[]>("/api/locations"),
    enabled: retailEnabled,
  });
  const locations = (locationsQuery.data ?? []).filter((location) => location.id > 0);

  useEffect(() => {
    if (!locationId && locations.length === 1) setLocationId(locations[0].id);
  }, [locationId, locations]);

  const sessionsQuery = useQuery({
    queryKey: ["retail-stock-counts", locationId],
    queryFn: () => listRetailStockCountSessions({ locationId: locationId || undefined, limit: 50 }),
    enabled: retailEnabled,
    refetchInterval: 15_000,
  });

  const sessionQuery = useQuery({
    queryKey: ["retail-stock-count", selectedId],
    queryFn: () => fetchRetailStockCountSession(selectedId as number),
    enabled: retailEnabled && Boolean(selectedId),
    refetchInterval: 10_000,
  });
  const session: RetailStockCountSession | null = sessionQuery.data ?? null;

  const reportQuery = useQuery({
    queryKey: ["retail-stock-count-report", locationId],
    queryFn: () => fetchRetailStockCountReport({ locationId: locationId || undefined }),
    enabled: retailEnabled,
  });

  const varianceQuery = useQuery({
    queryKey: ["retail-stock-count-variance", session?.id, session?.status],
    queryFn: () => fetchRetailStockCountVariance(session!.id),
    enabled: Boolean(session && session.status === "finalized"),
  });

  const refreshAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["retail-stock-counts"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-stock-count-report"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-stock-count"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-stock-count-variance"] }),
      queryClient.invalidateQueries({ queryKey: ["retail-pos-items"] }),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: () =>
      createRetailStockCountSession({
        locationId: locationId as number,
        includeAllVariants,
        startNow: true,
      }),
    onSuccess: async (created) => {
      setSelectedId(created.id);
      await refreshAll();
      toast({ title: "Stock count started", description: `${created.code} · ${created.lineCount} lines snapshotted.` });
      window.setTimeout(() => scanRef.current?.focus(), 50);
    },
    onError: (error) =>
      toast({ title: "Could not start the count", description: error.message, variant: "destructive" }),
  });

  const transitionMutation = useMutation({
    mutationFn: (input: { action: "start" | "review" | "recount" | "cancel" }) =>
      transitionRetailStockCount(
        session!.id,
        input.action,
        input.action === "cancel" ? { reason: "Canceled from stock count screen" } : {}
      ),
    onSuccess: async (_data, input) => {
      await refreshAll();
      toast({
        title: `Stock count ${input.action}`,
        description: `Stock count ${session?.code ?? "current session"} updated.`,
      });
    },
    onError: (error) => toast({ title: "Action failed", description: error.message, variant: "destructive" }),
  });

  const finalizeMutation = useMutation({
    mutationFn: () =>
      transitionRetailStockCount(session!.id, "finalize", {
        allowUncounted,
        confirmVariance,
        notes: finalizeNotes.trim() || undefined,
      }),
    onSuccess: async (data) => {
      setFinalizeOpen(false);
      await refreshAll();
      const movementsWritten = data.session.movementCount ?? data.session.countedLineCount;
      toast({
        title: "Stock count finalized",
        description: `${movementsWritten} inventory movements were written by this count.`,
      });
    },
    onError: (error) => toast({ title: "Finalize failed", description: error.message, variant: "destructive" }),
  });

  const scanMutation = useMutation({
    mutationFn: (barcode: string) => scanRetailStockCount(session!.id, { barcode, quantity: 1, mode: "increment" }),
    onSuccess: async (data) => {
      setScanText("");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["retail-stock-count"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-stock-counts"] }),
      ]);
      const entry = (data as unknown as { line?: { status?: string; unexpected?: boolean } })?.line ?? {};
      toast({
        title: entry.unexpected ? "Unexpected item counted" : "Counted",
        description: entry.unexpected
          ? "This variant was not in the snapshot — it will be reviewed as an unexpected line."
          : "Quantity incremented by 1.",
      });
    },
    onError: (error) => toast({ title: "Scan rejected", description: error.message, variant: "destructive" }),
  });

  const lineMutation = useMutation({
    mutationFn: (input: {
      line: RetailStockCountSessionLine;
      countedQuantity?: number;
      recountRequired?: boolean;
      notes?: string;
    }) =>
      updateRetailStockCountLine(session!.id, input.line.id, {
        countedQuantity: input.countedQuantity,
        recountRequired: input.recountRequired,
        notes: input.notes,
      }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["retail-stock-count"] }),
        queryClient.invalidateQueries({ queryKey: ["retail-stock-counts"] }),
      ]);
    },
    onError: (error) =>
      toast({ title: "Could not update the line", description: error.message, variant: "destructive" }),
  });

  const lines = useMemo(() => session?.lines ?? [], [session]);
  const canCount = session?.status === "counting";
  const report = reportQuery.data;

  if (!retailEnabled) return null;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-4 p-3 pb-24 md:p-5 xl:pb-5">
      <RetailNav />
      <div className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm md:flex-row md:items-end md:justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
            <ClipboardList className="h-6 w-6" /> Physical stock count
          </h1>
          <p className="text-sm text-muted-foreground">
            Snapshot expected quantities, scan or key what is on the shelf, review variances, then finalize — inventory
            only changes through the movements written at finalization.
          </p>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-56">
            <Label htmlFor="stock-count-location">Location</Label>
            <select
              id="stock-count-location"
              value={locationId}
              onChange={(event) => setLocationId(event.target.value ? Number(event.target.value) : "")}
              className="mt-1 h-10 w-full rounded-md border bg-background px-3 text-sm"
              data-testid="stock-count-location"
            >
              <option value="">Select location</option>
              {locations.map((location) => (
                <option key={location.id} value={location.id}>
                  {location.name}
                </option>
              ))}
            </select>
          </div>
          <label className="flex h-10 items-center gap-2 rounded-md border px-3 text-sm">
            <input
              type="checkbox"
              checked={includeAllVariants}
              onChange={(event) => setIncludeAllVariants(event.target.checked)}
              data-testid="stock-count-all-variants"
            />
            Include variants with no stock here
          </label>
          <Button
            disabled={!locationId || createMutation.isPending}
            onClick={() => createMutation.mutate()}
            data-testid="stock-count-create"
          >
            <Play className="mr-1 h-4 w-4" /> {createMutation.isPending ? "Creating…" : "New count"}
          </Button>
        </div>
      </div>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,340px)_minmax(0,1fr)]">
        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-lg">Sessions</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {(sessionsQuery.data ?? []).map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setSelectedId(entry.id)}
                className={cn(
                  "flex w-full flex-col gap-1 rounded-lg border p-3 text-left text-sm transition hover:bg-muted/40",
                  selectedId === entry.id && "border-primary"
                )}
                data-testid="stock-count-session"
              >
                <span className="flex items-center justify-between gap-2">
                  <strong data-no-translate>{entry.code}</strong>
                  <span className={cn("rounded-full px-2 py-0.5 text-xs", statusClass(entry.status))}>
                    {STATUS_LABELS[entry.status] ?? entry.status}
                  </span>
                </span>
                <span className="text-xs text-muted-foreground" data-no-translate>
                  {entry.locationName ?? `#${entry.locationId}`} · {new Date(entry.createdAt).toLocaleString()}
                </span>
                <span className="text-xs text-muted-foreground">
                  {entry.countedLineCount}/{entry.lineCount} counted · variance {entry.varianceQuantityTotal}
                </span>
              </button>
            ))}
            {!sessionsQuery.isLoading && !(sessionsQuery.data ?? []).length && (
              <div className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
                No stock counts yet at this location.
              </div>
            )}
          </CardContent>
        </Card>

        <div className="space-y-4">
          {!session ? (
            <Card>
              <CardContent className="p-8 text-center text-sm text-muted-foreground">
                Start a count or pick a session to continue.
              </CardContent>
            </Card>
          ) : (
            <Card>
              <CardHeader className="space-y-3 pb-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <CardTitle className="flex items-center gap-2 text-lg">
                    <span data-no-translate>{session.code}</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-normal", statusClass(session.status))}>
                      {STATUS_LABELS[session.status] ?? session.status}
                    </span>
                  </CardTitle>
                  <div className="flex flex-wrap gap-2">
                    {session.status === "draft" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => transitionMutation.mutate({ action: "start" })}
                        data-testid="stock-count-start"
                      >
                        <Play className="mr-1 h-3.5 w-3.5" /> Start counting
                      </Button>
                    )}
                    {session.status === "counting" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => transitionMutation.mutate({ action: "review" })}
                        data-testid="stock-count-review"
                      >
                        Send to review
                      </Button>
                    )}
                    {(session.status === "review" || session.status === "counting") && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => transitionMutation.mutate({ action: "recount" })}
                        data-testid="stock-count-recount"
                      >
                        <RotateCcw className="mr-1 h-3.5 w-3.5" /> Recount flagged
                      </Button>
                    )}
                    {session.status !== "finalized" && session.status !== "canceled" && (
                      <>
                        <Button size="sm" onClick={() => setFinalizeOpen(true)} data-testid="stock-count-finalize-open">
                          <Lock className="mr-1 h-3.5 w-3.5" /> Finalize
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => transitionMutation.mutate({ action: "cancel" })}
                        >
                          <Undo2 className="mr-1 h-3.5 w-3.5" /> Cancel
                        </Button>
                      </>
                    )}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <div className="rounded border p-2">
                    <div className="text-muted-foreground">Lines</div>
                    <strong>{session.lineCount}</strong>
                  </div>
                  <div className="rounded border p-2">
                    <div className="text-muted-foreground">Counted</div>
                    <strong>
                      {session.countedLineCount}
                      {session.uncountedLineCount > 0 ? ` · ${session.uncountedLineCount} uncounted` : ""}
                    </strong>
                  </div>
                  <div className="rounded border p-2">
                    <div className="text-muted-foreground">Variance</div>
                    <strong className={session.varianceQuantityTotal !== 0 ? "text-amber-700 dark:text-amber-400" : ""}>
                      {session.varianceQuantityTotal} · {session.varianceValueTotal}
                    </strong>
                  </div>
                  <div className="rounded border p-2">
                    <div className="text-muted-foreground">Unexpected</div>
                    <strong>{session.unexpectedLineCount}</strong>
                  </div>
                </div>
                {canCount && (
                  <form
                    className="flex gap-2"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const barcode = scanText.trim();
                      if (barcode) scanMutation.mutate(barcode);
                    }}
                  >
                    <div className="relative flex-1">
                      <ScanLine className="absolute left-3 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        ref={scanRef}
                        autoFocus
                        value={scanText}
                        onChange={(event) => setScanText(event.target.value)}
                        placeholder="Scan a barcode to add one unit"
                        className="h-11 pl-10"
                        data-testid="stock-count-scan"
                      />
                    </div>
                    <Button
                      type="submit"
                      disabled={!scanText.trim() || scanMutation.isPending}
                      data-testid="stock-count-scan-submit"
                    >
                      Count 1
                    </Button>
                  </form>
                )}
              </CardHeader>
              <CardContent className="space-y-3">
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                        <th className="p-2">Product</th>
                        <th className="p-2">Color</th>
                        <th className="p-2">Size</th>
                        <th className="p-2">Barcode</th>
                        <th className="p-2 text-right">Expected</th>
                        <th className="p-2 text-right">Counted</th>
                        <th className="p-2 text-right">Difference</th>
                        <th className="p-2">Status</th>
                        <th className="p-2">Notes</th>
                        <th className="p-2">Recount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {lines.map((line) => {
                        const difference =
                          line.countedQuantity === null
                            ? null
                            : Number((line.countedQuantity - line.expectedQuantity).toFixed(6));
                        return (
                          <tr key={line.id} className="border-b last:border-0" data-testid="stock-count-line">
                            <td className="p-2" data-no-translate>
                              <div className="font-medium">{line.name}</div>
                              <div className="text-xs text-muted-foreground">
                                {line.brand} · {line.code}
                              </div>
                            </td>
                            <td className="p-2" data-no-translate>
                              {line.color}
                            </td>
                            <td className="p-2" data-no-translate>
                              {line.size}
                            </td>
                            <td className="p-2 text-xs" data-no-translate>
                              {line.barcode}
                            </td>
                            <td className="p-2 text-right">{line.expectedQuantity}</td>
                            <td className="p-2 text-right">
                              {canCount ? (
                                <Input
                                  type="number"
                                  min="0"
                                  step="1"
                                  defaultValue={line.countedQuantity ?? ""}
                                  className="h-8 w-24 text-right"
                                  onBlur={(event) => {
                                    const raw = event.target.value;
                                    if (raw === "") return;
                                    const value = Number(raw);
                                    if (!Number.isFinite(value) || value < 0) return;
                                    if (value === line.countedQuantity) return;
                                    lineMutation.mutate({ line, countedQuantity: value });
                                  }}
                                  data-testid="stock-count-line-quantity"
                                />
                              ) : (
                                (line.countedQuantity ?? "—")
                              )}
                            </td>
                            <td className={cn("p-2 text-right", difference ? "font-medium" : "")}>
                              {difference === null ? "—" : difference > 0 ? `+${difference}` : difference}
                            </td>
                            <td className={cn("p-2", lineStatusClass(line.status))}>
                              {LINE_STATUS_LABELS[line.status]}
                              {line.recountRequired && <span className="ml-1 text-xs">· recount</span>}
                            </td>
                            <td className="p-2 text-xs text-muted-foreground" data-no-translate>
                              {line.notes ?? ""}
                            </td>
                            <td className="p-2">
                              <input
                                type="checkbox"
                                checked={line.recountRequired}
                                disabled={session.status === "finalized" || session.status === "canceled"}
                                onChange={(event) =>
                                  lineMutation.mutate({ line, recountRequired: event.target.checked })
                                }
                                data-testid="stock-count-line-recount"
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {!lines.length && (
                  <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                    No lines yet — send the draft into counting to snapshot expected quantities.
                  </div>
                )}
                {session.status === "finalized" && (
                  <div className="rounded-lg border bg-muted/30 p-3 text-sm" data-testid="stock-count-finalized">
                    Finalized {session.finalizedAt ? new Date(session.finalizedAt).toLocaleString() : ""} ·{" "}
                    {session.movementCount ?? session.countedLineCount} movements written to the ledger
                    {session.varianceLineCount ? ` · ${session.varianceLineCount} variance lines` : ""}.
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {session?.status === "finalized" && varianceQuery.data && (
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-lg">Variance report — {session.code}</CardTitle>
              </CardHeader>
              <CardContent className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="p-2">Product</th>
                      <th className="p-2 text-right">Snapshot</th>
                      <th className="p-2 text-right">Counted</th>
                      <th className="p-2 text-right">Count variance</th>
                      <th className="p-2 text-right">Sales during count</th>
                      <th className="p-2 text-right">Movement</th>
                    </tr>
                  </thead>
                  <tbody>
                    {varianceQuery.data.lines.map((line) => (
                      <tr key={line.id} className="border-b last:border-0" data-no-translate>
                        <td className="p-2">
                          <div className="font-medium">{line.name}</div>
                          <div className="text-xs text-muted-foreground">
                            {line.color} · {line.size} · {line.barcode}
                          </div>
                        </td>
                        <td className="p-2 text-right">{line.expectedQuantity}</td>
                        <td className="p-2 text-right">{line.countedQuantity ?? "—"}</td>
                        <td className="p-2 text-right">{line.varianceQuantity ?? "—"}</td>
                        <td className="p-2 text-right">{line.movementDuringCount ?? "—"}</td>
                        <td className="p-2 text-right">{line.movementDelta ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
              <CardTitle className="text-lg">History &amp; variance</CardTitle>
              <a
                className="inline-flex items-center gap-1 text-sm text-primary underline-offset-2 hover:underline"
                href={retailStockCountReportCsvUrl(locationId || undefined)}
                data-testid="stock-count-csv"
              >
                <FileDown className="h-4 w-4" /> Export CSV
              </a>
            </CardHeader>
            <CardContent className="space-y-2">
              {report && (
                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                  <div className="rounded border p-2">
                    <div className="text-muted-foreground">Sessions</div>
                    <strong>{report.summary.sessionCount}</strong>
                  </div>
                  <div className="rounded border p-2">
                    <div className="text-muted-foreground">Finalized</div>
                    <strong>{report.summary.finalizedCount}</strong>
                  </div>
                  <div className="rounded border p-2">
                    <div className="text-muted-foreground">Net variance (units)</div>
                    <strong>{report.summary.varianceQuantityTotal}</strong>
                  </div>
                  <div className="rounded border p-2">
                    <div className="text-muted-foreground">Variance value</div>
                    <strong>{report.summary.varianceValueTotal}</strong>
                  </div>
                </div>
              )}
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs uppercase text-muted-foreground">
                      <th className="p-2">Session</th>
                      <th className="p-2">Status</th>
                      <th className="p-2">Location</th>
                      <th className="p-2 text-right">Lines</th>
                      <th className="p-2 text-right">Counted</th>
                      <th className="p-2 text-right">Variance</th>
                      <th className="p-2">Finalized</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report?.sessions ?? []).map((entry) => (
                      <tr
                        key={entry.id}
                        className="cursor-pointer border-b last:border-0 hover:bg-muted/40"
                        onClick={() => setSelectedId(entry.id)}
                        data-no-translate
                      >
                        <td className="p-2 font-medium">{entry.code}</td>
                        <td className="p-2">
                          <span className={cn("rounded-full px-2 py-0.5 text-xs", statusClass(entry.status))}>
                            {STATUS_LABELS[entry.status] ?? entry.status}
                          </span>
                        </td>
                        <td className="p-2">{entry.locationName ?? `#${entry.locationId}`}</td>
                        <td className="p-2 text-right">{entry.lineCount}</td>
                        <td className="p-2 text-right">{entry.countedLineCount}</td>
                        <td className="p-2 text-right">
                          {entry.varianceQuantityTotal} · {entry.varianceValueTotal}
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">
                          {entry.finalizedAt ? new Date(entry.finalizedAt).toLocaleString() : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          </Card>
        </div>
      </div>

      {finalizeOpen && session && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog">
          <div className="w-full max-w-md space-y-3 rounded-xl border bg-background p-4 shadow-lg">
            <h2 className="text-lg font-semibold">Finalize {session.code}</h2>
            <p className="text-sm text-muted-foreground">
              {session.countedLineCount}/{session.lineCount} lines counted · variance {session.varianceQuantityTotal}{" "}
              units. Finalization writes one stock movement per counted line and cannot be repeated.
            </p>
            {session.uncountedLineCount > 0 && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={allowUncounted}
                  onChange={(event) => setAllowUncounted(event.target.checked)}
                  data-testid="stock-count-allow-uncounted"
                />
                Leave {session.uncountedLineCount} uncounted lines untouched
              </label>
            )}
            {session.varianceLineCount > 0 && (
              <label className="flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={confirmVariance}
                  onChange={(event) => setConfirmVariance(event.target.checked)}
                  data-testid="stock-count-confirm-variance"
                />
                I confirm the {session.varianceLineCount} variance lines are correct
              </label>
            )}
            <div>
              <Label htmlFor="stock-count-finalize-notes">Notes (optional)</Label>
              <Input
                id="stock-count-finalize-notes"
                value={finalizeNotes}
                onChange={(event) => setFinalizeNotes(event.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setFinalizeOpen(false)}>
                Cancel
              </Button>
              <Button
                disabled={finalizeMutation.isPending}
                onClick={() => finalizeMutation.mutate()}
                data-testid="stock-count-finalize"
              >
                {finalizeMutation.isPending ? "Finalizing…" : "Finalize count"}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

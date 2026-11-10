/**
 * Phase 4 — read-only comparison of the selected loading against physical
 * truck-verification evidence, with a separate per-trip view.
 *
 * Trip targets are displayed only when an actual allocation exists.
 * Priority-driven allocation and corrections belong to Phases 5 and 6.
 */
import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  ClipboardCheck,
  FileSearch,
  Layers3,
  Loader2,
  Package,
  RefreshCw,
  Printer,
  Search,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { TabsList, PillTabButton } from "@/components/ui/tabs";
import { companyQueryKey } from "@/lib/companyQueryScope";

import {
  Comparison,
  Filter,
  PAGE_SIZE,
  printNumber,
  tripLabel,
  dispatchBase,
  comparePath,
  StatusBadge,
  Metric,
  Findings,
  getComparison,
} from "./FactoryLoadingDispatchCompareParts";

export default function FactoryLoadingDispatchCompare() {
  const { orderId: orderIdText, dispatchId: dispatchIdText } = useParams<{ orderId: string; dispatchId?: string }>();
  const orderId = Number(orderIdText);
  const dispatchId = dispatchIdText ? Number(dispatchIdText) : null;
  const valid =
    Number.isSafeInteger(orderId) &&
    orderId > 0 &&
    (dispatchId === null || (Number.isSafeInteger(dispatchId) && dispatchId > 0));
  const [, navigate] = useLocation();
  const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState("");
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [selectedMissing, setSelectedMissing] = useState<number[]>([]);
  const [removeOpen, setRemoveOpen] = useState(false);
  const [removing, setRemoving] = useState(false);
  const { toast } = useToast();
  const { data: auth } = useQuery<{
    currentCompanyId?: number | null;
    currentRole?: string | null;
    role?: string | null;
  }>({ queryKey: ["/api/auth/me"] });
  const companyId = auth?.currentCompanyId;
  const url =
    "/api/factory/customer-orders/" +
    orderId +
    "/loading-dispatches" +
    (dispatchId ? "/" + dispatchId : "") +
    "/comparison";
  const comparison = useQuery<Comparison>({
    queryKey: companyQueryKey(url, companyId),
    queryFn: () => getComparison(url),
    enabled: valid && Boolean(companyId),
    refetchInterval: 5000,
  });
  const result = comparison.data;
  const s = result?.summary;
  const articles = useMemo(() => result?.articles ?? [], [result?.articles]);
  const selectedId = dispatchId === null ? undefined : String(dispatchId);
  const missingFromLoading = (result?.missingBales ?? []).filter(
    (bale) => Number.isSafeInteger(bale.orderBaleId) && Number(bale.orderBaleId) > 0
  );
  const allTripsEnded =
    Boolean(result?.trips.length) && (result?.trips.every((trip) => trip.status !== "OPEN") ?? false);
  const canReconcile =
    !selectedId &&
    allTripsEnded &&
    ["LOADING", "PENDING_VERIFICATION"].includes(result?.loadingStatus ?? "") &&
    ["admin", "owner", "developer"].includes((auth?.currentRole ?? auth?.role ?? "").toLowerCase());
  const selectedCurrent = selectedMissing.filter((id) => missingFromLoading.some((bale) => bale.orderBaleId === id));
  const selectedBales = missingFromLoading.filter((bale) => selectedCurrent.includes(bale.orderBaleId!));
  const selectedKg = selectedBales.reduce((sum, bale) => sum + (Number(bale.weightKg) || 0), 0);
  const selectAllMissing = () => {
    setSelectedMissing(
      selectedCurrent.length === missingFromLoading.length ? [] : missingFromLoading.map((bale) => bale.orderBaleId!)
    );
  };
  const removeSelected = async () => {
    if (!canReconcile || removing || selectedCurrent.length === 0) return;
    setRemoving(true);
    let removed = 0;
    let failure: string | null = null;
    try {
      // Only loading links are removed; dispatch scan evidence stays untouched.
      for (const id of selectedCurrent) {
        await apiRequest(
          "DELETE",
          "/api/factory/customer-orders/" + orderId + "/bales/" + id + "?source=dispatch-reconciliation"
        );
        removed++;
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : "Loading reconciliation failed";
    } finally {
      setRemoving(false);
      setRemoveOpen(false);
      setSelectedMissing([]);
      await comparison.refetch();
      void queryClient.invalidateQueries({
        queryKey: companyQueryKey("/api/factory/customer-orders/" + orderId, companyId),
      });
    }
    toast({
      title: failure ? "Reconciliation partially completed" : "Pending Loading updated",
      description: removed + " unscanned bale(s) removed from the loading order" + (failure ? ". " + failure : "."),
      variant: failure ? "destructive" : "default",
    });
  };

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return articles.filter((article) => {
      if (filter === "missing" && !((article.missingQty ?? 0) > 0)) return false;
      if (filter === "extra" && article.extraQty <= 0) return false;
      if (filter === "match" && article.status !== "MATCH") return false;
      if (filter === "unplanned" && article.status !== "UNPLANNED") return false;
      return (
        !query || article.articleCode.toLowerCase().includes(query) || article.productName.toLowerCase().includes(query)
      );
    });
  }, [articles, filter, search]);

  if (!valid) {
    return <div className="p-6 text-sm text-destructive">Invalid loading or dispatch number.</div>;
  }

  return (
    <div
      className="h-full min-w-0 overflow-y-auto bg-slate-50/80 p-3 pb-10 dark:bg-[#080f1c] sm:p-5 lg:p-7"
      data-testid="factory-dispatch-comparison-page"
    >
      <div className="mx-auto max-w-[1480px] space-y-4">
        <div className="rounded-2xl border border-blue-200 bg-gradient-to-r from-white via-blue-50 to-sky-100 p-4 dark:border-blue-500/25 dark:from-[#142441] dark:via-[#112848] dark:to-[#0a2952] sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <div className="rounded-xl bg-blue-600 p-3 text-white">
                <Layers3 className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-lg font-bold sm:text-xl">Dispatch Comparison</h1>
                  <Badge variant="secondary">Loading #{orderId}</Badge>
                  {result?.containerNumber && <Badge variant="outline">{result.containerNumber}</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  {result?.dispatch ? tripLabel(result.dispatch.dispatchNumber) : "All truck trips"} · Physical
                  verification versus loaded bale references
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate(dispatchBase(orderId) + (selectedId ? "/" + selectedId : ""))}
              >
                <ArrowLeft className="mr-1.5 h-4 w-4" /> Back to {selectedId ? "trip" : "dispatches"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => navigate(dispatchBase(orderId) + (selectedId ? "/" + selectedId : "") + "/report")}
                data-testid="button-compare-dispatch-report"
              >
                <Printer className="mr-1.5 h-4 w-4" /> Print / Export
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={() => void comparison.refetch()}
                disabled={comparison.isFetching}
              >
                <RefreshCw className={"mr-1.5 h-4 w-4" + (comparison.isFetching ? " animate-spin" : "")} /> Refresh
              </Button>
            </div>
          </div>
        </div>

        {comparison.isError && (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/20">
            <span>{comparison.error instanceof Error ? comparison.error.message : "Unable to load comparison"}</span>
            <Button size="sm" variant="outline" onClick={() => void comparison.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {comparison.isPending && (
          <div className="flex items-center gap-2 rounded-xl border p-5 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Comparing Pending Loading with physical truck scans…
          </div>
        )}

        {result && (
          <>
            <div className="overflow-x-auto pb-1">
              <TabsList className="w-max" aria-label="Compare all trucks or an individual dispatch">
                <PillTabButton
                  selected={selectedId === undefined}
                  onClick={() => {
                    setFilter("all");
                    setSearch("");
                    navigate(comparePath(orderId));
                  }}
                >
                  All trips
                </PillTabButton>
                {result.trips.map((trip) => (
                  <PillTabButton
                    key={trip.id}
                    selected={selectedId === String(trip.id)}
                    onClick={() => {
                      setFilter("all");
                      setSearch("");
                      navigate(comparePath(orderId, String(trip.id)));
                    }}
                  >
                    #{String(trip.dispatchNumber).padStart(3, "0")} · {trip.scannedBales}
                  </PillTabButton>
                ))}
              </TabsList>
            </div>

            {!selectedId ? (
              <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-500/25 dark:bg-blue-500/10 dark:text-sky-200">
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  Pending Loading is the master bale list. After every trip ends, compare all scanned references against
                  it and choose which unscanned bales to remove.
                </p>
              </div>
            ) : !result.hasTripPlan ? (
              <div className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-600/30 dark:bg-amber-950/20 dark:text-amber-200">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  No targets are set per truck. This trip shows its physical scans only. Choose{" "}
                  <strong>All trips</strong> to compare against Pending Loading.
                </p>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50 p-3 text-xs text-blue-800 dark:border-blue-500/25 dark:bg-blue-500/10 dark:text-sky-200">
                <ClipboardCheck className="mt-0.5 h-4 w-4 shrink-0" />
                <p>
                  This trip shows its physical scans only. The missing-bale comparison comes from all completed trips
                  versus Pending Loading.
                </p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
              <Metric label="Pending Loading" value={printNumber(s?.loadedBales ?? null)} icon={Package} />
              <Metric label="Verified" value={printNumber(s?.verifiedBales ?? null)} icon={Truck} />
              <Metric
                label="Matched"
                value={printNumber(s?.matchedBales ?? null)}
                icon={CheckCircle2}
                emphasis="good"
              />
              <Metric
                label="Missing"
                value={printNumber(s?.missingBales ?? null)}
                icon={FileSearch}
                emphasis="warning"
              />
              <Metric
                label="Unexpected refs"
                value={printNumber(s?.unexpectedBales ?? null)}
                icon={AlertTriangle}
                emphasis="warning"
              />
            </div>

            {!selectedId && (
              <Card
                className="border-blue-200 bg-white dark:border-blue-500/25 dark:bg-[#101c34]"
                data-testid="pending-loading-final-reconciliation"
              >
                <CardContent className="space-y-4 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="space-y-1">
                      <h2 className="text-base font-bold">Final Pending Loading reconciliation</h2>
                      <p className="text-xs text-muted-foreground">
                        These are the exact bales still in Pending Loading but not scanned on any dispatch trip.
                        Selecting a bale does not change anything until you confirm removal.
                      </p>
                    </div>
                    <Badge variant="outline">{printNumber(missingFromLoading.length)} not scanned</Badge>
                  </div>
                  {!allTripsEnded && (
                    <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:border-amber-600/30 dark:bg-amber-950/20 dark:text-amber-200">
                      You can review missing bales now. To remove them from Pending Loading, finish all open dispatch
                      trips first.
                    </p>
                  )}
                  {missingFromLoading.length === 0 ? (
                    <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900 dark:border-emerald-700 dark:bg-emerald-950/20 dark:text-emerald-200">
                      No missing bale references. Every bale in the current loading is verified on a trip.
                    </p>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={selectAllMissing}
                          disabled={!canReconcile || removing}
                          data-testid="button-select-all-missing-bales"
                        >
                          {selectedCurrent.length === missingFromLoading.length
                            ? "Clear selection"
                            : "Select all missing"}
                        </Button>
                        <Button
                          type="button"
                          size="sm"
                          disabled={!canReconcile || removing || selectedCurrent.length === 0}
                          onClick={() => setRemoveOpen(true)}
                          data-testid="button-remove-selected-missing-bales"
                        >
                          Remove {selectedCurrent.length} selected from loading
                        </Button>
                      </div>
                      <div className="max-h-[360px] overflow-auto rounded-lg border dark:border-slate-700">
                        <table className="w-full min-w-[480px] text-left text-xs">
                          <thead className="sticky top-0 bg-slate-100 dark:bg-[#0b162a]">
                            <tr>
                              <th className="px-3 py-2">Select</th>
                              <th className="px-3 py-2">Bale reference</th>
                              <th className="px-3 py-2">Article</th>
                              <th className="px-3 py-2 text-right">KG</th>
                            </tr>
                          </thead>
                          <tbody>
                            {missingFromLoading.map((bale) => (
                              <tr key={bale.orderBaleId} className="border-t dark:border-slate-700">
                                <td className="px-3 py-2">
                                  <Checkbox
                                    checked={selectedCurrent.includes(bale.orderBaleId!)}
                                    disabled={!canReconcile || removing}
                                    onCheckedChange={(value) =>
                                      setSelectedMissing((ids) =>
                                        value === true
                                          ? [...ids.filter((id) => id !== bale.orderBaleId), bale.orderBaleId!]
                                          : ids.filter((id) => id !== bale.orderBaleId)
                                      )
                                    }
                                    aria-label={"Select missing bale " + bale.baleReference}
                                  />
                                </td>
                                <td className="px-3 py-2 font-mono font-semibold">{bale.baleReference}</td>
                                <td className="px-3 py-2">
                                  {bale.articleCode} <span className="text-muted-foreground">{bale.productName}</span>
                                </td>
                                <td className="px-3 py-2 text-right font-mono">{printNumber(bale.weightKg, 3)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                  <p className="text-[11px] text-muted-foreground">
                    Removal is restricted to Admin, Owner and Developer, and only for unscanned bales in active loading
                    orders. It uses the regular audited loading correction and returns the removed bales to stock.
                  </p>
                </CardContent>
              </Card>
            )}

            <Card className="border-blue-100 bg-white dark:border-blue-500/20 dark:bg-[#101c34]">
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-bold">Verification progress</p>
                  <p className="font-mono text-sm font-bold">
                    {printNumber(s?.progressPercent ?? null)}
                    {s?.progressPercent !== null && s?.progressPercent !== undefined ? "%" : ""}
                  </p>
                </div>
                <div className="h-2.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-[width]"
                    style={{ width: (s?.progressPercent ?? 0) + "%" }}
                  />
                </div>
                <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
                  <span>
                    {selectedId
                      ? "Trip scans are recorded without a per-truck target"
                      : "Pending Loading weight: " + printNumber(s?.expectedWeightKg ?? null, 3) + " kg"}
                  </span>
                  <span>Scanned weight: {printNumber(s?.verifiedWeightKg ?? null, 3)} kg</span>
                  <span>Weight difference: {printNumber(s?.weightDifferenceKg ?? null, 3)} kg</span>
                  <span>
                    Loading: {printNumber(s?.loadedBales ?? null)} bales · {printNumber(s?.loadedWeightKg ?? null, 3)}{" "}
                    kg
                  </span>
                </div>
                {s && s.duplicateBales > 0 && (
                  <p className="flex items-center gap-2 text-xs font-semibold text-red-600">
                    <AlertTriangle className="h-4 w-4" />
                    {s.duplicateBales} active duplicate anomalies
                  </p>
                )}
              </CardContent>
            </Card>

            <Card className="min-w-0 border-slate-200 bg-white dark:border-blue-500/20 dark:bg-[#101c34]">
              <CardContent className="space-y-3 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="text-base font-bold">Item-by-item comparison</h2>
                    <p className="text-xs text-muted-foreground">
                      Article quantities and verified KG; expand differences using the filters below.
                    </p>
                  </div>
                  <Badge variant="secondary">{printNumber(rows.length)} articles</Badge>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <div className="relative min-w-[180px] flex-1 sm:max-w-xs">
                    <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                    <Input
                      className="h-9 pl-9"
                      value={search}
                      onChange={(e) => {
                        setSearch(e.target.value);
                        setVisibleCount(PAGE_SIZE);
                      }}
                      placeholder="Search article or name"
                      data-testid="input-compare-article-search"
                    />
                  </div>
                  <div className="max-w-full overflow-x-auto">
                    <TabsList className="w-max" aria-label="Filter article comparison status">
                      {(
                        [
                          ["all", "All"],
                          ["missing", "Missing"],
                          ["extra", "Extra"],
                          ["match", "Match"],
                        ] as const
                      ).map(([value, label]) => (
                        <PillTabButton
                          key={value}
                          selected={filter === value}
                          onClick={() => {
                            setFilter(value);
                            setVisibleCount(PAGE_SIZE);
                          }}
                        >
                          {label}
                        </PillTabButton>
                      ))}
                    </TabsList>
                  </div>
                </div>
                <div className="overflow-x-auto rounded-xl border dark:border-slate-700">
                  <table className="w-full min-w-[900px] text-left text-xs">
                    <thead className="sticky top-0 bg-slate-100 text-muted-foreground dark:bg-[#0c192e]">
                      <tr>
                        <th className="px-3 py-3 font-semibold">Article</th>
                        <th className="px-3 py-3 text-right font-semibold">Pending Loading</th>
                        <th className="px-3 py-3 text-right font-semibold">Scanned</th>
                        <th className="px-3 py-3 text-right font-semibold">Missing</th>
                        <th className="px-3 py-3 text-right font-semibold">Extra</th>
                        <th className="px-3 py-3 text-right font-semibold">Loading KG</th>
                        <th className="px-3 py-3 text-right font-semibold">Scanned KG</th>
                        <th className="px-3 py-3 text-right font-semibold">KG difference</th>
                        <th className="px-3 py-3 font-semibold">Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.slice(0, visibleCount).map((article) => (
                        <tr
                          key={article.articleCode}
                          className="border-t dark:border-slate-700"
                          data-testid={"compare-article-" + article.articleCode}
                        >
                          <td className="px-3 py-3">
                            <p className="font-mono font-semibold">{article.articleCode}</p>
                            <p className="mt-0.5 max-w-[240px] truncate text-muted-foreground">
                              {article.productName || "—"}
                            </p>
                            {article.priorityRank !== null && (
                              <p className="text-[11px] text-blue-600">Priority {article.priorityRank}</p>
                            )}
                          </td>
                          <td className="px-3 py-3 text-right font-mono">{printNumber(article.expectedQty)}</td>
                          <td className="px-3 py-3 text-right font-mono">{printNumber(article.scannedQty)}</td>
                          <td
                            className={
                              "px-3 py-3 text-right font-mono " +
                              ((article.missingQty ?? 0) > 0 ? "font-bold text-amber-600" : "")
                            }
                          >
                            {printNumber(article.missingQty)}
                          </td>
                          <td
                            className={
                              "px-3 py-3 text-right font-mono " + (article.extraQty > 0 ? "font-bold text-red-600" : "")
                            }
                          >
                            {article.expectedQty === null ? "—" : printNumber(article.extraQty)}
                          </td>
                          <td className="px-3 py-3 text-right font-mono">{printNumber(article.expectedWeightKg, 3)}</td>
                          <td className="px-3 py-3 text-right font-mono">{printNumber(article.scannedWeightKg, 3)}</td>
                          <td className="px-3 py-3 text-right font-mono">
                            {printNumber(
                              article.expectedWeightKg === null
                                ? null
                                : article.expectedWeightKg - article.scannedWeightKg,
                              3
                            )}
                          </td>
                          <td className="px-3 py-3">
                            <StatusBadge value={article.status} />
                          </td>
                        </tr>
                      ))}
                      {rows.length === 0 && (
                        <tr>
                          <td colSpan={9} className="p-8 text-center text-muted-foreground">
                            No articles match this filter.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>
                {rows.length > visibleCount && (
                  <Button size="sm" variant="outline" onClick={() => setVisibleCount((v) => v + PAGE_SIZE)}>
                    Show more ({printNumber(rows.length - visibleCount)} remaining)
                  </Button>
                )}
              </CardContent>
            </Card>

            <div className="grid gap-4 xl:grid-cols-2">
              {selectedId && (
                <Findings
                  key={"missing-" + selectedId}
                  title="Missing bale references"
                  subtitle="Use All Trips to review the missing bale references from Pending Loading"
                  items={result.missingBales}
                  kind="missing"
                  orderId={orderId}
                />
              )}
              <Findings
                key={"unexpected-" + selectedId}
                title="Unexpected scanned references"
                subtitle="Scanned bales that are no longer in Pending Loading"
                items={result.unexpectedBales}
                kind="unexpected"
                orderId={orderId}
              />

              {result.duplicateBales.length > 0 && (
                <Findings
                  title="Duplicate active scan anomalies"
                  subtitle="Unexpected duplicate records despite database safeguards"
                  items={result.duplicateBales}
                  kind="duplicate"
                  orderId={orderId}
                />
              )}
            </div>

            <Card className="border-slate-200 dark:border-blue-500/20 dark:bg-[#101c34]">
              <CardContent className="space-y-3 p-4">
                <h3 className="text-sm font-bold">All truck trips</h3>
                {result.trips.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No dispatch records created yet.</p>
                ) : (
                  <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {result.trips.map((trip) => (
                      <button
                        key={trip.id}
                        type="button"
                        onClick={() => navigate(comparePath(orderId, String(trip.id)))}
                        className="flex items-center justify-between gap-2 rounded-xl border p-3 text-left transition-colors hover:border-blue-400 hover:bg-blue-50/60 dark:border-slate-700 dark:hover:bg-blue-500/10"
                        data-testid={"compare-trip-" + trip.id}
                      >
                        <span className="flex min-w-0 items-center gap-2">
                          <Truck className="h-4 w-4 shrink-0 text-blue-500" />
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-semibold">
                              {tripLabel(trip.dispatchNumber)}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">{trip.status}</span>
                          </span>
                        </span>
                        <span className="flex shrink-0 items-center gap-1 font-mono text-xs">
                          {trip.scannedBales} <ArrowRight className="h-3.5 w-3.5" />
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            <div className="flex flex-wrap items-center gap-2 border-t pt-4 text-xs text-muted-foreground dark:border-slate-700">
              <ShieldCheck className="h-4 w-4" />
              Scans are verification-only. Only a separately confirmed missing-bale removal changes Pending Loading.
            </div>
          </>
        )}
      </div>
      <Dialog
        open={removeOpen}
        onOpenChange={(open) => {
          if (!removing) setRemoveOpen(open);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Confirm missing-bale removal</DialogTitle>
            <DialogDescription>
              Remove {selectedCurrent.length} unscanned bale(s), totalling {printNumber(selectedKg, 3)} kg, from Pending
              Loading? They will return to stock using the existing loading correction process. Dispatch scan history
              remains unchanged.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button variant="outline" disabled={removing} onClick={() => setRemoveOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={!canReconcile || removing || selectedCurrent.length === 0}
              onClick={() => void removeSelected()}
              data-testid="button-confirm-remove-missing-bales"
            >
              {removing && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm removal
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

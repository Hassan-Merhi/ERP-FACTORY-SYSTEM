/**
 * Phase 5: plan one physical truck's expected contents without touching
 * loading, stock or financial records. User chooses quantities and optionally
 * exact barcodes; the server owns capacity and concurrency validation.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ClipboardList,
  Info,
  Loader2,
  Package,
  RefreshCw,
  Save,
  Search,
  ShieldCheck,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { apiRequest, queryClient } from "@/lib/queryClient";

interface ArticleRow {
  articleCode: string;
  productName: string;
  loadedQty: number;
  loadedWeightKg: number;
  reservedOtherQty: number;
  reservedHereQty: number;
  scannedHereQty: number;
  availableQty: number;
  expectedQty: number;
  priorityRank: number;
}
interface Candidate {
  baleId: number;
  baleReference: string;
  articleCode: string;
  productName: string;
  weightKg: number;
  orderIndex: number;
  assignedHere: boolean;
  scannedHere: boolean;
  assignedElsewhere: { dispatchId: string; dispatchNumber: number } | null;
}
interface Allocation {
  orderId: number;
  dispatchId: number;
  status: string;
  priority: {
    orderPriority: number;
    color: string;
    enabled: boolean;
    source: string;
  } | null;
  articleOrdering: string;
  articles: ArticleRow[];
  candidates: Candidate[];
  expectedArticles: Array<{ articleCode: string; expectedQty: number; priorityRank: number | null }>;
  expectedBales: Array<{ baleId: number; baleReference: string; articleCode: string }>;
  otherTrips: Array<{ dispatchId: string; reservedArticles: Array<{ articleCode: string; reservedQty: number }> }>;
}
interface Props {
  orderId: number;
  dispatchId: number;
  companyId: number | null | undefined;
  role: string;
  status: string;
  onChanged: () => void;
}
const PAGE_SIZE = 75;
function fmt(n: number): string {
  return Number(n || 0).toLocaleString();
}
function failMessage(e: unknown) {
  return e instanceof Error ? e.message : "Unable to save truck allocation";
}

export default function FactoryLoadingDispatchAllocation({
  orderId,
  dispatchId,
  companyId,
  role,
  status,
  onChanged,
}: Props) {
  const { toast } = useToast();
  const url = "/api/factory/customer-orders/" + orderId + "/loading-dispatches/" + dispatchId + "/allocations";
  const key = companyQueryKey(url, companyId);
  const privileged = ["admin", "owner", "developer"].includes(role.trim().toLowerCase());
  const editable = privileged && status === "OPEN";
  const [targets, setTargets] = useState<Record<string, string>>({});
  const [baleIds, setBaleIds] = useState<number[]>([]);
  const [autoPick, setAutoPick] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [baleQuery, setBaleQuery] = useState("");
  const [baleArticle, setBaleArticle] = useState("all");
  const [visibleBales, setVisibleBales] = useState(PAGE_SIZE);
  const [showBales, setShowBales] = useState(false);

  const allocation = useQuery<Allocation>({
    queryKey: key,
    queryFn: async () => {
      const response = await fetch(url, { credentials: "include", cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.message || "Unable to load truck allocation");
      }
      return response.json() as Promise<Allocation>;
    },
    enabled: Boolean(companyId) && orderId > 0 && dispatchId > 0,
    refetchInterval: 15000,
  });

  // Keep unsubmitted edits intact during background polling and when the
  // operator scans bales in another tab.
  useEffect(() => {
    const data = allocation.data;
    if (!data || dirty) return;
    setTargets(Object.fromEntries(data.expectedArticles.map((r) => [r.articleCode, String(r.expectedQty)])));
    setBaleIds(data.expectedBales.map((r) => r.baleId));
  }, [allocation.data, dirty]);

  const articles = useMemo(() => allocation.data?.articles ?? [], [allocation.data]);
  const candidates = useMemo(() => allocation.data?.candidates ?? [], [allocation.data]);
  const selected = useMemo(() => new Set(baleIds), [baleIds]);
  const changed = (article: string, value: string) => {
    setTargets((old) => ({ ...old, [article]: value }));
    setDirty(true);
  };
  const toggle = (id: number, checked: boolean) => {
    setBaleIds((old) => (checked ? [...new Set([...old, id])] : old.filter((value) => value !== id)));
    setDirty(true);
  };

  const preview = useMemo(() => {
    let expected = 0,
      valid = true,
      warning = "";
    for (const article of articles) {
      const raw = targets[article.articleCode] ?? "0";
      const n = raw.trim() === "" ? 0 : Number(raw);
      if (!Number.isSafeInteger(n) || n < 0 || n > article.availableQty) {
        valid = false;
        warning = "Article " + article.articleCode + " must have a target between 0 and " + article.availableQty;
        break;
      }
      expected += n;
    }
    if (valid && expected > 10000) {
      valid = false;
      warning = "A trip can reserve at most 10,000 bales";
    }
    if (valid) {
      const counts = new Map<string, number>();
      for (const bale of candidates) {
        if (!selected.has(bale.baleId)) continue;
        const article = bale.articleCode;
        counts.set(article, (counts.get(article) ?? 0) + 1);
        if (bale.assignedElsewhere && !bale.assignedHere) {
          valid = false;
          warning = bale.baleReference + " already belongs to Dispatch #" + bale.assignedElsewhere.dispatchNumber;
          break;
        }
      }
      if (valid)
        for (const [article, count] of counts) {
          if (count > Number(targets[article] || "0")) {
            valid = false;
            warning = "Selected/scanned bales for " + article + " exceed its target";
            break;
          }
        }
    }
    return { expected, valid, warning };
  }, [articles, candidates, selected, targets]);

  const save = useMutation({
    mutationFn: async () => {
      if (!preview.valid) throw new Error(preview.warning || "Invalid truck allocation");
      const lines = articles
        .map((article) => ({
          articleCode: article.articleCode,
          expectedQty: Number(targets[article.articleCode] || 0),
        }))
        .filter((r) => r.expectedQty > 0);
      const response = await apiRequest("PUT", url, {
        lines,
        baleIds,
        autoAssignBales: autoPick,
      });
      return response.json() as Promise<Allocation>;
    },
    onSuccess: (data) => {
      setDirty(false);
      setTargets(Object.fromEntries(data.expectedArticles.map((r) => [r.articleCode, String(r.expectedQty)])));
      setBaleIds(data.expectedBales.map((r) => r.baleId));
      queryClient.setQueryData(key, data);
      void queryClient.invalidateQueries({
        queryKey: companyQueryKey(
          "/api/factory/customer-orders/" + orderId + "/loading-dispatches/comparison",
          companyId
        ),
      });
      void queryClient.invalidateQueries({
        queryKey: companyQueryKey(
          "/api/factory/customer-orders/" + orderId + "/loading-dispatches/" + dispatchId + "/comparison",
          companyId
        ),
      });
      onChanged();
      toast({
        title: "Truck allocation saved",
        description: "Expected items and bale reservations are now available in Compare.",
      });
    },
    onError: (error) => {
      toast({ title: "Truck allocation not saved", description: failMessage(error), variant: "destructive" });
      void allocation.refetch();
    },
  });

  const filteredBales = useMemo(() => {
    const q = baleQuery.trim().toLowerCase();
    return candidates.filter(
      (b) =>
        (baleArticle === "all" || b.articleCode === baleArticle) &&
        (!q || [b.baleReference, b.articleCode, b.productName].some((v) => v.toLowerCase().includes(q)))
    );
  }, [candidates, baleQuery, baleArticle]);

  const loaded = articles.reduce((n, a) => n + a.loadedQty, 0);
  const planned = allocation.data?.expectedArticles.reduce((n, a) => n + a.expectedQty, 0) ?? 0;
  const taken = articles.reduce((n, a) => n + a.reservedOtherQty, 0);
  const resync = () => {
    setDirty(false);
    setBaleQuery("");
    void allocation.refetch();
  };

  return (
    <Card
      className="min-w-0 border-blue-200 bg-white dark:border-blue-500/30 dark:bg-[#101c34]"
      data-testid="dispatch-allocation-planner"
    >
      <CardContent className="space-y-4 p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <ClipboardList className="h-5 w-5 text-blue-600" />
              <h3 className="text-base font-bold">Expected Truck Load</h3>
              <Badge variant="outline">Phase 5</Badge>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Assign article quantities and optional exact bale references to this truck. These plans do not move stock
              or change main loading.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {dirty && <Badge variant="secondary">Unsaved changes</Badge>}
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={resync}
              disabled={save.isPending}
              data-testid="button-refresh-dispatch-allocation"
            >
              <RefreshCw className="mr-1.5 h-4 w-4" /> {dirty ? "Discard edits" : "Refresh"}
            </Button>
          </div>
        </div>

        {allocation.isError && (
          <div className="rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-950/20">
            {failMessage(allocation.error)}
          </div>
        )}
        {allocation.isLoading && (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading loading quantities and other truck reservations…
          </div>
        )}
        {allocation.data && (
          <>
            {allocation.data.priority ? (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-xs dark:border-blue-500/30 dark:bg-blue-500/10">
                <span
                  className="inline-block h-3.5 w-3.5 rounded-full border"
                  style={{ backgroundColor: allocation.data.priority.color }}
                />
                <span className="font-semibold">Loading queue priority #{allocation.data.priority.orderPriority}</span>
                <Badge variant="outline">
                  {allocation.data.priority.enabled ? "Priority Scan enabled" : "Last saved priority"}
                </Badge>
                <span className="text-muted-foreground">
                  Article rows follow the linked proforma / loading order, not separate color priorities.
                </span>
              </div>
            ) : (
              <div className="flex items-start gap-2 rounded-xl border p-3 text-xs text-muted-foreground">
                <Info className="mt-0.5 h-4 w-4 shrink-0" />
                No active Priority Scan queue entry for this loading. The article order still follows the linked
                proforma or loading lines.
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {(
                [
                  ["Loaded", loaded],
                  ["Reserved other trucks", taken],
                  ["Saved target", planned],
                  ["Selected exact bales", selected.size],
                ] as const
              ).map(([label, value]) => (
                <div key={label} className="rounded-xl bg-slate-50 p-3 dark:bg-[#0a172c]">
                  <p className="text-[11px] text-muted-foreground">{label}</p>
                  <p className="mt-1 font-mono text-lg font-bold">{fmt(value)}</p>
                </div>
              ))}
            </div>

            <div className="overflow-x-auto rounded-xl border dark:border-slate-700">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="bg-slate-100 dark:bg-[#0b182e]">
                  <tr>
                    <th className="px-3 py-2">Article (proforma order)</th>
                    <th className="px-3 py-2 text-right">Loaded</th>
                    <th className="px-3 py-2 text-right">Others reserved</th>
                    <th className="px-3 py-2 text-right">Available</th>
                    <th className="px-3 py-2 text-right">Verified here</th>
                    <th className="px-3 py-2 text-right">Expected on this truck</th>
                  </tr>
                </thead>
                <tbody>
                  {articles.map((a) => (
                    <tr key={a.articleCode} className="border-t dark:border-slate-700">
                      <td className="px-3 py-2">
                        <p className="font-mono font-semibold">{a.articleCode}</p>
                        <p className="max-w-56 truncate text-muted-foreground">{a.productName || "—"}</p>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(a.loadedQty)}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(a.reservedOtherQty)}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(a.availableQty)}</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(a.scannedHereQty)}</td>
                      <td className="px-3 py-2 text-right">
                        <Input
                          type="number"
                          min={0}
                          max={a.availableQty}
                          step={1}
                          className="ml-auto h-9 w-24 text-right font-mono"
                          aria-label={"Expected " + a.articleCode}
                          value={targets[a.articleCode] ?? "0"}
                          disabled={!editable || save.isPending}
                          onChange={(e) => changed(a.articleCode, e.target.value)}
                          data-testid={"input-dispatch-target-" + a.articleCode}
                        />
                      </td>
                    </tr>
                  ))}
                  {articles.length === 0 && (
                    <tr>
                      <td colSpan={6} className="p-5 text-center text-muted-foreground">
                        No bales have been added to the main loading yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-3 dark:border-slate-700">
              <div className="min-w-0">
                <p className="text-sm font-semibold">Auto-pick exact bale references</p>
                <p className="text-xs text-muted-foreground">
                  Keep already scanned bales here, then reserve available references in article/proforma order to fill
                  the quantities.
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {editable && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={save.isPending}
                    onClick={() => {
                      setBaleIds(candidates.filter((bale) => bale.scannedHere).map((bale) => bale.baleId));
                      setAutoPick(true);
                      setDirty(true);
                    }}
                    title="Clear unscanned exact reservations and rebuild using current targets when saved"
                    data-testid="button-rebalance-dispatch-plan"
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" /> Rebalance refs
                  </Button>
                )}
                <label className="flex items-center gap-2 text-sm font-medium">
                  <Checkbox
                    checked={autoPick}
                    onCheckedChange={(checked) => {
                      setAutoPick(checked === true);
                      setDirty(true);
                    }}
                    disabled={!editable || save.isPending}
                    data-testid="checkbox-dispatch-autopick"
                  />
                  Auto-pick
                </label>
              </div>
            </div>

            <div className="overflow-hidden rounded-xl border dark:border-slate-700">
              <button
                type="button"
                onClick={() => setShowBales((v) => !v)}
                className="flex w-full flex-wrap items-center justify-between gap-2 px-3 py-3 text-left text-sm font-semibold hover:bg-muted/30"
                data-testid="button-dispatch-manual-bales"
              >
                <span className="flex items-center gap-2">
                  <Package className="h-4 w-4 text-blue-500" />
                  Choose specific bale references
                  <Badge variant="secondary">{selected.size} chosen</Badge>
                </span>
                <span className="text-xs text-muted-foreground">{showBales ? "Collapse" : "Expand"}</span>
              </button>
              {showBales && (
                <div className="space-y-3 border-t p-3 dark:border-slate-700">
                  <div className="flex flex-wrap gap-2">
                    <div className="relative min-w-[200px] flex-1">
                      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        className="h-9 pl-9"
                        placeholder="Search reference or article"
                        value={baleQuery}
                        onChange={(e) => {
                          setBaleQuery(e.target.value);
                          setVisibleBales(PAGE_SIZE);
                        }}
                      />
                    </div>
                    <select
                      className="h-9 max-w-48 rounded-lg border bg-background px-3 text-xs"
                      value={baleArticle}
                      onChange={(e) => {
                        setBaleArticle(e.target.value);
                        setVisibleBales(PAGE_SIZE);
                      }}
                      aria-label="Filter bale article"
                    >
                      <option value="all">All articles</option>
                      {articles.map((a) => (
                        <option key={a.articleCode} value={a.articleCode}>
                          {a.articleCode}
                        </option>
                      ))}
                    </select>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    Manual picks are reserved in addition to any auto-filled references. Bales already assigned or
                    verified on other trucks cannot be selected.
                  </p>
                  <div className="max-h-[380px] overflow-y-auto rounded-lg border dark:border-slate-700">
                    {filteredBales.slice(0, visibleBales).map((b) => {
                      const blocked = Boolean(b.assignedElsewhere && !b.assignedHere);
                      return (
                        <label
                          key={b.baleId}
                          className={
                            "flex flex-wrap items-center gap-3 border-b p-2.5 text-xs last:border-b-0 dark:border-slate-700 " +
                            (blocked ? "opacity-60" : "hover:bg-blue-50/50 dark:hover:bg-blue-500/10")
                          }
                        >
                          <Checkbox
                            checked={selected.has(b.baleId)}
                            disabled={!editable || save.isPending || blocked || b.scannedHere}
                            onCheckedChange={(checked) => toggle(b.baleId, checked === true)}
                            aria-label={"Assign " + b.baleReference}
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block font-mono font-semibold">
                              {b.baleReference || "Bale #" + b.baleId}
                            </span>
                            <span className="text-muted-foreground">
                              {b.articleCode} · {b.productName || "Bale"} · {b.weightKg} kg
                            </span>
                          </span>
                          {b.scannedHere ? (
                            <Badge variant="outline" className="border-emerald-400 text-emerald-600">
                              Scanned here
                            </Badge>
                          ) : blocked ? (
                            <Badge variant="outline">Dispatch #{b.assignedElsewhere?.dispatchNumber}</Badge>
                          ) : b.assignedHere ? (
                            <Badge variant="secondary">Reserved here</Badge>
                          ) : null}
                        </label>
                      );
                    })}
                    {filteredBales.length === 0 && (
                      <p className="p-4 text-center text-xs text-muted-foreground">No loaded bales match the filter.</p>
                    )}
                  </div>
                  {filteredBales.length > visibleBales && (
                    <Button size="sm" variant="outline" onClick={() => setVisibleBales((v) => v + PAGE_SIZE)}>
                      Show next {Math.min(PAGE_SIZE, filteredBales.length - visibleBales)}
                    </Button>
                  )}
                </div>
              )}
            </div>

            {!preview.valid && (
              <div
                role="alert"
                className="flex items-start gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-xs text-amber-900 dark:bg-amber-950/20 dark:text-amber-200"
              >
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /> {preview.warning}
              </div>
            )}
            {editable ? (
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  Draft target: <strong>{fmt(preview.expected)}</strong> bales ·{" "}
                  {autoPick ? "exact refs auto-picked" : "exact refs manual only"}
                </p>
                <Button
                  disabled={!dirty || save.isPending || !preview.valid}
                  onClick={() => void save.mutate()}
                  data-testid="button-save-dispatch-allocation"
                >
                  {save.isPending ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <Save className="mr-2 h-4 w-4" />
                  )}
                  Save expected truck load
                </Button>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <ShieldCheck className="h-4 w-4" /> Only Admin, Owner or Developer can change expected loads on open
                dispatches.
              </p>
            )}
            {dirty && (
              <p className="flex items-center gap-2 text-xs text-blue-600 dark:text-sky-300">
                <Info className="h-3.5 w-3.5" /> Unsaved targets do not affect the scanner or comparison until saved.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

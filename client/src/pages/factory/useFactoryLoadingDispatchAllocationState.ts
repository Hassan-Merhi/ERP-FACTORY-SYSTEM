// Extracted from ./FactoryLoadingDispatchAllocation.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { PAGE_SIZE, failMessage, type Allocation, type Props } from "./FactoryLoadingDispatchAllocationTypes";

export function useFactoryLoadingDispatchAllocationState({
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

  const articles = useMemo(() => allocation.data?.articles ?? [], [allocation.data?.articles]);
  const candidates = useMemo(() => allocation.data?.candidates ?? [], [allocation.data?.candidates]);
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
  return {
    allocation,
    articles,
    autoPick,
    baleArticle,
    baleQuery,
    candidates,
    changed,
    dirty,
    editable,
    filteredBales,
    loaded,
    planned,
    preview,
    resync,
    save,
    selected,
    setAutoPick,
    setBaleArticle,
    setBaleIds,
    setBaleQuery,
    setDirty,
    setShowBales,
    setVisibleBales,
    showBales,
    taken,
    targets,
    toggle,
    visibleBales,
  };
}

import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";
import { searchAny } from "@shared/searchNormalization";
import { useState, useMemo } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { useMobileCardTable } from "@/components/ui/mobile-card-table";
import type { MergedRow, Preset, ReportData, SupplierDayRow } from "./types";
import {
  deriveGrade,
  lastMonthRange,
  lastYearRange,
  mergeProductionPeriods,
  thisMonthRange,
  thisYearRange,
  todayStr,
  yesterdayStr,
  escapeSupplierCsvCell,
} from "./utils";
import { buildWorkerSummaryByArticle } from "./components/WorkerSummaryHover";

export function useProductionComparisonModel() {
  const [preset, setPreset] = useState<Preset>("month");

  const [customA, setCustomA] = useState<[string, string]>([todayStr(), todayStr()]);
  const [customB, setCustomB] = useState<[string, string]>([yesterdayStr(), yesterdayStr()]);

  // Filters — multi-select for category and grade
  const [filterCategories, setFilterCategories] = useState<string[]>([]);
  const [filterGrades, setFilterGrades] = useState<string[]>([]);
  const [filterProduct, setFilterProduct] = useState("");
  // Worker filter (multi-select by worker ID)
  const [filterWorkers, setFilterWorkers] = useState<string[]>([]);
  // Supplier mix breakdown filter
  const [filterSuppliers, setFilterSuppliers] = useState<string[]>([]);
  const isPhoneLayout = useErpPhoneLayout();
  const [phoneTableView, setPhoneTableView] = useState(false);
  const comparisonCards = useMobileCardTable(!phoneTableView);

  const { data: workers = [] } = useQuery<{ id: number; fullName: string; active?: boolean }[]>({
    queryKey: ["/api/factory/workers?profile=picker"],
    staleTime: 60_000,
  });

  const { data: baleProducts = [] } = useQuery<
    Array<{ code: string; articleCode?: string | null; nameAr?: string | null }>
  >({
    queryKey: ["/api/factory/bale-products?profile=picker"],
    staleTime: 60_000,
  });

  // Worker categories — the filter only offers the pressing-team workers.
  const { data: workerCategories = [] } = useQuery<{ id: number; name: string; workerIds: number[] }[]>({
    queryKey: ["/api/factory/worker-categories"],
    staleTime: 60_000,
    queryFn: async () => {
      const r = await fetch("/api/factory/worker-categories", { credentials: "include" });
      if (!r.ok) throw new Error("Failed to load worker categories");
      return r.json();
    },
  });

  // Only workers belonging to a "pressing" category are selectable.  When no such
  // category exists yet, fall back to every active worker so the filter still works.
  const workerOptions = useMemo(() => {
    const pressingIds = new Set<number>();
    for (const cat of workerCategories) {
      if (!(cat.name || "").toLowerCase().includes("pressing")) continue;
      for (const id of Array.isArray(cat.workerIds) ? cat.workerIds : []) pressingIds.add(Number(id));
    }
    const active = workers.filter((w) => w.active !== false);
    const pool = pressingIds.size > 0 ? active.filter((w) => pressingIds.has(w.id)) : active;
    return pool
      .slice()
      .sort((a, b) => (a.fullName || "").localeCompare(b.fullName || ""))
      .map((w) => ({ value: String(w.id), label: w.fullName }));
  }, [workers, workerCategories]);

  const arabicNameByArticle = useMemo(() => {
    const map = new Map<string, string>();
    const add = (key: string | null | undefined, nameAr: string | null | undefined) => {
      const normalized = (key || "").trim().toUpperCase();
      const name = (nameAr || "").trim();
      if (normalized && name) map.set(normalized, name);
    };
    for (const product of baleProducts) {
      add(product.articleCode, product.nameAr);
      add(product.code, product.nameAr);
    }
    return map;
  }, [baleProducts]);

  // Stable key for the query cache / request param.
  const workerIdsParam = useMemo(() => [...filterWorkers].sort().join(","), [filterWorkers]);

  const [rangeA, rangeB] = useMemo<[[string, string], [string, string]]>(() => {
    if (preset === "today-yesterday")
      return [
        [todayStr(), todayStr()],
        [yesterdayStr(), yesterdayStr()],
      ];
    if (preset === "month") return [thisMonthRange(), lastMonthRange()];
    if (preset === "year") return [thisYearRange(), lastYearRange()];
    return [customA, customB];
  }, [preset, customA, customB]);

  const labelA: "Today" | "This Month" | "This Year" | "Period A" =
    preset === "today-yesterday"
      ? "Today"
      : preset === "month"
        ? "This Month"
        : preset === "year"
          ? "This Year"
          : "Period A";
  const labelB: "Yesterday" | "Last Month" | "Last Year" | "Period B" =
    preset === "today-yesterday"
      ? "Yesterday"
      : preset === "month"
        ? "Last Month"
        : preset === "year"
          ? "Last Year"
          : "Period B";

  const qA = useQuery<ReportData>({
    queryKey: ["/api/factory/production-value-report", rangeA[0], rangeA[1], workerIdsParam, "production-comparison"],
    staleTime: 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams({ from: rangeA[0], to: rangeA[1], view: "production-comparison" });
      if (workerIdsParam) params.set("workerIds", workerIdsParam);
      const r = await fetch(`/api/factory/production-value-report?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? "Request failed");
      return r.json();
    },
  });

  const qB = useQuery<ReportData>({
    queryKey: ["/api/factory/production-value-report", rangeB[0], rangeB[1], workerIdsParam, "production-comparison"],
    staleTime: 0,
    placeholderData: keepPreviousData,
    queryFn: async () => {
      const params = new URLSearchParams({ from: rangeB[0], to: rangeB[1], view: "production-comparison" });
      if (workerIdsParam) params.set("workerIds", workerIdsParam);
      const r = await fetch(`/api/factory/production-value-report?${params}`, { credentials: "include" });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message ?? "Request failed");
      return r.json();
    },
  });

  const isLoading = qA.isLoading || qB.isLoading;
  const fetchError = qA.error || qB.error;
  const costsHidden = Boolean(qA.data?.costsHidden || qB.data?.costsHidden);

  const { categories, grades } = useMemo(() => {
    const catSet = new Set<string>();
    const gradeSet = new Set<string>();
    for (const row of [...(qA.data?.production.byProduct ?? []), ...(qB.data?.production.byProduct ?? [])]) {
      if (row.categoryName) catSet.add(row.categoryName);
      const g = deriveGrade(row.articleCode);
      if (g !== "—") gradeSet.add(g);
    }
    return { categories: [...catSet].sort(), grades: [...gradeSet].sort() };
  }, [qA.data, qB.data]);

  const workerSummaryByArticle = useMemo(
    () => buildWorkerSummaryByArticle(qA.data?.production.byProduct ?? [], qB.data?.production.byProduct ?? []),
    [qA.data, qB.data]
  );

  const mergedAll = useMemo<MergedRow[]>(
    () => mergeProductionPeriods(qA.data?.production.byProduct ?? [], qB.data?.production.byProduct ?? []),
    [qA.data, qB.data]
  );

  const filtered = useMemo(
    () =>
      mergedAll
        .filter((r) => filterCategories.length === 0 || filterCategories.includes(r.categoryName))
        .filter((r) => filterGrades.length === 0 || filterGrades.includes(r.grade))
        .filter((r) => {
          if (!filterProduct) return true;
          const arabicName = arabicNameByArticle.get(r.articleCode.trim().toUpperCase()) ?? "";
          return searchAny(filterProduct, r.articleCode, r.productName, arabicName);
        })
        .sort((a, b) => (a.productName || a.articleCode).localeCompare(b.productName || b.articleCode)),
    [mergedAll, filterCategories, filterGrades, filterProduct, arabicNameByArticle]
  );

  const totalABales = filtered.reduce((s, r) => s + r.aQty, 0);
  const totalBBales = filtered.reduce((s, r) => s + r.bQty, 0);
  const totalAKg = filtered.reduce((s, r) => s + r.aKg, 0);
  const totalBKg = filtered.reduce((s, r) => s + r.bKg, 0);
  const baleDiff = totalABales - totalBBales;
  const kgDiff = totalAKg - totalBKg;

  // ── Batch KPI (follows the same category/grade/product/worker filters as production) ──
  const linkedBatchMapA = useMemo(
    () => new Map((qA.data?.production.linkedBatches ?? []).map((batch) => [batch.id, batch.totalWeightKg] as const)),
    [qA.data]
  );
  const linkedBatchMapB = useMemo(
    () => new Map((qB.data?.production.linkedBatches ?? []).map((batch) => [batch.id, batch.totalWeightKg] as const)),
    [qB.data]
  );

  const filteredBatchIdsA = useMemo(() => {
    const ids = new Set<number>();
    for (const row of filtered) {
      for (const id of row.aMixBatchIds) {
        if (linkedBatchMapA.has(id)) ids.add(id);
      }
    }
    return ids;
  }, [filtered, linkedBatchMapA]);

  const filteredBatchIdsB = useMemo(() => {
    const ids = new Set<number>();
    for (const row of filtered) {
      for (const id of row.bMixBatchIds) {
        if (linkedBatchMapB.has(id)) ids.add(id);
      }
    }
    return ids;
  }, [filtered, linkedBatchMapB]);

  const totalABatches = filteredBatchIdsA.size;
  const totalBBatches = filteredBatchIdsB.size;
  const totalABatchAmount = [...filteredBatchIdsA].reduce((sum, id) => sum + (linkedBatchMapA.get(id) ?? 0), 0);
  const totalBBatchAmount = [...filteredBatchIdsB].reduce((sum, id) => sum + (linkedBatchMapB.get(id) ?? 0), 0);

  // ── Profit ──
  const profitA = costsHidden ? null : (qA.data?.summary?.statusValue ?? null);
  const profitB = costsHidden ? null : (qB.data?.summary?.statusValue ?? null);
  const profitDiff = profitA != null && profitB != null ? profitA - profitB : null;

  // ── Supplier mix breakdown ──
  const allSuppliers = useMemo(() => {
    const s = new Set<string>();
    for (const r of [...(qA.data?.supplierMixBreakdown ?? []), ...(qB.data?.supplierMixBreakdown ?? [])]) {
      if (r.supplierName) s.add(r.supplierName);
    }
    return [...s].sort();
  }, [qA.data, qB.data]);

  const supplierBreakdownA = useMemo(() => {
    const rows = (qA.data?.supplierMixBreakdown ?? []).filter(
      (r) => filterSuppliers.length === 0 || filterSuppliers.includes(r.supplierName)
    );
    return rows;
  }, [qA.data, filterSuppliers]);

  const supplierBreakdownB = useMemo(() => {
    const rows = (qB.data?.supplierMixBreakdown ?? []).filter(
      (r) => filterSuppliers.length === 0 || filterSuppliers.includes(r.supplierName)
    );
    return rows;
  }, [qB.data, filterSuppliers]);

  // Merged supplier summary: per-supplier totals for A and B
  const supplierSummary = useMemo(() => {
    const map = new Map<string, { supplier: string; aKg: number; aCost: number; bKg: number; bCost: number }>();
    const add = (rows: SupplierDayRow[], period: "a" | "b") => {
      for (const r of rows) {
        const ex = map.get(r.supplierName);
        if (ex) {
          if (period === "a") {
            ex.aKg += r.totalKg;
            ex.aCost += r.totalCost ?? 0;
          } else {
            ex.bKg += r.totalKg;
            ex.bCost += r.totalCost ?? 0;
          }
        } else {
          map.set(
            r.supplierName,
            period === "a"
              ? { supplier: r.supplierName, aKg: r.totalKg, aCost: r.totalCost ?? 0, bKg: 0, bCost: 0 }
              : { supplier: r.supplierName, aKg: 0, aCost: 0, bKg: r.totalKg, bCost: r.totalCost ?? 0 }
          );
        }
      }
    };
    add(supplierBreakdownA, "a");
    add(supplierBreakdownB, "b");
    return [...map.values()].sort((a, b) => a.supplier.localeCompare(b.supplier));
  }, [supplierBreakdownA, supplierBreakdownB]);

  // Per-day breakdown (combined A+B rows, labelled by period)
  const dailyBreakdown = useMemo(() => {
    const rows: Array<SupplierDayRow & { period: string }> = [
      ...supplierBreakdownA.map((r) => ({ ...r, period: labelA })),
      ...supplierBreakdownB.map((r) => ({ ...r, period: labelB })),
    ];
    return rows.sort((a, b) =>
      a.date !== b.date
        ? a.date.localeCompare(b.date)
        : a.period !== b.period
          ? a.period.localeCompare(b.period)
          : a.supplierName.localeCompare(b.supplierName)
    );
  }, [supplierBreakdownA, supplierBreakdownB, labelA, labelB]);

  const totalSupAKg = supplierBreakdownA.reduce((s, r) => s + r.totalKg, 0);
  const totalSupACost = supplierBreakdownA.reduce((s, r) => s + (r.totalCost ?? 0), 0);
  const totalSupBKg = supplierBreakdownB.reduce((s, r) => s + r.totalKg, 0);
  const totalSupBCost = supplierBreakdownB.reduce((s, r) => s + (r.totalCost ?? 0), 0);
  const totalSupKgDiff = totalSupAKg - totalSupBKg;
  const totalSupCostDiff = totalSupACost - totalSupBCost;

  const hasSupplierFilter = filterSuppliers.length > 0;

  /** CSV respects the selected supplier filter and cost-field permissions. */
  function exportSupplierCsv() {
    const header = ["Supplier", labelA + " KG", labelB + " KG", "KG Difference", "KG Change %"];
    if (!costsHidden)
      header.push(
        labelA + " Cost USD",
        labelA + " Rate/KG",
        labelB + " Cost USD",
        labelB + " Rate/KG",
        "Cost Difference USD"
      );
    const rows = supplierSummary.map((row) => {
      const values = [
        row.supplier,
        String(row.aKg),
        String(row.bKg),
        String(row.aKg - row.bKg),
        row.bKg > 0 ? String(((row.aKg - row.bKg) / row.bKg) * 100) : "",
      ];
      if (!costsHidden) {
        values.push(
          String(row.aCost),
          row.aKg > 0 ? String(row.aCost / row.aKg) : "",
          String(row.bCost),
          row.bKg > 0 ? String(row.bCost / row.bKg) : "",
          String(row.aCost - row.bCost)
        );
      }
      return values;
    });
    const csv = [header, ...rows].map((row) => row.map(escapeSupplierCsvCell).join(",")).join("\r\n");
    downloadBlob(
      new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }),
      exportFileName("production supplier comparison", "csv")
    );
  }

  return {
    preset,
    setPreset,
    customA,
    setCustomA,
    customB,
    setCustomB,
    filterCategories,
    setFilterCategories,
    filterGrades,
    setFilterGrades,
    filterProduct,
    setFilterProduct,
    filterWorkers,
    setFilterWorkers,
    filterSuppliers,
    setFilterSuppliers,
    isPhoneLayout,
    phoneTableView,
    setPhoneTableView,
    comparisonCards,
    workerOptions,
    arabicNameByArticle,
    rangeA,
    rangeB,
    labelA,
    labelB,
    isLoading,
    fetchError,
    costsHidden,
    categories,
    grades,
    workerSummaryByArticle,
    mergedAll,
    filtered,
    totalABales,
    totalBBales,
    totalAKg,
    totalBKg,
    baleDiff,
    kgDiff,
    totalABatches,
    totalBBatches,
    totalABatchAmount,
    totalBBatchAmount,
    profitA,
    profitB,
    profitDiff,
    allSuppliers,
    supplierBreakdownA,
    supplierBreakdownB,
    supplierSummary,
    dailyBreakdown,
    totalSupAKg,
    totalSupACost,
    totalSupBKg,
    totalSupBCost,
    totalSupKgDiff,
    totalSupCostDiff,
    hasSupplierFilter,
    exportSupplierCsv,
  };
}

export type ProductionComparisonModel = ReturnType<typeof useProductionComparisonModel>;

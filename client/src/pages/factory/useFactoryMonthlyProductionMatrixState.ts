// Extracted from ./FactoryMonthlyProductionMatrix.tsx to keep that module under the source-size cap.
import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { useExistingRecordChangeAccess } from "@/hooks/useExistingRecordChangeAccess";
import { downloadBlob } from "@/lib/downloadBlob";
import { useIsMobile } from "@/hooks/use-mobile";
import { useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";
import { useEffect, useMemo, useState } from "react";
import { useLocation, useSearch } from "wouter";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { moveProductNearItem, moveProductToPosition } from "./monthlyProductionRowOrder";
import { useToast } from "@/hooks/use-toast";
import type { MonthlyProductionExportBale } from "./monthlyProductionWorkbookDrilldown";
import { csvCell, currentMonth, prettyMonth, type MatrixResponse } from "./FactoryMonthlyProductionMatrixCurrentMonth";

export function useFactoryMonthlyProductionMatrixState() {
  const mhd = useFactoryMhdView();
  const isMobile = useIsMobile();
  const isPhoneLayout = useErpPhoneLayout();
  const showMobileCards = isMobile || isPhoneLayout;
  const { selectedCompany } = useCompany();
  const [, navigate] = useLocation();
  const returnMonths =
    new URLSearchParams(useSearch())
      .get("months")
      ?.split(",")
      .filter((month) => /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) ?? [];
  const { t, language } = useApplicationLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // The row order is shared company data; read-only roles see it but never save it.
  const recordChanges = useExistingRecordChangeAccess();
  const queryKey = companyQueryKey("/api/factory/monthly-production-matrix", selectedCompany?.id);
  const { data, isLoading, error, refetch, isFetching } = useQuery<MatrixResponse>({
    queryKey,
    enabled: !!selectedCompany?.id,
    queryFn: async () => {
      const response = await fetch("/api/factory/monthly-production-matrix", { credentials: "include" });
      if (!response.ok) throw new Error(t("monthlyProduction.couldNotLoad"));
      return response.json();
    },
    staleTime: 60_000,
  });
  const [search, setSearch] = useState("");
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [mode, setMode] = useState<"all" | "selected">(returnMonths.length ? "selected" : "all");
  const [pickedMonth, setPickedMonth] = useState(currentMonth);
  const [pickedMonths, setPickedMonths] = useState<string[]>([...new Set(returnMonths)].sort());
  const [orderedIds, setOrderedIds] = useState<number[]>([]);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [exportingExcel, setExportingExcel] = useState(false);
  const [exportProgress, setExportProgress] = useState("");
  const [moveItemId, setMoveItemId] = useState<number | null>(null);
  const [moveRowNumber, setMoveRowNumber] = useState("");
  const [moveSearch, setMoveSearch] = useState("");
  const [destinationId, setDestinationId] = useState<number | null>(null);

  useEffect(() => {
    if (data) setOrderedIds(data.rowOrder);
  }, [data]);

  const allMonths = useMemo(() => {
    const observed = (data?.monthly ?? []).map((row) => row.month).filter((m) => /^\d{4}-\d{2}$/.test(m));
    const first = [...observed, currentMonth()].sort()[0];
    const last = [...observed, currentMonth()].sort().at(-1) ?? currentMonth();
    const [sy, sm] = first.split("-").map(Number);
    const [ey, em] = last.split("-").map(Number);
    const months: string[] = [];
    for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m++) {
      if (m > 12) {
        m = 1;
        y++;
      }
      months.push(String(y) + "-" + String(m).padStart(2, "0"));
    }
    return months;
  }, [data?.monthly]);
  const months = mode === "all" ? allMonths : [...pickedMonths].sort();
  // Intl.DateTimeFormat is expensive when called in thousands of table cells.
  // Cache a label once per displayed month, and reuse it in titles and ARIA text.
  const monthKey = months.join("|");
  const monthLabels = useMemo(() => {
    const locale = language === "ar" ? "ar" : language === "fr" ? "fr" : "en";
    return new Map(
      monthKey
        .split("|")
        .filter(Boolean)
        .map((month) => [month, prettyMonth(month, locale)])
    );
  }, [monthKey, language]);
  const monthLabel = (month: string) => monthLabels.get(month) ?? month;
  const counts = useMemo(() => {
    const map = new Map<number, Map<string, number>>();
    for (const record of data?.monthly ?? []) {
      if (!map.has(record.productId)) map.set(record.productId, new Map());
      map.get(record.productId)!.set(record.month, record.quantity);
    }
    return map;
  }, [data?.monthly]);
  const categories = useMemo(
    () => [...new Set((data?.products ?? []).map((p) => p.categoryName))].sort(),
    [data?.products]
  );
  const toggleCategory = (value: string) => {
    setSelectedCategories((previous) =>
      previous.includes(value) ? previous.filter((item) => item !== value) : [...previous, value]
    );
  };
  const orderedProducts = useMemo(() => {
    const positions = new Map(orderedIds.map((id, i) => [id, i]));
    return [...(data?.products ?? [])].sort((a, b) => {
      const ap = positions.get(a.id),
        bp = positions.get(b.id);
      if (ap != null && bp != null) return ap - bp;
      if (ap != null) return -1;
      if (bp != null) return 1;
      return a.name.localeCompare(b.name) || a.id - b.id;
    });
  }, [data?.products, orderedIds]);
  const mhdOrderedProducts = mhd.sortRows(orderedProducts, (product) => product.articleCode);
  const rowPositionById = new Map(mhdOrderedProducts.map((product, index) => [product.id, index + 1]));
  const visibleProducts = mhdOrderedProducts.filter((product) => {
    const q = search.trim().toLowerCase();
    return (
      (selectedCategories.length === 0 || selectedCategories.includes(product.categoryName)) &&
      (!q ||
        [mhd.nameFor(product.articleCode, product.name), product.articleCode, product.categoryName].some((v) =>
          v.toLowerCase().includes(q)
        ))
    );
  });
  const canReorder =
    recordChanges.allowed && mhd.mode === "standard" && !search.trim() && selectedCategories.length === 0 && !saving;
  const byId = (productId: number, month: string) => counts.get(productId)?.get(month) ?? 0;
  const openWorkerBreakdown = (productId: number, selectedMonths: string[]) => {
    if (selectedMonths.length === 0) return;
    const params = new URLSearchParams({ months: selectedMonths.join(",") });
    navigate("/factory/monthly-production-matrix/" + productId + "/workers?" + params.toString());
  };
  const rowTotal = (id: number) => months.reduce((sum, month) => sum + byId(id, month), 0);
  const persistOrder = async (next: number[]): Promise<boolean> => {
    if (!data || saving || !recordChanges.allowed) return false;
    const current = orderedProducts.map((product) => product.id);
    if (next.every((id, index) => id === current[index])) return true;
    const before = orderedIds;
    setOrderedIds(next);
    setSaving(true);
    try {
      const response = await fetch("/api/factory/monthly-production-matrix/order", {
        method: "PUT",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: next }),
      });
      if (!response.ok) throw new Error(t("monthlyProduction.orderError"));
      queryClient.setQueryData<MatrixResponse>(queryKey, { ...data, rowOrder: next });
      toast({ title: t("monthlyProduction.orderSaved"), description: t("monthlyProduction.sharedSaved") });
      return true;
    } catch {
      setOrderedIds(before);
      toast({
        title: t("monthlyProduction.orderError"),
        description: t("monthlyProduction.restored"),
        variant: "destructive",
      });
      return false;
    } finally {
      setSaving(false);
    }
  };
  const reorder = (sourceId: number, targetId: number) => {
    if (!canReorder || sourceId === targetId) return;
    const current = orderedProducts.map((product) => product.id);
    const to = current.indexOf(targetId);
    if (to === -1) return;
    void persistOrder(moveProductToPosition(current, sourceId, to + 1));
  };
  const moveOne = (id: number, direction: number) => {
    if (!canReorder) return;
    const current = orderedProducts.map((product) => product.id);
    const from = current.indexOf(id);
    if (from < 0 || from + direction < 0 || from + direction >= current.length) return;
    void persistOrder(moveProductToPosition(current, id, from + direction + 1));
  };
  const openMoveDialog = (id: number) => {
    const index = orderedProducts.findIndex((product) => product.id === id);
    if (index === -1 || saving) return;
    setMoveItemId(id);
    setMoveRowNumber(String(index + 1));
    setMoveSearch("");
    setDestinationId(null);
  };
  const moveToPosition = async (position: number) => {
    if (moveItemId === null) return;
    const current = orderedProducts.map((product) => product.id);
    if (!Number.isSafeInteger(position) || position < 1 || position > current.length) return;
    if (await persistOrder(moveProductToPosition(current, moveItemId, position))) {
      setMoveItemId(null);
    }
  };
  const moveNextToItem = async (placement: "before" | "after") => {
    if (moveItemId === null || destinationId === null) return;
    const current = orderedProducts.map((product) => product.id);
    if (await persistOrder(moveProductNearItem(current, moveItemId, destinationId, placement))) {
      setMoveItemId(null);
    }
  };
  const movingProduct = orderedProducts.find((product) => product.id === moveItemId);
  const currentPosition = movingProduct ? (rowPositionById.get(movingProduct.id) ?? 0) : 0;
  const parsedMoveRow = /^\d+$/.test(moveRowNumber.trim()) ? Number(moveRowNumber) : Number.NaN;
  const validMoveRow =
    Number.isSafeInteger(parsedMoveRow) && parsedMoveRow >= 1 && parsedMoveRow <= orderedProducts.length;
  const moveMatches = moveSearch.trim()
    ? orderedProducts
        .filter(
          (product) =>
            product.id !== moveItemId &&
            (mhd.nameFor(product.articleCode, product.name) + " " + product.articleCode + " " + product.categoryName)
              .toLowerCase()
              .includes(moveSearch.trim().toLowerCase())
        )
        .slice(0, 12)
    : [];
  const selectedDestination = orderedProducts.find((product) => product.id === destinationId);
  const addMonth = () => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(pickedMonth)) return;
    setPickedMonths((previous) => [...new Set(mode === "all" ? [pickedMonth] : [...previous, pickedMonth])].sort());
    setMode("selected");
  };
  const exportCsv = () => {
    const rows: (string | number)[][] = [
      [
        t("monthlyProduction.code"),
        t("monthlyProduction.item"),
        t("monthlyProduction.category"),
        ...months.map(monthLabel),
        t("monthlyProduction.total"),
      ],
      ...visibleProducts.map((p) => [
        p.articleCode,
        p.name,
        p.categoryName,
        ...months.map((m) => byId(p.id, m)),
        rowTotal(p.id),
      ]),
    ];
    const csv = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    downloadBlob(new Blob([csv], { type: "text/csv;charset=utf-8" }), "factory-monthly-production.csv");
  };
  const exportExcel = async () => {
    if (exportingExcel || months.length === 0 || !data) return;
    setExportingExcel(true);
    setExportProgress("Collecting bales");
    try {
      // Export all matching bales, not just one paginated screen page.
      // The resulting workbook can be navigated completely offline.
      const bales: MonthlyProductionExportBale[] = [];
      if (visibleProducts.length > 0) {
        const params = new URLSearchParams({
          productIds: visibleProducts.map((product) => String(product.id)).join(","),
          months: months.join(","),
        });
        let page = 1;
        let hasMore = true;
        while (hasMore) {
          if (page > 200) throw new Error("Too many production records for a single Excel export.");
          params.set("page", String(page));
          const response = await fetch("/api/factory/monthly-production-matrix/export-bales?" + params.toString(), {
            credentials: "include",
            cache: "no-store",
          });
          if (!response.ok) {
            const payload = await response.json().catch(() => ({}));
            throw new Error(payload.message || "Unable to load bale details");
          }
          const batch: { bales: MonthlyProductionExportBale[]; hasMore: boolean; page: number } = await response.json();
          if (
            !Array.isArray(batch.bales) ||
            typeof batch.hasMore !== "boolean" ||
            batch.page !== page ||
            (batch.hasMore && batch.bales.length === 0)
          ) {
            throw new Error("Incomplete production details returned; Excel export cancelled.");
          }
          bales.push(...batch.bales);
          if (bales.length > 250_000) {
            throw new Error("This export is too large; select fewer months or filter items.");
          }
          setExportProgress("Loaded " + bales.length.toLocaleString() + " bales");
          hasMore = batch.hasMore;
          page += 1;
        }
      }

      // Recompute the matrix counts using the exact exported bale records so
      // every click, worker total and reference list reconciles in the file.
      const exportedCounts = new Map<string, number>();
      for (const bale of bales) {
        const key = bale.productId + "|" + bale.month;
        exportedCounts.set(key, (exportedCounts.get(key) ?? 0) + 1);
      }
      const rows = visibleProducts.map((product) => ({
        productId: product.id,
        name: mhd.nameFor(product.articleCode, product.name),
        articleCode: product.articleCode,
        categoryName: product.categoryName,
        values: months.map((month) => exportedCounts.get(product.id + "|" + month) ?? 0),
      }));
      setExportProgress("Building Excel sheets");
      const { exportMonthlyProductionExcel } = await import("./monthlyProductionExcelExport");
      await exportMonthlyProductionExcel({
        rows,
        months,
        monthLabels: months.map(monthLabel),
        category: selectedCategories.join(", "),
        search,
        bales,
      });
      toast({
        title: "Excel workbook exported",
        description: "Click a count to move between the worksheets inside the file.",
      });
    } catch (error) {
      toast({
        title: "Unable to export Excel",
        description: error instanceof Error ? error.message : "Please try again.",
        variant: "destructive",
      });
    } finally {
      setExportingExcel(false);
      setExportProgress("");
    }
  };
  const totals = months.map((month) => visibleProducts.reduce((sum, product) => sum + byId(product.id, month), 0));
  const overallTotal = totals.reduce((sum, count) => sum + count, 0);
  return {
    addMonth,
    byId,
    canReorder,
    categories,
    currentPosition,
    data,
    destinationId,
    draggingId,
    error,
    exportCsv,
    exportExcel,
    exportProgress,
    exportingExcel,
    isFetching,
    isLoading,
    language,
    mhd,
    mode,
    monthLabel,
    months,
    moveItemId,
    moveMatches,
    moveNextToItem,
    moveOne,
    moveRowNumber,
    moveSearch,
    moveToPosition,
    movingProduct,
    openMoveDialog,
    openWorkerBreakdown,
    orderedProducts,
    overallTotal,
    parsedMoveRow,
    pickedMonth,
    pickedMonths,
    recordChanges,
    refetch,
    reorder,
    rowPositionById,
    rowTotal,
    saving,
    search,
    selectedCategories,
    selectedDestination,
    setDestinationId,
    setDraggingId,
    setMode,
    setMoveItemId,
    setMoveRowNumber,
    setMoveSearch,
    setPickedMonth,
    setPickedMonths,
    setSearch,
    setSelectedCategories,
    showMobileCards,
    t,
    toggleCategory,
    totals,
    validMoveRow,
    visibleProducts,
  };
}

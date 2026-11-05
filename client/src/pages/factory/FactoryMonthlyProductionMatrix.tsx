import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useApplicationLanguage } from "@/contexts/ApplicationLanguageContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ArrowDown, ArrowUp, Download, GripVertical, Plus, RotateCcw, Search, X } from "lucide-react";

type Product = { id: number; name: string; articleCode: string; categoryName: string };
type MonthValue = { productId: number; month: string; quantity: number };
type MatrixResponse = { products: Product[]; monthly: MonthValue[]; rowOrder: number[] };

const currentMonth = () => {
  const now = new Date();
  return String(now.getFullYear()) + "-" + String(now.getMonth() + 1).padStart(2, "0");
};
const prettyMonth = (month: string, locale?: string) => {
  const [y, m] = month.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(locale, { month: "short", year: "numeric" });
};
const csvCell = (value: string | number) => '"' + String(value).replace(/"/g, '""') + '"';

export default function FactoryMonthlyProductionMatrix() {
  const { selectedCompany } = useCompany();
  const { t, language } = useApplicationLanguage();
  const { toast } = useToast();
  const queryClient = useQueryClient();
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
  const [category, setCategory] = useState("");
  const [mode, setMode] = useState<"all" | "selected">("all");
  const [pickedMonth, setPickedMonth] = useState(currentMonth);
  const [pickedMonths, setPickedMonths] = useState<string[]>([]);
  const [orderedIds, setOrderedIds] = useState<number[]>([]);
  const [draggingId, setDraggingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { if (data) setOrderedIds(data.rowOrder); }, [data]);

  const allMonths = useMemo(() => {
    const observed = (data?.monthly ?? []).map((row) => row.month).filter((m) => /^\d{4}-\d{2}$/.test(m));
    const first = [...observed, currentMonth()].sort()[0];
    const last = [...observed, currentMonth()].sort().at(-1) ?? currentMonth();
    const [sy, sm] = first.split("-").map(Number);
    const [ey, em] = last.split("-").map(Number);
    const months: string[] = [];
    for (let y = sy, m = sm; y < ey || (y === ey && m <= em); m++) {
      if (m > 12) { m = 1; y++; }
      months.push(String(y) + "-" + String(m).padStart(2, "0"));
    }
    return months;
  }, [data?.monthly]);
  const months = mode === "all" ? allMonths : [...pickedMonths].sort();
  const monthLabel = (month: string) => prettyMonth(month, language === "ar" ? "ar" : language === "fr" ? "fr" : "en");
  const counts = useMemo(() => {
    const map = new Map<number, Map<string, number>>();
    for (const record of data?.monthly ?? []) {
      if (!map.has(record.productId)) map.set(record.productId, new Map());
      map.get(record.productId)!.set(record.month, record.quantity);
    }
    return map;
  }, [data?.monthly]);
  const categories = useMemo(() =>
    [...new Set((data?.products ?? []).map((p) => p.categoryName))].sort(), [data?.products]);
  const orderedProducts = useMemo(() => {
    const positions = new Map(orderedIds.map((id, i) => [id, i]));
    return [...(data?.products ?? [])].sort((a, b) => {
      const ap = positions.get(a.id), bp = positions.get(b.id);
      if (ap != null && bp != null) return ap - bp;
      if (ap != null) return -1;
      if (bp != null) return 1;
      return a.name.localeCompare(b.name) || a.id - b.id;
    });
  }, [data?.products, orderedIds]);
  const visibleProducts = orderedProducts.filter((product) => {
    const q = search.trim().toLowerCase();
    return (!category || product.categoryName === category) &&
      (!q || [product.name, product.articleCode, product.categoryName].some((v) => v.toLowerCase().includes(q)));
  });
  const canReorder = !search.trim() && !category && !saving;
  const byId = (productId: number, month: string) => counts.get(productId)?.get(month) ?? 0;
  const rowTotal = (id: number) => months.reduce((sum, month) => sum + byId(id, month), 0);
  const reorder = async (sourceId: number, targetId: number) => {
    if (!canReorder || sourceId === targetId || !data) return;
    const all = orderedProducts.map((p) => p.id);
    const from = all.indexOf(sourceId), to = all.indexOf(targetId);
    if (from < 0 || to < 0) return;
    all.splice(from, 1);
    all.splice(to, 0, sourceId);
    const before = orderedIds;
    setOrderedIds(all);
    setSaving(true);
    try {
      const response = await fetch("/api/factory/monthly-production-matrix/order", {
        method: "PUT", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ productIds: all }),
      });
      if (!response.ok) throw new Error(t("monthlyProduction.orderError"));
      queryClient.setQueryData<MatrixResponse>(queryKey, { ...data, rowOrder: all });
      toast({ title: t("monthlyProduction.orderSaved"), description: t("monthlyProduction.sharedSaved") });
    } catch {
      setOrderedIds(before);
      toast({ title: t("monthlyProduction.orderError"), description: t("monthlyProduction.restored"), variant: "destructive" });
    } finally { setSaving(false); }
  };
  const moveOne = (id: number, direction: number) => {
    const idx = orderedProducts.findIndex((p) => p.id === id);
    const neighbor = orderedProducts[idx + direction];
    if (neighbor) void reorder(id, neighbor.id);
  };
  const addMonth = () => {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(pickedMonth)) return;
    setPickedMonths((previous) => [...new Set(mode === "all" ? [pickedMonth] : [...previous, pickedMonth])].sort());
    setMode("selected");
  };
  const exportCsv = () => {
    const rows: (string | number)[][] = [
      [t("monthlyProduction.code"), t("monthlyProduction.item"), t("monthlyProduction.category"), ...months.map(monthLabel), t("monthlyProduction.total")],
      ...visibleProducts.map((p) => [p.articleCode, p.name, p.categoryName,
        ...months.map((m) => byId(p.id, m)), rowTotal(p.id)]),
    ];
    const csv = "\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "factory-monthly-production.csv";
    link.click();
    URL.revokeObjectURL(url);
  };
  const totals = months.map((month) => visibleProducts.reduce((sum, product) => sum + byId(product.id, month), 0));
  const overallTotal = totals.reduce((sum, count) => sum + count, 0);

  return (
    <main className="p-3 sm:p-5 space-y-4" data-testid="factory-monthly-production-matrix">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PageHeader title={t("monthlyProduction.title")} subtitle={t("monthlyProduction.subtitle")} />
        <div className="flex gap-2">
          <Button variant="outline" size="sm" disabled={isFetching} onClick={() => void refetch()}>
            <RotateCcw className="mr-2 h-4 w-4" /> {t("monthlyProduction.refresh")}
          </Button>
          <Button variant="outline" size="sm" disabled={!data} onClick={exportCsv}>
            <Download className="mr-2 h-4 w-4" /> {t("monthlyProduction.exportCsv")}
          </Button>
        </div>
      </div>
      <div className="rounded-xl border bg-card p-3 space-y-3">
        <div className="flex flex-wrap gap-2 items-center">
          <Button size="sm" variant={mode === "all" ? "default" : "outline"} onClick={() => setMode("all")}>{t("monthlyProduction.allMonths")}</Button>
          <Button size="sm" variant={mode === "selected" ? "default" : "outline"} onClick={() => setMode("selected")}>{t("monthlyProduction.selectedMonths")}</Button>
          <Input aria-label={t("monthlyProduction.chooseMonth")} type="month" className="w-44" value={pickedMonth} onChange={(e) => setPickedMonth(e.target.value)} />
          <Button size="sm" variant="outline" onClick={addMonth}><Plus className="mr-1 h-4 w-4" /> {t("monthlyProduction.addMonth")}</Button>
          <div className="relative w-full sm:w-64 sm:ml-auto">
            <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input aria-label={t("monthlyProduction.searchItems")} className="pl-9" placeholder={t("monthlyProduction.searchPlaceholder")} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          <select aria-label={t("monthlyProduction.categoryFilter")} className="h-9 rounded-md border bg-background px-2 text-sm" value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{t("monthlyProduction.allCategories")}</option>
            {categories.map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
        </div>
        {mode === "selected" && <div className="flex flex-wrap items-center gap-1.5">
          {pickedMonths.length === 0 && <span className="text-sm text-muted-foreground">{t("monthlyProduction.addMonthHint")}</span>}
          {pickedMonths.map((month) => <button key={month} type="button" onClick={() => setPickedMonths((prev) => prev.filter((m) => m !== month))}
            className="inline-flex items-center gap-1 rounded-full border bg-muted px-2.5 py-1 text-xs hover:bg-accent">
            {monthLabel(month)} <X className="h-3 w-3" aria-label={t("monthlyProduction.removeMonth")} />
          </button>)}
        </div>}
        <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>{visibleProducts.length} {t("monthlyProduction.items")} · {months.length} {t("monthlyProduction.months")} · {t("monthlyProduction.countsHint")}</span>
          <span>{t("monthlyProduction.highest")} <b className="text-emerald-600">{t("monthlyProduction.green")}</b> · {t("monthlyProduction.lowest")} <b className="text-red-600">{t("monthlyProduction.red")}</b> · {t("monthlyProduction.dragHint")}</span>
        </div>
      </div>
      {error ? <div className="rounded-lg border p-8 text-center text-destructive">
        {t("monthlyProduction.loadError")} <Button variant="outline" size="sm" onClick={() => void refetch()}>{t("monthlyProduction.retry")}</Button>
      </div> : isLoading || !data ? <div className="rounded-lg border p-10 text-center text-muted-foreground">{t("monthlyProduction.loading")}</div> :
      <div className="overflow-auto rounded-xl border bg-card" style={{ maxHeight: "calc(100dvh - 280px)" }}>
        <table className="min-w-max w-full border-separate border-spacing-0 text-sm tabular-nums">
          <thead className="sticky top-0 z-20 bg-muted text-foreground">
            <tr>
              <th className="sticky left-0 z-30 min-w-72 border-b border-r bg-muted p-2 text-left">{t("monthlyProduction.itemCode")}</th>
              {months.map((month) => <th key={month} className="min-w-24 border-b border-r px-3 py-2 text-right whitespace-nowrap">{monthLabel(month)}</th>)}
              <th className="sticky right-0 z-30 min-w-24 border-b bg-muted px-3 py-2 text-right">{t("monthlyProduction.total")}</th>
            </tr>
          </thead>
          <tbody>
            {visibleProducts.map((product, index) => {
              const values = months.map((month) => byId(product.id, month));
              const min = Math.min(...values);
              const max = Math.max(...values);
              const hasRange = values.length > 1 && min !== max;
              return <tr key={product.id} draggable={canReorder}
                onDragStart={(event) => { setDraggingId(product.id); event.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(event) => { if (canReorder) event.preventDefault(); }}
                onDrop={(event) => { event.preventDefault(); if (draggingId != null) void reorder(draggingId, product.id); setDraggingId(null); }}
                onDragEnd={() => setDraggingId(null)}
                className={"group hover:bg-accent/30 " + (draggingId === product.id ? "opacity-50 " : "") + (index % 2 ? "bg-muted/20" : "")}>
                <td className="sticky left-0 z-10 border-r border-b bg-card p-1.5 group-hover:bg-accent/30">
                  <div className="flex items-center gap-1.5">
                    <GripVertical className={"h-4 w-4 shrink-0 " + (canReorder ? "cursor-grab text-muted-foreground" : "text-muted-foreground/30")} />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium leading-tight">{product.name}</div>
                      <div className="text-[11px] text-muted-foreground">{product.articleCode} · {product.categoryName}</div>
                    </div>
                    <div className="flex flex-col">
                      <button type="button" aria-label={t("monthlyProduction.moveUp") + ": " + product.name} disabled={!canReorder || index === 0} onClick={() => moveOne(product.id, -1)} className="rounded hover:bg-muted disabled:opacity-25"><ArrowUp className="h-3.5 w-3.5" /></button>
                      <button type="button" aria-label={t("monthlyProduction.moveDown") + ": " + product.name} disabled={!canReorder || index === visibleProducts.length - 1} onClick={() => moveOne(product.id, 1)} className="rounded hover:bg-muted disabled:opacity-25"><ArrowDown className="h-3.5 w-3.5" /></button>
                    </div>
                  </div>
                </td>
                {values.map((value, i) => {
                  const accent = hasRange && value === max
                    ? "bg-emerald-100 text-emerald-800 font-bold dark:bg-emerald-950/50 dark:text-emerald-300"
                    : hasRange && value === min
                      ? "bg-red-100 text-red-800 font-bold dark:bg-red-950/50 dark:text-red-300" : "";
                  return <td key={months[i]} title={monthLabel(months[i]) + ": " + value + " " + t("monthlyProduction.baleUnits")}
                    className={"border-b border-r px-3 py-2 text-right " + accent}>{value.toLocaleString()}</td>;
                })}
                <td className="sticky right-0 z-10 border-b bg-card px-3 py-2 text-right font-semibold group-hover:bg-accent/30">{rowTotal(product.id).toLocaleString()}</td>
              </tr>;
            })}
            {visibleProducts.length === 0 && <tr><td colSpan={months.length + 2} className="p-10 text-center text-muted-foreground">{t("monthlyProduction.noMatching")}</td></tr>}
          </tbody>
          <tfoot className="sticky bottom-0 z-10 bg-muted font-bold">
            <tr>
              <td className="sticky left-0 border-t border-r bg-muted px-3 py-2">{t("monthlyProduction.totalProduced")}</td>
              {totals.map((value, index) => <td key={months[index]} className="border-t border-r px-3 py-2 text-right">{value.toLocaleString()}</td>)}
              <td className="sticky right-0 border-t bg-muted px-3 py-2 text-right">{overallTotal.toLocaleString()}</td>
            </tr>
          </tfoot>
        </table>
      </div>}
      {saving && <p role="status" className="text-xs text-muted-foreground">{t("monthlyProduction.saving")}</p>}
    </main>
  );
}

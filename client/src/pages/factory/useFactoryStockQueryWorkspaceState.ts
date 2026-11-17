// Extracted from ./FactoryStockQueryWorkspace.tsx to keep that module under the source-size cap.
import { useEffect, useMemo, useState } from "react";
import { useFactoryMhdView } from "@/hooks/use-factory-mhd-view";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { useCompany } from "@/contexts/CompanyContext";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { downloadBlob } from "@/lib/downloadBlob";
import { exportFileName } from "@/lib/exportFile";

interface Option {
  id: number;
  name: string;
}

interface LocationSummary {
  id: number | null;
  name: string;
  bales: number;
  kg: number;
}

interface Product {
  id: number;
  name: string;
  code: string;
  categoryId: number | null;
  categoryName: string;
  bales: number;
  kg: number;
  soldBales: number;
  soldKg: number;
  salesValue: number;
  locations: LocationSummary[];
}

interface Sale {
  productId: number;
  orderId: number;
  invoiceNumber: string;
  date: string;
  containerNumber: string | null;
  customerId: number;
  customerName: string;
  qty: number;
  kg: number;
  total: number;
  pricePerBale: number;
}

interface Report {
  products: Product[];
  sales: Sale[];
  locations: Option[];
  customers: Option[];
  categories: Option[];
  containers: string[];
}

export type DisplayColumn = "category" | "bales" | "kg" | "soldBales" | "salesValue";

const numberFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const moneyFormat = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export const fmt = (n: number) => numberFormat.format(n || 0);

export const money = (n: number) => moneyFormat.format(n || 0);

const csvSafe = (value: string | number) => {
  const text = String(value ?? "");
  return '"' + (/^[\s]*[=+\-@]/.test(text) ? "'" : "") + text.replace(/"/g, '""') + '"';
};

export function exportCsv(rows: (string | number)[][]) {
  const csv = rows.map((row) => row.map(csvSafe).join(",")).join("\r\n");
  downloadBlob(
    new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }),
    exportFileName("factory stock query sales", "csv")
  );
}

export const cell = "whitespace-nowrap px-3 py-2.5 text-sm";

export const label = "block mb-1.5 text-xs font-semibold text-muted-foreground";

export function useFactoryStockQueryWorkspaceState() {
  const mhd = useFactoryMhdView();
  const { selectedCompany } = useCompany();
  const { formatDisplayDate } = useDateFormat();
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [location, setLocation] = useState("");
  const [customer, setCustomer] = useState("");
  const [container, setContainer] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("name");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [visible, setVisible] = useState<Record<DisplayColumn, boolean>>({
    category: true,
    bales: true,
    kg: true,
    soldBales: true,
    salesValue: true,
  });

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (from) p.set("from", from);
    if (to) p.set("to", to);
    if (location) p.set("locationId", location);
    if (customer) p.set("customerId", customer);
    if (container) p.set("container", container);
    // Category is filtered on the client so the full category picker remains available.
    return p.toString();
  }, [from, to, location, customer, container]);

  const { data, isLoading, isFetching, error, refetch } = useQuery<Report>({
    queryKey: ["/api/factory/stock-query-report", selectedCompany?.id, params],
    queryFn: async () => {
      const response = await fetch(`/api/factory/stock-query-report${params ? "?" + params : ""}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Unable to load factory stock and sales");
      return response.json();
    },
  });

  const products = useMemo(() => {
    const q = search.trim().toLowerCase();
    const found = (data?.products ?? []).filter(
      (p) =>
        (!q ||
          [p.code, p.name, mhd.nameFor(p.code, p.name), p.categoryName].some((v) => v.toLowerCase().includes(q))) &&
        (!category || String(p.categoryId ?? 0) === category)
    );
    return [...found].sort((a, b) => {
      if (sort === "stock") return b.kg - a.kg || a.name.localeCompare(b.name);
      if (sort === "sales") return b.salesValue - a.salesValue || a.name.localeCompare(b.name);
      if (sort === "sold") return b.soldBales - a.soldBales || a.name.localeCompare(b.name);
      return a.name.localeCompare(b.name);
    });
  }, [data?.products, search, category, sort, mhd]);

  const displayedProducts = mhd.sortRows(products, (p) => p.code);

  useEffect(() => {
    if (selectedId != null && products.some((p) => p.id === selectedId)) return;
    setSelectedId(products[0]?.id ?? null);
  }, [products, selectedId]);

  const selected = products.find((p) => p.id === selectedId) ?? null;
  const visibleIds = useMemo(() => new Set(products.map((p) => p.id)), [products]);
  const sales = useMemo(
    () => (data?.sales ?? []).filter((s) => visibleIds.has(s.productId)),
    [data?.sales, visibleIds]
  );
  const itemSales = useMemo(() => sales.filter((s) => s.productId === selectedId), [sales, selectedId]);
  const totalStock = products.reduce((s, p) => s + p.kg, 0);
  const totalBales = products.reduce((s, p) => s + p.bales, 0);
  const totalSold = sales.reduce((s, row) => s + row.qty, 0);
  const totalSoldKg = sales.reduce((s, row) => s + row.kg, 0);
  const totalSalesValue = sales.reduce((s, row) => s + row.total, 0);
  const dateDisplay = (value: string) => {
    if (!value) return "—";
    const date = new Date(value.slice(0, 10) + "T12:00:00");
    return Number.isNaN(date.getTime()) ? value : formatDisplayDate(date);
  };
  const clear = () => {
    setSearch("");
    setFrom("");
    setTo("");
    setLocation("");
    setCustomer("");
    setContainer("");
    setCategory("");
    setSort("name");
  };

  const trend = useMemo(() => {
    const grouped = new Map<string, number>();
    for (const s of itemSales) grouped.set(s.date.slice(0, 10), (grouped.get(s.date.slice(0, 10)) ?? 0) + s.qty);
    return [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-10);
  }, [itemSales]);
  const maxTrend = Math.max(1, ...trend.map(([, value]) => value));
  return {
    category,
    clear,
    container,
    customer,
    data,
    dateDisplay,
    displayedProducts,
    error,
    from,
    isFetching,
    isLoading,
    itemSales,
    location,
    maxTrend,
    mhd,
    navigate,
    products,
    refetch,
    sales,
    search,
    selected,
    selectedId,
    setCategory,
    setContainer,
    setCustomer,
    setFrom,
    setLocation,
    setSearch,
    setSelectedId,
    setSort,
    setTo,
    setVisible,
    sort,
    to,
    totalBales,
    totalSalesValue,
    totalSold,
    totalSoldKg,
    totalStock,
    trend,
    visible,
  };
}

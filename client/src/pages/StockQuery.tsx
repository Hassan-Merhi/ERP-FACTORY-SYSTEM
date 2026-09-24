import { searchAny } from "@shared/searchNormalization";
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAppMode } from "@/contexts/AppModeContext";
import { useLocation, useSearch } from "wouter";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, Package } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

interface StockItem {
  id: number;
  code: string;
  name: string;
  uom: string;
  stockGroupId: number | null;
  active: boolean;
}

interface FactoryBaleProduct {
  id: number;
  code: string;
  name: string;
  articleCode: string | null;
  active: boolean;
}

interface PagedStockItems {
  data: StockItem[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export default function StockQuery() {
  const appMode = useAppMode();
  const isFactory = appMode === "factory";
  const search = useSearch();
  const initialQ = new URLSearchParams(search).get("q") || "";
  const [searchTerm, setSearchTerm] = useState(initialQ);
  const [debouncedSearch, setDebouncedSearch] = useState(initialQ);
  const [, navigate] = useLocation();

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(searchTerm), 300);
    return () => clearTimeout(timer);
  }, [searchTerm]);

  const { data: pagedStockItems, isLoading: erpLoading } = useQuery<PagedStockItems>({
    queryKey: ["/api/stock-items", { search: debouncedSearch, pageSize: 200 }],
    queryFn: async () => {
      const params = new URLSearchParams({ page: "1", pageSize: "200" });
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      const res = await fetch(`/api/stock-items?${params}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to fetch stock items");
      return res.json();
    },
    enabled: !isFactory,
  });

  const { data: factoryProducts = [], isLoading: factoryLoading } = useQuery<FactoryBaleProduct[]>({
    queryKey: ["/api/factory/bale-products"],
    enabled: isFactory,
  });

  const isLoading = isFactory ? factoryLoading : erpLoading;

  const items = isFactory
    ? factoryProducts
        .filter((p) => !debouncedSearch.trim() || searchAny(debouncedSearch, p.name, p.articleCode, p.code))
        .map((p) => ({ id: p.id, code: p.articleCode || p.code, name: p.name, active: p.active }))
    : (pagedStockItems?.data ?? []).map((p) => ({ id: p.id, code: p.code, name: p.name, active: p.active }));

  const handleItemClick = (item: { id: number }) => {
    navigate(isFactory ? `/factory/stock-query/${item.id}` : `/stock-query/${item.id}`);
  };

  const hasSearch = debouncedSearch.trim().length > 0;

  return (
    <div className="flex flex-col gap-4 sm:p-4 md:p-6">
      {/* ── Header + Search ── */}
      <PageHeader title="Stock Query" subtitle="Click any item to view purchase history, sales, and inventory" />
      <div className="relative w-full sm:max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search by code or name..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-9"
          autoFocus
          data-testid="input-stock-search"
        />
      </div>

      {/* ── Result count ── */}
      {!isLoading && (items.length > 0 || hasSearch) && (
        <p className="text-sm text-muted-foreground">
          {hasSearch
            ? `${items.length.toLocaleString()} item${items.length !== 1 ? "s" : ""} match "${debouncedSearch}"`
            : `${items.length.toLocaleString()} item${items.length !== 1 ? "s" : ""}`}
        </p>
      )}

      {/* ── Table ── */}
      {isLoading ? (
        <div className="border rounded-xl overflow-hidden">
          <div className="bg-muted/40 border-b h-11" />
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3 border-b last:border-0">
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-4 flex-1" />
              <Skeleton className="h-5 w-14 rounded-full" />
            </div>
          ))}
        </div>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-3 text-muted-foreground">
          <Search className="h-10 w-10 opacity-25" />
          <p className="text-sm font-medium">
            {hasSearch ? "No items match your search" : "Search for a stock item to get started"}
          </p>
          {hasSearch && <p className="text-xs">Try a different name or code</p>}
        </div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block border rounded-xl overflow-auto max-h-[calc(100vh-280px)]">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-30 bg-muted/40">
                <tr className="h-11 bg-muted/40 border-b">
                  <th className="text-left px-4 font-medium w-32">Code</th>
                  <th className="text-left px-4 font-medium">Name</th>
                  <th className="text-left px-4 font-medium w-24">Status</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr
                    key={item.id}
                    className="border-t hover:bg-muted/30 transition-colors cursor-pointer"
                    onClick={() => handleItemClick(item)}
                    data-testid={`row-stock-item-${item.id}`}
                  >
                    <td className="px-4 py-3 text-muted-foreground font-mono text-xs" data-testid={`code-${item.id}`}>
                      {item.code}
                    </td>
                    <td className="px-4 py-3 font-medium" data-testid={`button-item-name-${item.id}`}>
                      <div className="flex items-center gap-2">
                        <Package className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                        {item.name}
                      </div>
                    </td>
                    <td className="px-4 py-3" data-testid={`status-${item.id}`}>
                      <Badge variant={item.active ? "default" : "secondary"} className="text-xs">
                        {item.active ? "Active" : "Inactive"}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile list */}
          <div className="md:hidden space-y-1.5">
            {items.map((item) => (
              <div
                key={item.id}
                className="flex items-center gap-3 border rounded-xl px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
                onClick={() => handleItemClick(item)}
                data-testid={`row-stock-item-${item.id}`}
              >
                <Package className="h-4 w-4 text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate" data-testid={`button-item-name-${item.id}`}>
                    {item.name}
                  </div>
                  <div className="text-xs text-muted-foreground font-mono mt-0.5">{item.code}</div>
                </div>
                <Badge variant={item.active ? "default" : "secondary"} className="text-xs shrink-0">
                  {item.active ? "Active" : "Inactive"}
                </Badge>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

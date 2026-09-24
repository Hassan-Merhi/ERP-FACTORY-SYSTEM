import { searchAny } from "@shared/searchNormalization";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useParams, useLocation } from "wouter";
import { ArrowLeft, Package, Search, Pencil } from "lucide-react";
import { Input } from "@/components/ui/input";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { useState } from "react";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";

import { BaleWeightEditDialog, type WeightEditBale } from "@/components/BaleWeightEditDialog";
import type { BaleDetailResponse } from "./types";

// ── Month-detail view ─────────────────────────────────────────────────────────
export function FactoryBaleProductMonthDetail() {
  const params = useParams();
  const [, navigate] = useLocation();
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount } = useCurrencyContext();
  const queryClient = useQueryClient();
  useEscapeToParent();

  const productId = params.productId || "0";
  const locationId = params.locationId || "0";
  const year = params.year || String(new Date().getFullYear());
  const month = params.month || "1";
  const backPath = `/factory/bale-product-history/${productId}/${locationId}/${year}`;

  const [searchTerm, setSearchTerm] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [weightEditBale, setWeightEditBale] = useState<WeightEditBale | null>(null);

  const { data: myAccess } = useQuery<{ fullAccess: boolean; pageKeys: string[]; hiddenCostFields: string[] }>({
    queryKey: ["/api/factory/my-access"],
  });
  const hiddenCost = myAccess?.hiddenCostFields ?? [];

  const { data: responseData, isLoading } = useQuery<BaleDetailResponse>({
    queryKey: ["/api/factory/bale-product-history", productId, locationId, year, month],
    queryFn: async () => {
      const response = await fetch(`/api/factory/bale-product-history/${productId}/${locationId}/${year}/${month}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch");
      return response.json();
    },
    enabled: parseInt(productId) > 0 && parseInt(locationId) > 0 && parseInt(year) > 0 && parseInt(month) > 0,
  });

  const data = responseData?.bales;
  const sellingPricePerBale = parseFloat(responseData?.sellingPrice || "0");

  const filteredData = (data || []).filter((bale) => {
    const effectiveStatus = bale.status === "IN_STOCK" && bale.isInLoadingOrder ? "LOADING" : bale.status;
    if (statusFilter !== "all" && effectiveStatus !== statusFilter) return false;
    if (searchTerm) {
      if (!searchAny(searchTerm, bale.baleCode, bale.referenceNumber)) return false;
    }
    return true;
  });

  const monthNames = [
    "",
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  const monthName = monthNames[parseInt(month)] || month;

  const formatNumber = (num: number) => {
    if (num % 1 === 0) return num.toLocaleString();
    return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  };

  const formatDateTime = (dateStr: string) => {
    const d = new Date(dateStr);
    const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return `${formatDisplayDate(d)} ${time}`;
  };

  const handleWeightSuccess = () => {
    queryClient.invalidateQueries({
      queryKey: ["/api/factory/bale-product-history", productId, locationId, year, month],
    });
    queryClient.invalidateQueries({ queryKey: ["/api/factory/bale-product-history", productId, locationId, year] });
  };

  if (isLoading) {
    return (
      <div className="container mx-auto p-3 sm:p-6 space-y-6">
        <Skeleton className="h-8 w-64" data-testid="skeleton-title" />
        <Skeleton className="h-[400px] w-full" data-testid="skeleton-table" />
      </div>
    );
  }

  return (
    <div className="container mx-auto p-3 sm:p-6 space-y-4 sm:space-y-6">
      <BaleWeightEditDialog
        bale={weightEditBale}
        onClose={() => setWeightEditBale(null)}
        onSuccess={handleWeightSuccess}
      />

      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(backPath)} data-testid="button-back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div>
          <h1 className="text-lg sm:text-2xl font-bold" data-testid="text-page-title">
            Bale Details — {monthName} {year}
          </h1>
          <p className="text-sm text-muted-foreground" data-testid="text-bale-count">
            <Package className="inline h-4 w-4 mr-1" />
            {data?.length || 0} bale(s)
          </p>
        </div>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-lg" data-testid="text-detail-title">
            Bales for {monthName} {year}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* Filter bar */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative flex-1 min-w-[180px]">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search bale code or ref #..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="pl-9"
                data-testid="input-bale-search"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-[160px]" data-testid="select-status-filter">
                <SelectValue placeholder="All Status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Status</SelectItem>
                <SelectItem value="IN_STOCK">In Stock</SelectItem>
                <SelectItem value="LOADING">Loading</SelectItem>
                <SelectItem value="SOLD">Sold</SelectItem>
                <SelectItem value="DISPATCHED">Dispatched</SelectItem>
                <SelectItem value="DELETED">Deleted</SelectItem>
              </SelectContent>
            </Select>
            {(searchTerm || statusFilter !== "all") && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearchTerm("");
                  setStatusFilter("all");
                }}
                data-testid="button-clear-filters"
              >
                Clear
              </Button>
            )}
            <span className="text-sm text-muted-foreground ml-auto">{filteredData.length} bale(s)</span>
          </div>

          {/* Desktop table */}
          <div className="hidden md:block overflow-x-auto">
            <Table>
              <TableHeader className="sticky top-0 z-30 bg-background">
                <TableRow>
                  <TableHead>Bale Code</TableHead>
                  <TableHead>Reference</TableHead>
                  <TableHead className="text-right">Weight (KG)</TableHead>
                  {!hiddenCost.includes("bale_history_cost_per_kg") && (
                    <TableHead className="text-right">Cost/KG</TableHead>
                  )}
                  {!hiddenCost.includes("bale_history_total_cost") && (
                    <TableHead className="text-right">Cost Price</TableHead>
                  )}
                  {!hiddenCost.includes("bale_history_total_cost") && (
                    <TableHead className="text-right">Sell Price</TableHead>
                  )}
                  <TableHead>Status</TableHead>
                  <TableHead>Date/Time</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredData.map((bale) => {
                  const isLoadingStatus = bale.status === "IN_STOCK" && bale.isInLoadingOrder;
                  return (
                    <TableRow key={bale.id} data-testid={`row-bale-${bale.id}`}>
                      <TableCell className="font-medium font-mono" data-testid={`text-bale-code-${bale.id}`}>
                        {bale.baleCode}
                      </TableCell>
                      <TableCell data-testid={`text-reference-${bale.id}`}>
                        <button
                          className="font-mono text-sm text-primary underline-offset-2 hover:underline cursor-pointer"
                          onClick={() =>
                            navigate(`/factory/barcode-lookup?ref=${encodeURIComponent(bale.referenceNumber)}`)
                          }
                          data-testid={`button-ref-lookup-${bale.id}`}
                        >
                          {bale.referenceNumber}
                        </button>
                      </TableCell>
                      <TableCell className="text-right font-mono" data-testid={`text-weight-${bale.id}`}>
                        <span className="inline-flex items-center gap-1.5 group">
                          {formatNumber(Number(bale.weightKg))}
                          <button
                            className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-muted"
                            onClick={() =>
                              setWeightEditBale({
                                id: bale.id,
                                referenceNumber: bale.referenceNumber,
                                weightKg: bale.weightKg,
                              })
                            }
                            title="Correct weight"
                            data-testid={`button-edit-weight-${bale.id}`}
                          >
                            <Pencil className="h-3 w-3 text-muted-foreground" />
                          </button>
                        </span>
                      </TableCell>
                      {!hiddenCost.includes("bale_history_cost_per_kg") && (
                        <TableCell className="text-right font-mono" data-testid={`text-cost-per-kg-${bale.id}`}>
                          {formatAmount(bale.costPerKg)}
                        </TableCell>
                      )}
                      {!hiddenCost.includes("bale_history_total_cost") && (
                        <TableCell className="text-right font-mono" data-testid={`text-total-cost-${bale.id}`}>
                          {formatAmount(bale.totalCost)}
                        </TableCell>
                      )}
                      {!hiddenCost.includes("bale_history_total_cost") && (
                        <TableCell className="text-right font-mono" data-testid={`text-sell-price-${bale.id}`}>
                          {sellingPricePerBale > 0 ? formatAmount(sellingPricePerBale) : "—"}
                        </TableCell>
                      )}
                      <TableCell data-testid={`text-status-${bale.id}`}>
                        {isLoadingStatus ? (
                          <Badge
                            variant="outline"
                            className="text-[10px] px-1.5 py-0.5 border-amber-400 text-amber-600 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/30 no-default-active-elevate"
                          >
                            Loading
                          </Badge>
                        ) : bale.status === "DELETED" || bale.status === "REMOVED" ? (
                          <Badge variant="destructive">Deleted</Badge>
                        ) : bale.status === "DISPATCHED" ? (
                          <Badge
                            variant="secondary"
                            className="bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                          >
                            Dispatched
                          </Badge>
                        ) : (
                          <Badge variant="secondary">{bale.status}</Badge>
                        )}
                      </TableCell>
                      <TableCell data-testid={`text-date-${bale.id}`}>{formatDateTime(bale.createdAt)}</TableCell>
                    </TableRow>
                  );
                })}
                {(!data || data.length === 0) && (
                  <TableRow>
                    <TableCell
                      colSpan={8}
                      className="text-center text-muted-foreground py-8"
                      data-testid="text-no-data"
                    >
                      No bales found for this month
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            {filteredData.map((bale) => (
              <div key={bale.id} className="p-3 rounded-md border text-sm" data-testid={`card-bale-${bale.id}`}>
                <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
                  <span className="font-medium font-mono" data-testid={`text-mobile-bale-code-${bale.id}`}>
                    {bale.baleCode}
                  </span>
                  <Badge variant="secondary" data-testid={`text-mobile-status-${bale.id}`}>
                    {bale.status}
                  </Badge>
                </div>
                <div className="text-xs mb-2">
                  <button
                    className="font-mono text-primary underline-offset-2 hover:underline cursor-pointer"
                    onClick={() => navigate(`/factory/barcode-lookup?ref=${encodeURIComponent(bale.referenceNumber)}`)}
                    data-testid={`button-ref-lookup-mobile-${bale.id}`}
                  >
                    {bale.referenceNumber}
                  </button>
                </div>
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <div>
                    <div className="text-muted-foreground flex items-center gap-1">
                      Weight
                      <button
                        onClick={() =>
                          setWeightEditBale({
                            id: bale.id,
                            referenceNumber: bale.referenceNumber,
                            weightKg: bale.weightKg,
                          })
                        }
                        className="p-0.5 rounded hover:bg-muted"
                        title="Correct weight"
                        data-testid={`button-edit-weight-mobile-${bale.id}`}
                      >
                        <Pencil className="h-2.5 w-2.5 text-muted-foreground" />
                      </button>
                    </div>
                    <div className="font-mono">{formatNumber(Number(bale.weightKg))} KG</div>
                  </div>
                  {!hiddenCost.includes("bale_history_cost_per_kg") && (
                    <div>
                      <div className="text-muted-foreground">Cost/KG</div>
                      <div className="font-mono">{formatAmount(bale.costPerKg)}</div>
                    </div>
                  )}
                  {!hiddenCost.includes("bale_history_total_cost") && (
                    <div>
                      <div className="text-muted-foreground">Cost Price</div>
                      <div className="font-mono">{formatAmount(bale.totalCost)}</div>
                    </div>
                  )}
                  {!hiddenCost.includes("bale_history_total_cost") && (
                    <div>
                      <div className="text-muted-foreground">Sell Price</div>
                      <div className="font-mono">
                        {sellingPricePerBale > 0 ? formatAmount(sellingPricePerBale) : "—"}
                      </div>
                    </div>
                  )}
                </div>
                <div className="text-xs text-muted-foreground mt-2">{formatDateTime(bale.createdAt)}</div>
              </div>
            ))}
            {(!data || data.length === 0) && (
              <div className="text-center text-muted-foreground py-8">No bales found for this month</div>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

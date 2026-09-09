import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Info, Loader2, RefreshCw, Replace, X } from "lucide-react";
import type { ClientErrorLike } from "@/lib/clientError";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { PageHeader } from "@/components/PageHeader";
import { StockItemCombobox } from "@/components/vouchers/StockItemCombobox";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface Location {
  id: number;
  name: string;
  code?: string | null;
  active?: boolean;
  deletedAt?: string | null;
}

interface StockItem {
  id: number;
  name: string;
  code: string;
  active?: boolean;
}

interface ReplacementCandidate {
  saleItemId: number;
  voucherId: number;
  voucherNumber: string;
  voucherDate: string;
  description: string | null;
  locationId: number | null;
  shiftId: number | null;
  isCreditSale: boolean | null;
  stockItemId: number;
  stockItemName: string;
  stockItemCode: string;
  quantity: string;
  sellingPrice: string;
  totalSales: string;
}

interface CandidateResponse {
  rows: ReplacementCandidate[];
  count: number;
  capped: boolean;
}

interface LastSoldPriceResponse {
  sellingPrice: string | null;
}

interface ReplacementResult {
  message: string;
  updatedVoucherIds: number[];
  replacedQuantity: string;
  replacementsApplied: number;
}

function localDateString(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function initialDateRange(): { from: string; to: string } {
  const today = new Date();
  return {
    from: localDateString(new Date(today.getFullYear(), today.getMonth(), 1)),
    to: localDateString(today),
  };
}

function displayQty(value: string | number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

function displayMoney(value: string | number): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export default function POSItemReplacement() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const initialDates = useMemo(initialDateRange, []);

  const [locationId, setLocationId] = useState<number | null>(null);
  const [sourceItem, setSourceItem] = useState<{ id: number; name: string } | null>(null);
  const [replacementItem, setReplacementItem] = useState<{ id: number; name: string } | null>(null);
  const [fromDate, setFromDate] = useState(initialDates.from);
  const [toDate, setToDate] = useState(initialDates.to);
  const [replaceQuantities, setReplaceQuantities] = useState<Record<number, string>>({});

  const { data: locations = [] } = useQuery<Location[]>({
    queryKey: ["/api/locations"],
  });

  const { data: stockItems = [] } = useQuery<StockItem[]>({
    queryKey: ["/api/stock-items/light"],
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const {
    data: replacementLastSoldPriceData,
    isLoading: replacementLastSoldPriceLoading,
  } = useQuery<LastSoldPriceResponse>({
    queryKey:
      locationId && replacementItem
        ? ["/api/pos/item-replacements/last-sold-price", locationId, replacementItem.id]
        : [],
    queryFn: async () => {
      if (!locationId || !replacementItem) return { sellingPrice: null };
      const params = new URLSearchParams({
        locationId: String(locationId),
        stockItemId: String(replacementItem.id),
      });
      const response = await fetch(`/api/pos/item-replacements/last-sold-price?${params.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) return { sellingPrice: null };
      return response.json();
    },
    enabled: Boolean(locationId && replacementItem),
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const candidateKey = [
    "/api/pos/item-replacements/candidates",
    locationId,
    sourceItem?.id ?? null,
    fromDate,
    toDate,
  ] as const;

  const {
    data: candidateData,
    isLoading: candidatesLoading,
    isFetching: candidatesFetching,
    refetch: refetchCandidates,
  } = useQuery<CandidateResponse>({
    queryKey: candidateKey,
    queryFn: async () => {
      const params = new URLSearchParams({
        locationId: String(locationId),
        stockItemId: String(sourceItem?.id),
      });
      if (fromDate) params.set("from", fromDate);
      if (toDate) params.set("to", toDate);
      const response = await fetch(`/api/pos/item-replacements/candidates?${params.toString()}`, {
        credentials: "include",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(body.message || response.statusText);
      }
      return response.json();
    },
    enabled: Boolean(locationId && sourceItem?.id),
    refetchOnWindowFocus: false,
  });

  const visibleLocations = useMemo(
    () => locations.filter((location) => location.active !== false && !location.deletedAt),
    [locations]
  );
  const activeStockItems = useMemo(() => stockItems.filter((item) => item.active !== false), [stockItems]);
  const replacementStockItems = useMemo(
    () => activeStockItems.filter((item) => item.id !== sourceItem?.id),
    [activeStockItems, sourceItem?.id]
  );
  const rows = useMemo(() => candidateData?.rows ?? [], [candidateData]);
  const replacementLastSoldPrice = replacementLastSoldPriceData?.sellingPrice ?? null;

  const selectedReplacements = useMemo(() => {
    if (!replacementItem) return [];
    return rows.flatMap((row) => {
      const requested = Number(replaceQuantities[row.saleItemId] || 0);
      if (!Number.isFinite(requested) || requested <= 0) return [];
      return [
        {
          saleItemId: row.saleItemId,
          replacementStockItemId: replacementItem.id,
          quantity: requested,
        },
      ];
    });
  }, [replacementItem, replaceQuantities, rows]);

  const invalidRows = useMemo(
    () =>
      rows.filter((row) => {
        const requested = Number(replaceQuantities[row.saleItemId] || 0);
        return Number.isFinite(requested) && requested > Number(row.quantity);
      }),
    [replaceQuantities, rows]
  );

  const totalReplaceQty = selectedReplacements.reduce((sum, row) => sum + row.quantity, 0);
  const affectedVoucherCount = new Set(
    selectedReplacements.map((replacement) => rows.find((row) => row.saleItemId === replacement.saleItemId)?.voucherId)
  ).size;

  const replacementMutation = useMutation({
    mutationFn: async () => {
      const response = await apiRequest("POST", "/api/pos/item-replacements", {
        locationId,
        replacements: selectedReplacements,
      });
      return (await response.json()) as ReplacementResult;
    },
    onSuccess: (result) => {
      toast({
        title: "POS items corrected",
        description: `${displayQty(result.replacedQuantity)} qty replaced across ${result.updatedVoucherIds.length} sale${result.updatedVoucherIds.length === 1 ? "" : "s"}.`,
      });
      setReplaceQuantities({});
      queryClient.invalidateQueries({ queryKey: ["/api/pos/item-replacements/candidates"] });
      queryClient.invalidateQueries({ queryKey: ["/api/pos/item-replacements/last-sold-price"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stock-query"] });
      queryClient.invalidateQueries({ queryKey: ["/api/inventory"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sales-report"] });
      void refetchCandidates();
    },
    onError: (error: ClientErrorLike) => {
      toast({
        title: "Replacement failed",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const updateQty = (row: ReplacementCandidate, value: string) => {
    if (value === "") {
      setReplaceQuantities((current) => ({ ...current, [row.saleItemId]: "" }));
      return;
    }
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return;
    setReplaceQuantities((current) => ({ ...current, [row.saleItemId]: value }));
  };

  const canSubmit =
    Boolean(locationId && sourceItem && replacementItem) &&
    selectedReplacements.length > 0 &&
    invalidRows.length === 0 &&
    !replacementMutation.isPending;

  return (
    <div className="p-3 sm:p-6 space-y-4 sm:space-y-6 max-w-[1500px] mx-auto">
      <PageHeader
        title="POS Item Replacement"
        subtitle="Correct items entered on POS sales in bulk without opening each sale one by one"
      />

      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Correction only</AlertTitle>
        <AlertDescription>
          The original selling price and sale total stay unchanged. The tool replaces only the quantity you enter, returns
          that quantity to the wrong item, deducts it from the correct item, and recalculates item cost/profit through the
          normal POS edit flow.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Replace className="h-4 w-4" />
            Choose what to replace
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-5 gap-4 items-end">
            <div className="space-y-2">
              <Label>Location</Label>
              <Select
                value={locationId ? String(locationId) : ""}
                onValueChange={(value) => {
                  setLocationId(Number(value));
                  setReplaceQuantities({});
                }}
              >
                <SelectTrigger data-testid="select-pos-replacement-location">
                  <SelectValue placeholder="Choose location" />
                </SelectTrigger>
                <SelectContent>
                  {visibleLocations.map((location) => (
                    <SelectItem key={location.id} value={String(location.id)}>
                      {location.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <Label>Wrong item in POS</Label>
              <StockItemCombobox
                value={sourceItem}
                onChange={(id, name) => {
                  setSourceItem({ id, name });
                  if (replacementItem?.id === id) setReplacementItem(null);
                  setReplaceQuantities({});
                }}
                stockItems={activeStockItems}
                rowIndex={0}
                testIdPrefix="button-pos-replacement-source"
              />
            </div>

            <div className="hidden xl:flex justify-center pb-2">
              <ArrowRight className="h-5 w-5 text-muted-foreground" />
            </div>

            <div className="space-y-2">
              <Label>Correct item</Label>
              <StockItemCombobox
                value={replacementItem}
                onChange={(id, name) => setReplacementItem({ id, name })}
                stockItems={replacementStockItems}
                rowIndex={0}
                testIdPrefix="button-pos-replacement-target"
              />
              {replacementItem && (
                <div className="min-h-5 text-xs text-muted-foreground flex items-center gap-1.5">
                  {replacementLastSoldPriceLoading ? (
                    <Loader2 className="h-3 w-3 animate-spin" />
                  ) : (
                    <>
                      <span>Last sold at this location:</span>
                      <span className="font-mono font-medium text-foreground">
                        {replacementLastSoldPrice === null ? "No prior sale" : displayMoney(replacementLastSoldPrice)}
                      </span>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-2">
                <Label htmlFor="pos-replacement-from">From</Label>
                <Input
                  id="pos-replacement-from"
                  type="date"
                  value={fromDate}
                  onChange={(event) => {
                    setFromDate(event.target.value);
                    setReplaceQuantities({});
                  }}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="pos-replacement-to">To</Label>
                <Input
                  id="pos-replacement-to"
                  type="date"
                  value={toDate}
                  onChange={(event) => {
                    setToDate(event.target.value);
                    setReplaceQuantities({});
                  }}
                />
              </div>
            </div>
          </div>

          {locationId && sourceItem && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void refetchCandidates()}
                disabled={candidatesFetching}
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${candidatesFetching ? "animate-spin" : ""}`} />
                Refresh sales
              </Button>
              <Badge variant="secondary">{candidateData?.count ?? 0} matching POS line{candidateData?.count === 1 ? "" : "s"}</Badge>
              {candidateData?.capped && <Badge variant="destructive">Showing newest 500 rows — narrow the date range</Badge>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <CardTitle className="text-base">Matching sales</CardTitle>
              <p className="text-xs text-muted-foreground mt-1">
                Enter a replacement quantity only on the POS lines that were wrong. Leave the rest blank.
              </p>
            </div>
            {selectedReplacements.length > 0 && (
              <Button type="button" variant="ghost" size="sm" onClick={() => setReplaceQuantities({})}>
                <X className="h-3.5 w-3.5 mr-1.5" />
                Clear quantities
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0 sm:p-6 sm:pt-0">
          {!locationId || !sourceItem ? (
            <div className="py-16 text-center text-sm text-muted-foreground px-4">
              Choose a location and the wrong item to load matching POS sales.
            </div>
          ) : candidatesLoading ? (
            <div className="py-16 flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading matching POS sales…
            </div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-sm text-muted-foreground px-4">
              No matching sales found for this item, location, and date range.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead>POS / Voucher</TableHead>
                    <TableHead className="text-right">Sold Qty</TableHead>
                    <TableHead className="text-right">POS Price</TableHead>
                    <TableHead className="text-right">New Item Last Sold</TableHead>
                    <TableHead className="w-[150px] text-right">Replace Qty</TableHead>
                    <TableHead className="text-right">Old Item Left</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((row) => {
                    const rawReplacement = replaceQuantities[row.saleItemId] ?? "";
                    const replacementQty = Number(rawReplacement || 0);
                    const soldQty = Number(row.quantity);
                    const isInvalid = Number.isFinite(replacementQty) && replacementQty > soldQty;
                    const remaining = Math.max(0, soldQty - (Number.isFinite(replacementQty) ? replacementQty : 0));
                    return (
                      <TableRow key={row.saleItemId} className={replacementQty > 0 ? "bg-muted/40" : undefined}>
                        <TableCell className="whitespace-nowrap text-sm">{row.voucherDate}</TableCell>
                        <TableCell>
                          <div className="font-medium text-sm">{row.voucherNumber}</div>
                          <div className="text-xs text-muted-foreground truncate max-w-[280px]">{row.description || "POS Sale"}</div>
                        </TableCell>
                        <TableCell className="text-right font-mono font-medium">{displayQty(row.quantity)}</TableCell>
                        <TableCell className="text-right font-mono">{displayMoney(row.sellingPrice)}</TableCell>
                        <TableCell className="text-right">
                          {!replacementItem ? (
                            <span className="text-xs text-muted-foreground">—</span>
                          ) : replacementLastSoldPriceLoading ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin ml-auto" />
                          ) : replacementLastSoldPrice === null ? (
                            <span className="text-xs text-muted-foreground">No prior sale</span>
                          ) : (
                            <span className="font-mono">{displayMoney(replacementLastSoldPrice)}</span>
                          )}
                        </TableCell>
                        <TableCell>
                          <div className="space-y-1">
                            <Input
                              type="number"
                              min="0"
                              max={row.quantity}
                              step="0.001"
                              inputMode="decimal"
                              value={rawReplacement}
                              onChange={(event) => updateQty(row, event.target.value)}
                              placeholder="0"
                              className={`text-right font-mono ${isInvalid ? "border-destructive focus-visible:ring-destructive" : ""}`}
                              data-testid={`input-pos-replacement-qty-${row.saleItemId}`}
                            />
                            <div className="flex justify-end gap-1">
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-[11px]"
                                onClick={() => updateQty(row, "1")}
                                disabled={soldQty < 1}
                              >
                                1
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="sm"
                                className="h-6 px-2 text-[11px]"
                                onClick={() => updateQty(row, row.quantity)}
                              >
                                All
                              </Button>
                            </div>
                            {isInvalid && <p className="text-[11px] text-destructive text-right">Max {displayQty(row.quantity)}</p>}
                          </div>
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {displayQty(remaining)}
                          {replacementQty > 0 && replacementItem && (
                            <div className="text-[11px] text-muted-foreground mt-1">
                              +{displayQty(replacementQty)} → {replacementItem.name}
                            </div>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {selectedReplacements.length > 0 && (
        <Card className="sticky bottom-3 shadow-lg border-primary/30">
          <CardContent className="p-4 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div>
              <p className="font-medium text-sm">
                Replace {displayQty(totalReplaceQty)} qty from {sourceItem?.name} → {replacementItem?.name || "choose correct item"}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {selectedReplacements.length} sale line{selectedReplacements.length === 1 ? "" : "s"} across {affectedVoucherCount} POS sale{affectedVoucherCount === 1 ? "" : "s"}. Original sale prices stay unchanged.
              </p>
            </div>
            <Button
              type="button"
              onClick={() => replacementMutation.mutate()}
              disabled={!canSubmit}
              data-testid="button-apply-pos-item-replacements"
              className="min-w-[210px]"
            >
              {replacementMutation.isPending ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Replace className="h-4 w-4 mr-2" />
              )}
              Apply {selectedReplacements.length} replacement{selectedReplacements.length === 1 ? "" : "s"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

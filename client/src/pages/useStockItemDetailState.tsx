// Extracted from ./StockItemDetail.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation, useRoute, useSearch } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MapPin } from "lucide-react";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useCurrencyContext } from "@/contexts/CurrencyContext";
import { useEscapeBack } from "@/hooks/use-escape-back";

export type DatePreset =
  "all" | "today" | "yesterday" | "this-month" | "last-1-month" | "last-6-months" | "this-year" | "custom";

function getPresetDates(preset: DatePreset): { from: string; to: string } {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const fmt = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const today = fmt(now);
  switch (preset) {
    case "all":
      return { from: "", to: "" };
    case "today":
      return { from: today, to: today };
    case "yesterday": {
      const d = new Date(now);
      d.setDate(d.getDate() - 1);
      return { from: fmt(d), to: fmt(d) };
    }
    case "this-month":
      return {
        from: fmt(new Date(now.getFullYear(), now.getMonth(), 1)),
        to: fmt(new Date(now.getFullYear(), now.getMonth() + 1, 0)),
      };
    case "last-1-month": {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 1);
      return { from: fmt(d), to: today };
    }
    case "last-6-months": {
      const d = new Date(now);
      d.setMonth(d.getMonth() - 6);
      return { from: fmt(d), to: today };
    }
    case "this-year":
      return { from: fmt(new Date(now.getFullYear(), 0, 1)), to: today };
    default:
      return { from: "", to: "" };
  }
}

export const PRESET_LABELS: Record<DatePreset, string> = {
  all: "All Time",
  today: "Today",
  yesterday: "Yesterday",
  "this-month": "This Month",
  "last-1-month": "Last 1 Month",
  "last-6-months": "Last 6 Months",
  "this-year": "This Year",
  custom: "Custom Range",
};

interface StockItem {
  id: number;
  code: string;
  name: string;
  uom: string;
  stockGroupId: number | null;
  active: boolean;
}

interface Purchase {
  poNumber: string;
  poDate: string;
  supplierName: string;
  containerNumber: string | null;
  quantity: string;
  rate: string;
  amount: string;
}

interface Sale {
  voucherNumber: string;
  saleDate: string;
  locationName: string | null;
  quantity: string;
  sellingPrice: string;
  totalSales: string;
  voucherId?: number;
  posStation?: number | null;
}

interface InventoryLocation {
  locationId: number;
  locationName: string;
  locationCode: string;
  quantity: string;
  averageRate: string;
  totalValue: string;
}

interface StockItemDetails {
  purchases: Purchase[];
  sales: Sale[];
  inventoryLocations: InventoryLocation[];
}

export const formatSmartNumber = (value: string | number) => {
  const num = typeof value === "string" ? parseFloat(value) : value;
  if (Number.isNaN(num)) return "0";
  return num % 1 === 0 ? num.toString() : value.toString();
};

export function useStockItemDetailState() {
  const { formatDisplayDate } = useDateFormat();
  const { formatAmount } = useCurrencyContext();
  const [, params] = useRoute("/stock-query/:id");
  const [, navigate] = useLocation();
  const itemId = params?.id ? parseInt(params.id) : null;

  const [preset, setPreset] = useState<DatePreset>("all");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [selectedLocation, setSelectedLocation] = useState("all");

  const applyPreset = (next: DatePreset) => {
    setPreset(next);
    if (next !== "custom") {
      const dates = getPresetDates(next);
      setFromDate(dates.from);
      setToDate(dates.to);
    }
  };

  const { data: stockItems = [] } = useQuery<StockItem[]>({
    queryKey: ["/api/stock-items/light"],
    staleTime: 10 * 60 * 1000,
    refetchOnWindowFocus: false,
    refetchOnMount: false,
    refetchOnReconnect: false,
  });
  const selectedItem = stockItems.find((item) => item.id === itemId);

  const {
    data: itemDetails,
    isLoading: detailsLoading,
    error: detailsError,
    refetch: refetchDetails,
  } = useQuery<StockItemDetails>({
    queryKey: ["/api/stock-items", itemId, "details", fromDate, toDate],
    queryFn: async () => {
      const query = new URLSearchParams();
      if (fromDate) query.set("from", fromDate);
      if (toDate) query.set("to", toDate);
      const suffix = query.toString();
      const response = await fetch(`/api/stock-items/${itemId}/details${suffix ? `?${suffix}` : ""}`, {
        credentials: "include",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({ message: response.statusText }));
        throw new Error(body.message || response.statusText);
      }
      return response.json();
    },
    enabled: !!itemId,
  });

  const locationOptions = useMemo(() => {
    const names = new Set<string>();
    itemDetails?.inventoryLocations.forEach((location) => names.add(location.locationName));
    itemDetails?.sales.forEach((sale) => {
      if (sale.locationName) names.add(sale.locationName);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [itemDetails]);

  const filteredSales = useMemo(() => {
    if (!itemDetails || selectedLocation === "all") return itemDetails?.sales ?? [];
    return itemDetails.sales.filter((sale) => sale.locationName === selectedLocation);
  }, [itemDetails, selectedLocation]);

  const filteredInventoryLocations = useMemo(() => {
    if (!itemDetails || selectedLocation === "all") return itemDetails?.inventoryLocations ?? [];
    return itemDetails.inventoryLocations.filter((location) => location.locationName === selectedLocation);
  }, [itemDetails, selectedLocation]);

  const search = useSearch();
  const from = new URLSearchParams(search).get("from");
  const handleBack = () => {
    if (from === "pos-daybook") navigate("/pos-daybook");
    else if (from === "daybook") navigate("/daybook");
    else navigate("/stock-query");
  };
  useEscapeBack(handleBack);

  const handleSaleClick = (sale: Sale) => {
    if (!sale.voucherId) return;
    if (sale.posStation != null)
      navigate(`/pos-daybook?date=${sale.saleDate.split(" ")[0]}&voucherId=${sale.voucherId}`);
    else navigate(`/vouchers/${sale.voucherId}/edit`);
  };
  return {
    applyPreset,
    detailsError,
    detailsLoading,
    filteredInventoryLocations,
    filteredSales,
    formatAmount,
    formatDisplayDate,
    fromDate,
    handleBack,
    handleSaleClick,
    itemDetails,
    itemId,
    locationOptions,
    preset,
    refetchDetails,
    selectedItem,
    selectedLocation,
    setFromDate,
    setSelectedLocation,
    setToDate,
    stockItems,
    toDate,
  };
}

export function StockItemDetailCardSection({
  filteredInventoryLocations,
  formatAmount,
}: Pick<ReturnType<typeof useStockItemDetailState>, "filteredInventoryLocations" | "formatAmount">) {
  return (
    <Card className="lg:col-span-2 flex flex-col">
      <CardHeader className="pb-3">
        <CardTitle className="text-base flex items-center gap-2">
          <MapPin className="h-4 w-4" />
          Current Inventory Locations
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 overflow-hidden">
        {filteredInventoryLocations.length ? (
          <div className="h-64 overflow-y-auto">
            <Table>
              <TableHeader className="sticky top-0 bg-background">
                <TableRow>
                  <TableHead>Location</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead className="text-right">Avg Rate</TableHead>
                  <TableHead className="text-right">Total Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredInventoryLocations.map((location) => (
                  <TableRow key={location.locationId}>
                    <TableCell className="text-sm">{location.locationName}</TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatSmartNumber(location.quantity)}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatAmount(parseFloat(location.averageRate))}
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">
                      {formatAmount(parseFloat(location.totalValue))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
              <TableFooter>
                <TableRow className="font-semibold">
                  <TableCell>Total</TableCell>
                  <TableCell className="text-right font-mono">
                    {formatSmartNumber(
                      filteredInventoryLocations.reduce(
                        (sum, location) => sum + parseFloat(location.quantity || "0"),
                        0
                      )
                    )}
                  </TableCell>
                  <TableCell />
                  <TableCell className="text-right font-mono">
                    {formatAmount(
                      filteredInventoryLocations.reduce(
                        (sum, location) => sum + parseFloat(location.totalValue || "0"),
                        0
                      )
                    )}
                  </TableCell>
                </TableRow>
              </TableFooter>
            </Table>
          </div>
        ) : (
          <div className="h-64 flex items-center justify-center text-muted-foreground">
            No inventory at this location
          </div>
        )}
      </CardContent>
    </Card>
  );
}

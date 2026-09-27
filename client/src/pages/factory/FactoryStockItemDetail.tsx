import { useQuery } from "@tanstack/react-query";
import { useRoute, useLocation } from "wouter";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, Printer, TrendingUp, Ship, Package } from "lucide-react";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { Skeleton } from "@/components/ui/skeleton";
import { useEscapeBack } from "@/hooks/use-escape-back";
import { PageHeader } from "@/components/PageHeader";

interface PressedEntry {
  date: string;
  qty: number;
  totalWeight: number;
  totalCost: number;
}

interface SaleEntry {
  orderId: number;
  invoiceNumber: string;
  orderDate: string;
  containerNumber: string | null;
  customerName: string;
  qty: number;
  pricePerBale: string;
  total: string;
  status: string;
}

interface LoadedEntry {
  orderId: number;
  invoiceNumber: string;
  orderDate: string;
  containerNumber: string | null;
  customerName: string;
  qty: number;
  total: string;
  status: string;
}

interface StockLocation {
  locationId: number;
  locationName: string;
  qty: number;
  totalWeight: number;
}

interface CurrentStock {
  totalQty: number;
  totalWeight: number;
  locations: StockLocation[];
}

interface BaleProductDetail {
  product: { id: number; name: string; articleCode: string | null };
  pressed: PressedEntry[];
  sales: SaleEntry[];
  loaded: LoadedEntry[];
  currentStock: CurrentStock;
}

const fmt = (n: number) => {
  const s = n % 1 === 0 ? n.toString() : n.toFixed(2).replace(/\.?0+$/, "");
  return s;
};

export default function FactoryStockItemDetail() {
  const { formatDisplayDate } = useDateFormat();
  const [_factoryMatch, factoryParams] = useRoute("/factory/stock-query/:id");
  const [_location, navigate] = useLocation();

  const productId = factoryParams?.id ? parseInt(factoryParams.id) : null;

  const handleBack = () => navigate("/factory/stock-query");
  useEscapeBack(handleBack);

  const { data, isLoading, error } = useQuery<BaleProductDetail>({
    queryKey: ["/api/factory/bale-product-detail", productId],
    queryFn: async () => {
      const res = await fetch(`/api/factory/bale-product-detail/${productId}`, { credentials: "include" });
      if (!res.ok) throw new Error((await res.json()).message || "Failed to fetch product detail");
      return res.json();
    },
    enabled: !!productId,
  });

  if (!productId) {
    return (
      <div className="p-4 sm:p-6 space-y-4">
        <Button variant="ghost" onClick={handleBack} className="gap-2">
          <ArrowLeft className="h-4 w-4" /> Back
        </Button>
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">Product not found</CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 space-y-4 sm:space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" onClick={handleBack} data-testid="button-back" className="gap-2">
          <ArrowLeft className="h-4 w-4" />
          <span className="hidden sm:inline">Back to Stock Query</span>
          <span className="sm:hidden">Back</span>
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">
          <Skeleton className="h-8 w-64" />
          <Skeleton className="h-4 w-40" />
        </div>
      ) : (
        <div>
          <PageHeader title={data?.product.name ?? "Loading..."} />
          {data?.product.articleCode && <p className="text-sm text-muted-foreground">{data.product.articleCode}</p>}
        </div>
      )}

      {isLoading ? (
        <div className="space-y-4">
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
          <Skeleton className="h-56 w-full" />
        </div>
      ) : error ? (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">Failed to load product details.</CardContent>
        </Card>
      ) : !data ? null : (
        <div className="space-y-4 sm:space-y-6">
          {/* Box 0: Current Stock */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Package className="h-4 w-4" />
                Current Stock
              </CardTitle>
            </CardHeader>
            <CardContent>
              {!data.currentStock || data.currentStock.totalQty === 0 ? (
                <div className="py-6 text-center text-muted-foreground text-sm">No bales currently in stock</div>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="rounded-md border px-4 py-3">
                      <p className="text-xs text-muted-foreground mb-1">Total Bales</p>
                      <p className="text-2xl font-bold font-mono" data-testid="text-current-stock-qty">
                        {data.currentStock.totalQty}
                      </p>
                    </div>
                    <div className="rounded-md border px-4 py-3">
                      <p className="text-xs text-muted-foreground mb-1">Total Weight</p>
                      <p className="text-2xl font-bold font-mono" data-testid="text-current-stock-weight">
                        {fmt(data.currentStock.totalWeight)}{" "}
                        <span className="text-sm font-normal text-muted-foreground">kg</span>
                      </p>
                    </div>
                  </div>
                  {data.currentStock.locations.length > 0 && (
                    <div className="table-responsive">
                      <Table mobileLayout="cards">
                        <TableHeader className="sticky top-0 z-30 bg-background">
                          <TableRow>
                            <TableHead>Location</TableHead>
                            <TableHead className="text-right">Bales</TableHead>
                            <TableHead className="text-right">Weight (kg)</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {data.currentStock.locations.map((loc) => (
                            <TableRow key={loc.locationId} data-testid={`row-stock-location-${loc.locationId}`}>
                              <TableCell className="text-sm">{loc.locationName}</TableCell>
                              <TableCell className="text-right font-mono text-sm">{loc.qty}</TableCell>
                              <TableCell className="text-right font-mono text-sm">{fmt(loc.totalWeight)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                        <TableFooter className="sticky bottom-0 z-20 bg-background">
                          <TableRow className="font-semibold text-sm">
                            <TableCell>Total</TableCell>
                            <TableCell className="text-right font-mono">{data.currentStock.totalQty}</TableCell>
                            <TableCell className="text-right font-mono">{fmt(data.currentStock.totalWeight)}</TableCell>
                          </TableRow>
                        </TableFooter>
                      </Table>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Box 1: Pressed / Printed */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Printer className="h-4 w-4" />
                Pressed / Printed
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.pressed.length === 0 ? (
                <div className="py-6 text-center text-muted-foreground text-sm">No stock entries yet</div>
              ) : (
                <div className="table-responsive">
                  <Table mobileLayout="cards">
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Weight (kg)</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.pressed.map((row, i) => (
                        <TableRow key={i} data-testid={`row-pressed-${i}`}>
                          <TableCell className="text-sm">
                            {formatDisplayDate(new Date(row.date + "T00:00:00"))}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">{row.qty}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{fmt(row.totalWeight)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                    <TableFooter className="sticky bottom-0 z-20 bg-background">
                      <TableRow className="font-semibold text-sm">
                        <TableCell>Total</TableCell>
                        <TableCell className="text-right font-mono">
                          {data.pressed.reduce((s, r) => s + r.qty, 0)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {fmt(data.pressed.reduce((s, r) => s + r.totalWeight, 0))}
                        </TableCell>
                      </TableRow>
                    </TableFooter>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Box 2: Sales */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-4 w-4" />
                Sales
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.sales.length === 0 ? (
                <div className="py-6 text-center text-muted-foreground text-sm">No sales recorded</div>
              ) : (
                <div className="table-responsive">
                  <Table mobileLayout="cards">
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead>Invoice</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Price/Bale</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.sales.map((row, i) => (
                        <TableRow key={i} data-testid={`row-sale-${i}`}>
                          <TableCell className="text-sm whitespace-nowrap">
                            {formatDisplayDate(new Date(row.orderDate + "T00:00:00"))}
                          </TableCell>
                          <TableCell className="text-sm">{row.customerName}</TableCell>
                          <TableCell className="text-sm font-mono">{row.invoiceNumber}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{row.qty}</TableCell>
                          <TableCell className="text-right font-mono text-sm">
                            {fmt(parseFloat(row.pricePerBale))}
                          </TableCell>
                          <TableCell className="text-right font-mono text-sm">{fmt(parseFloat(row.total))}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                    <TableFooter className="sticky bottom-0 z-20 bg-background">
                      <TableRow className="font-semibold text-sm">
                        <TableCell colSpan={3}>Total</TableCell>
                        <TableCell className="text-right font-mono">
                          {data.sales.reduce((s, r) => s + r.qty, 0)}
                        </TableCell>
                        <TableCell></TableCell>
                        <TableCell className="text-right font-mono">
                          {fmt(data.sales.reduce((s, r) => s + parseFloat(r.total), 0))}
                        </TableCell>
                      </TableRow>
                    </TableFooter>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Box 3: Loaded in Containers / OTW */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Ship className="h-4 w-4" />
                Loaded in Containers (On The Way)
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.loaded.length === 0 ? (
                <div className="py-6 text-center text-muted-foreground text-sm">No bales currently in loading</div>
              ) : (
                <div className="table-responsive">
                  <Table mobileLayout="cards">
                    <TableHeader className="sticky top-0 z-30 bg-background">
                      <TableRow>
                        <TableHead>Invoice</TableHead>
                        <TableHead>Customer</TableHead>
                        <TableHead>Container</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.loaded.map((row, i) => (
                        <TableRow key={i} data-testid={`row-loaded-${i}`}>
                          <TableCell className="text-sm font-mono">{row.invoiceNumber}</TableCell>
                          <TableCell className="text-sm">{row.customerName}</TableCell>
                          <TableCell className="text-sm font-mono">{row.containerNumber || "—"}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{row.qty}</TableCell>
                          <TableCell className="text-right font-mono text-sm">{fmt(parseFloat(row.total))}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                    <TableFooter className="sticky bottom-0 z-20 bg-background">
                      <TableRow className="font-semibold text-sm">
                        <TableCell colSpan={3}>Total</TableCell>
                        <TableCell className="text-right font-mono">
                          {data.loaded.reduce((s, r) => s + r.qty, 0)}
                        </TableCell>
                        <TableCell className="text-right font-mono">
                          {fmt(data.loaded.reduce((s, r) => s + parseFloat(r.total), 0))}
                        </TableCell>
                      </TableRow>
                    </TableFooter>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

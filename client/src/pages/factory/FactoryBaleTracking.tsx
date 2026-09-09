import { getErrorDetails } from "@shared/errorUtils";
import { useState, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/PageHeader";
import { Search, Package, Truck, FileText, CheckCircle, Clock, ArrowRight, ScanLine } from "lucide-react";

interface BaleSearchResult {
  bale: {
    referenceNumber: string;
    articleCode: string;
    productName: string;
    weightKg: string;
    status: string;
  } | null;
  status: "IN_STOCK" | "RESERVED_FOR_DISPATCH" | "SOLD";
  dispatch: {
    scanId: number;
    batchId: number;
    batchNumber: string;
    batchStatus: string;
    truckRideId: number;
    rideNumber: number;
    truckPlate: string | null;
    driverName: string | null;
    rideStatus: string;
    customerId: number;
    customerName: string;
    proformaName: string | null;
    articleCode: string | null;
    productName: string | null;
    weightKg: string;
    amount: string;
    currency: string;
    scannedAt: string;
    invoiceNumber: string | null;
    orderId: number | null;
  } | null;
}

const STATUS_CONFIG = {
  IN_STOCK: { label: "In Stock", color: "bg-muted text-muted-foreground", icon: Package },
  RESERVED_FOR_DISPATCH: {
    label: "Reserved for Dispatch",
    color: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
    icon: Truck,
  },
  SOLD: {
    label: "Sold",
    color: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
    icon: CheckCircle,
  },
};

function fmtNum(n: number | string) {
  const v = typeof n === "string" ? parseFloat(n) : n;
  if (isNaN(v)) return "0";
  return v.toLocaleString(undefined, { maximumFractionDigits: 3 });
}

export default function FactoryBaleTracking() {
  const [, navigate] = useLocation();
  const { data: me } = useQuery<{ role: string }>({ queryKey: ["/api/auth/me"] });
  const isDeveloper = me?.role === "Developer";

  const [query, setQuery] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<BaleSearchResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  async function doSearch(q: string) {
    const trimmed = q.trim();
    if (!trimmed) return;
    setLoading(true);
    setError(null);
    setResult(null);
    setSubmitted(trimmed);
    try {
      const res = await fetch(`/api/factory/bale-search?q=${encodeURIComponent(trimmed)}`, { credentials: "include" });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.message || "Not found");
      }
      setResult(await res.json());
    } catch (e) {
      setError(getErrorDetails(e).message || "Search failed");
    } finally {
      setLoading(false);
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") doSearch(query);
  }

  const statusCfg = result ? STATUS_CONFIG[result.status] || STATUS_CONFIG.IN_STOCK : null;
  const baleInfo =
    result?.bale ??
    (result?.dispatch
      ? {
          referenceNumber: result.dispatch.batchNumber,
          articleCode: result.dispatch.articleCode || "",
          productName: result.dispatch.productName || "",
          weightKg: result.dispatch.weightKg,
          status: result.status,
        }
      : null);

  if (me && !isDeveloper) {
    return (
      <div className="mx-auto max-w-2xl space-y-5 p-3 sm:p-4">
        <PageHeader title="Bale Tracking" />
        <Card>
          <CardContent className="pt-6 pb-6 text-center text-muted-foreground">
            You do not have access to this page.
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-5 p-3 sm:p-4" data-testid="factory-bale-tracking-page">
      <PageHeader title="Bale Tracking" />

      {/* Search box */}
      <Card>
        <CardContent className="pt-4 pb-4">
          <p className="text-sm text-muted-foreground mb-3">
            Enter a bale reference number to see its current status — in stock, reserved for dispatch, or sold.
          </p>
          <div className="flex flex-col gap-2 min-[420px]:flex-row">
            <div className="relative min-w-0 flex-1">
              <ScanLine className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                ref={inputRef}
                className="pl-9"
                placeholder="Bale reference (e.g. B-2025-001234)"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKey}
                autoFocus
                data-testid="input-bale-search"
              />
            </div>
            <Button
              onClick={() => doSearch(query)}
              disabled={loading || !query.trim()}
              className="w-full min-[420px]:w-auto"
              data-testid="button-search-bale"
            >
              <Search className="w-4 h-4 mr-1.5" />
              Search
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Loading */}
      {loading && (
        <Card>
          <CardContent className="pt-4 space-y-3">
            <Skeleton className="h-6 w-32" />
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-3/4" />
          </CardContent>
        </Card>
      )}

      {/* Error */}
      {!loading && error && (
        <Card>
          <CardContent className="pt-4">
            <p className="break-words text-sm text-muted-foreground">
              Bale <span className="break-all font-mono font-semibold text-foreground">{submitted}</span> was not found.
            </p>
            <p className="text-xs text-muted-foreground mt-1">{error}</p>
          </CardContent>
        </Card>
      )}

      {/* Result */}
      {!loading && result && statusCfg && (
        <div className="space-y-4">
          {/* Status header card */}
          <Card>
            <CardContent className="pt-4">
              <div className="mb-4 flex flex-wrap items-center gap-3">
                <Badge className={`${statusCfg.color} px-3 py-1 text-sm`} data-testid="badge-bale-status">
                  {statusCfg.label}
                </Badge>
                <span className="min-w-0 break-all font-mono text-lg font-bold" data-testid="text-bale-reference">
                  {submitted}
                </span>
              </div>

              {baleInfo && (
                <div className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm min-[420px]:grid-cols-2">
                  {baleInfo.articleCode && (
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">Article Code</p>
                      <p className="break-all font-mono font-medium" data-testid="text-bale-article">
                        {baleInfo.articleCode}
                      </p>
                    </div>
                  )}
                  {baleInfo.productName && (
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">Product</p>
                      <p className="break-words" data-testid="text-bale-product">
                        {baleInfo.productName}
                      </p>
                    </div>
                  )}
                  {baleInfo.weightKg && (
                    <div>
                      <p className="text-xs text-muted-foreground">Weight</p>
                      <p className="font-mono" data-testid="text-bale-weight">
                        {fmtNum(baleInfo.weightKg)} kg
                      </p>
                    </div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Dispatch info */}
          {result.dispatch && (
            <Card>
              <CardHeader className="pb-2 pt-4">
                <CardTitle className="text-sm font-semibold flex items-center gap-2">
                  <Truck className="w-4 h-4 text-muted-foreground" />
                  Dispatch Information
                </CardTitle>
              </CardHeader>
              <CardContent className="pb-4">
                <div className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm min-[420px]:grid-cols-2">
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Batch</p>
                    <button
                      className="max-w-full break-all text-left font-mono font-semibold text-blue-600 hover:underline dark:text-blue-400"
                      onClick={() => navigate(`/factory/dispatch-batches/${result.dispatch!.batchId}`)}
                      data-testid="link-batch"
                    >
                      {result.dispatch.batchNumber}
                    </button>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Batch Status</p>
                    <Badge className={STATUS_CONFIG[result.status as keyof typeof STATUS_CONFIG]?.color || ""}>
                      {result.dispatch.batchStatus}
                    </Badge>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs text-muted-foreground">Customer</p>
                    <p className="break-words" data-testid="text-dispatch-customer">
                      {result.dispatch.customerName || "—"}
                    </p>
                  </div>
                  {result.dispatch.proformaName && (
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">Proforma</p>
                      <p className="break-words">{result.dispatch.proformaName}</p>
                    </div>
                  )}
                  <div>
                    <p className="text-xs text-muted-foreground">Truck Ride</p>
                    <p className="font-mono">#{result.dispatch.rideNumber}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Ride Status</p>
                    <Badge variant="outline" className="text-xs">
                      {result.dispatch.rideStatus}
                    </Badge>
                  </div>
                  {result.dispatch.truckPlate && (
                    <div>
                      <p className="text-xs text-muted-foreground">Truck Plate</p>
                      <p className="font-mono">{result.dispatch.truckPlate}</p>
                    </div>
                  )}
                  {result.dispatch.driverName && (
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">Driver</p>
                      <p className="break-words">{result.dispatch.driverName}</p>
                    </div>
                  )}
                  {result.dispatch.amount && (
                    <div>
                      <p className="text-xs text-muted-foreground">Amount</p>
                      <p className="font-mono font-medium">
                        {result.dispatch.currency} {fmtNum(result.dispatch.amount)}
                      </p>
                    </div>
                  )}
                </div>

                {/* Invoice info if sold */}
                {result.dispatch.invoiceNumber && result.dispatch.orderId && (
                  <div className="mt-4 flex flex-col gap-3 border-t pt-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="text-xs text-muted-foreground">Invoice</p>
                      <p className="break-all font-mono font-semibold" data-testid="text-invoice-number">
                        {result.dispatch.invoiceNumber}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      className="w-full sm:w-auto"
                      onClick={() => navigate(`/factory/sales/invoices/${result.dispatch!.orderId}`)}
                      data-testid="button-view-invoice"
                    >
                      <FileText className="w-3.5 h-3.5 mr-1.5" />
                      View Invoice
                    </Button>
                  </div>
                )}

                <div className="mt-3 flex justify-stretch sm:justify-end">
                  <Button
                    size="sm"
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={() => navigate(`/factory/dispatch-batches/${result.dispatch!.batchId}`)}
                    data-testid="button-view-batch"
                  >
                    <ArrowRight className="w-3.5 h-3.5 mr-1.5" />
                    View Dispatch Batch
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* In stock — no dispatch info */}
          {!result.dispatch && result.status === "IN_STOCK" && (
            <Card>
              <CardContent className="pt-4">
                <div className="flex items-start gap-2 text-sm text-muted-foreground sm:items-center">
                  <Clock className="mt-0.5 w-4 h-4 shrink-0 sm:mt-0" />
                  This bale is currently in stock and has not been assigned to any dispatch batch.
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

import { useQuery } from "@tanstack/react-query";
import { useParams, useLocation } from "wouter";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from "recharts";
import { useEscapeToParent } from "@/hooks/use-escape-to-parent";

import type { BaleProductHistoryResponse } from "./types";

// ── Main bale-product history page (monthly overview) ────────────────────────
export function FactoryBaleProductHistory() {
  const params = useParams();
  const [, navigate] = useLocation();
  useEscapeToParent();

  const productId = params.productId || "0";
  const locationId = params.locationId || "0";
  const year = params.year || String(new Date().getFullYear());

  const backPath = "/factory/production";

  const { data, isLoading } = useQuery<BaleProductHistoryResponse>({
    queryKey: ["/api/factory/bale-product-history", productId, locationId, year],
    queryFn: async () => {
      const response = await fetch(`/api/factory/bale-product-history/${productId}/${locationId}/${year}`, {
        credentials: "include",
      });
      if (!response.ok) throw new Error("Failed to fetch");
      return response.json();
    },
    enabled: parseInt(productId) > 0 && parseInt(locationId) > 0,
  });

  if (isLoading) {
    return (
      <div className="container mx-auto p-3 sm:p-6 space-y-6">
        <Skeleton className="h-8 w-64" data-testid="skeleton-title" />
        <Skeleton className="h-[400px] w-full" data-testid="skeleton-table" />
      </div>
    );
  }

  const monthlyData = data?.monthlyData || [];
  const grandTotal = data?.grandTotal;
  const product = data?.product;

  const formatNumber = (num: number) => {
    if (num % 1 === 0) return num.toLocaleString();
    return num.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  };

  const chartData = monthlyData.map((m) => ({
    month: m.monthName.slice(0, 3),
    "In Stock": m.balesIn,
    Out: m.balesOut,
  }));

  return (
    <div className="container mx-auto p-3 sm:p-6 space-y-4 sm:space-y-6">
      <div className="flex items-center gap-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(backPath)} data-testid="button-back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <PageHeader
          title={product?.name || "Bale Product History"}
          subtitle={`${product?.articleCode || ""} · ${year}`}
        >
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            onClick={() => navigate(`/factory/bale-product-history/${productId}/${locationId}/${year}/all`)}
            data-testid="button-show-all-months"
          >
            Show All Months
          </Button>
        </PageHeader>
      </div>

      {grandTotal && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-sm text-muted-foreground">Total Bales</div>
              <div className="text-2xl font-bold" data-testid="text-total-bales">
                {grandTotal.baleCount}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-sm text-muted-foreground">Total Weight</div>
              <div className="text-2xl font-bold">{formatNumber(grandTotal.totalWeight)} kg</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-sm text-muted-foreground">In Stock</div>
              <div className="text-2xl font-bold text-emerald-600">{grandTotal.balesIn}</div>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-4 pb-4">
              <div className="text-sm text-muted-foreground">Out</div>
              <div className="text-2xl font-bold text-amber-600">{grandTotal.balesOut}</div>
            </CardContent>
          </Card>
        </div>
      )}

      {chartData.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Monthly Movement</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="month" />
                <YAxis />
                <Tooltip />
                <Legend />
                <Bar dataKey="In Stock" fill="#10b981" />
                <Bar dataKey="Out" fill="#f59e0b" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="pt-4">
          <Table mobileLayout="cards">
            <TableHeader>
              <TableRow>
                <TableHead>Month</TableHead>
                <TableHead className="text-right">Bales In</TableHead>
                <TableHead className="text-right">Bales Out</TableHead>
                <TableHead className="text-right">Weight (KG)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {monthlyData.map((m) => (
                <TableRow
                  key={m.month}
                  className="cursor-pointer hover:bg-muted/50"
                  onClick={() =>
                    navigate(`/factory/bale-product-history/${productId}/${locationId}/${year}/${m.month}`)
                  }
                  data-testid={`row-month-${m.month}`}
                >
                  <TableCell>{m.monthName}</TableCell>
                  <TableCell className="text-right font-mono">{m.balesIn}</TableCell>
                  <TableCell className="text-right font-mono">{m.balesOut}</TableCell>
                  <TableCell className="text-right font-mono">{formatNumber(m.totalWeight)}</TableCell>
                </TableRow>
              ))}
              {grandTotal && (
                <TableRow className="font-bold border-t-2" data-testid="row-grand-total">
                  <TableCell>Grand Total</TableCell>
                  <TableCell className="text-right font-mono" data-testid="text-total-bales-in">
                    {grandTotal.balesIn}
                  </TableCell>
                  <TableCell className="text-right font-mono">{grandTotal.balesOut}</TableCell>
                  <TableCell className="text-right font-mono">{formatNumber(grandTotal.totalWeight)}</TableCell>
                </TableRow>
              )}
              {monthlyData.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                    No data for {year}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

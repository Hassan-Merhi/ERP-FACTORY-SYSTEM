import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";

interface SupplierScore {
  supplierName: string;
  totalKg: number;
  wasteKg: number;
  wastePercent: number;
  avgCostPerKg: number;
  outputBales: number;
  score: number;
}

function getDefaultDateRange() {
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - 90);
  return {
    from: from.toLocaleDateString("en-CA"),
    to: to.toLocaleDateString("en-CA"),
  };
}

function getScoreVariant(score: number): "default" | "secondary" | "destructive" | "outline" {
  if (score >= 70) return "default";
  if (score >= 40) return "secondary";
  return "destructive";
}

function getScoreClass(score: number): string {
  if (score >= 70) return "bg-green-600 text-white";
  if (score >= 40) return "bg-yellow-500 text-white";
  return "";
}

export default function FactorySupplierScoreboard() {
  const defaults = getDefaultDateRange();
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);

  const query = useQuery<SupplierScore[]>({
    queryKey: ["/api/factory/suppliers/score", from, to],
    queryFn: async () => {
      const res = await fetch(`/api/factory/suppliers/score?from=${from}&to=${to}`, { credentials: "include" });
      if (!res.ok) throw new Error("Failed to load supplier scores");
      return res.json();
    },
  });

  const data = query.data ?? [];
  const totalSuppliers = data.length;
  const avgScore = totalSuppliers > 0 ? data.reduce((sum, s) => sum + s.score, 0) / totalSuppliers : 0;
  const bestSupplier = totalSuppliers > 0 ? data.reduce((best, s) => (s.score > best.score ? s : best), data[0]) : null;
  const worstSupplier =
    totalSuppliers > 0 ? data.reduce((worst, s) => (s.score < worst.score ? s : worst), data[0]) : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <PageHeader title="Supplier Scoreboard" subtitle="Supplier performance ranking and scoring" />
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">From</Label>
            <Input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="w-44"
              data-testid="input-date-from"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">To</Label>
            <Input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="w-44"
              data-testid="input-date-to"
            />
          </div>
        </div>
      </div>

      <div className="grid gap-4 grid-cols-2 lg:grid-cols-4">
        <Card data-testid="card-total-suppliers">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Suppliers</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-total-suppliers">
              {totalSuppliers}
            </div>
          </CardContent>
        </Card>
        <Card data-testid="card-avg-score">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Avg Score</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold" data-testid="text-avg-score">
              {avgScore.toFixed(1)}
            </div>
          </CardContent>
        </Card>
        <Card data-testid="card-best-supplier">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Best Supplier</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold truncate" data-testid="text-best-supplier">
              {bestSupplier ? bestSupplier.supplierName : "—"}
            </div>
            {bestSupplier && (
              <p className="text-xs text-muted-foreground" data-testid="text-best-score">
                Score: {bestSupplier.score.toFixed(1)}
              </p>
            )}
          </CardContent>
        </Card>
        <Card data-testid="card-worst-supplier">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Worst Supplier</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold truncate" data-testid="text-worst-supplier">
              {worstSupplier ? worstSupplier.supplierName : "—"}
            </div>
            {worstSupplier && (
              <p className="text-xs text-muted-foreground" data-testid="text-worst-score">
                Score: {worstSupplier.score.toFixed(1)}
              </p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Supplier Rankings</CardTitle>
        </CardHeader>
        <CardContent>
          {query.isLoading ? (
            <div className="flex items-center justify-center py-12" data-testid="loading-spinner">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              <span className="ml-2 text-muted-foreground">Loading supplier scores...</span>
            </div>
          ) : !Array.isArray(data) || data.length === 0 ? (
            <div className="text-center py-8">
              <p className="text-muted-foreground" data-testid="text-no-data">
                No supplier data for selected range
              </p>
            </div>
          ) : (
            <div className="table-responsive">
              <Table mobileLayout="cards">
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Rank</TableHead>
                    <TableHead>Supplier Name</TableHead>
                    <TableHead>Total KG</TableHead>
                    <TableHead>Waste KG</TableHead>
                    <TableHead>Waste %</TableHead>
                    <TableHead>Avg Cost/KG</TableHead>
                    <TableHead>Output Bales</TableHead>
                    <TableHead>Score</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.map((supplier, idx) => (
                    <TableRow key={supplier.supplierName ?? idx} data-testid={`row-supplier-${idx}`}>
                      <TableCell>
                        <Badge variant="outline" data-testid={`text-rank-${idx}`}>
                          {idx + 1}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium" data-testid={`text-supplier-name-${idx}`}>
                        {supplier.supplierName}
                      </TableCell>
                      <TableCell className="font-mono" data-testid={`text-total-kg-${idx}`}>
                        {supplier.totalKg.toFixed(1)}
                      </TableCell>
                      <TableCell className="font-mono" data-testid={`text-waste-kg-${idx}`}>
                        {supplier.wasteKg.toFixed(1)}
                      </TableCell>
                      <TableCell className="font-mono" data-testid={`text-waste-percent-${idx}`}>
                        {supplier.wastePercent.toFixed(1)}%
                      </TableCell>
                      <TableCell className="font-mono" data-testid={`text-avg-cost-${idx}`}>
                        $
                        {(supplier.avgCostPerKg ?? 0).toLocaleString(undefined, {
                          minimumFractionDigits: 0,
                          maximumFractionDigits: 2,
                        })}
                      </TableCell>
                      <TableCell className="font-mono" data-testid={`text-output-bales-${idx}`}>
                        {supplier.outputBales}
                      </TableCell>
                      <TableCell data-testid={`text-score-${idx}`}>
                        <Badge variant={getScoreVariant(supplier.score)} className={getScoreClass(supplier.score)}>
                          {supplier.score.toFixed(1)}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

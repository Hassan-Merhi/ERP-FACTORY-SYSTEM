import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FileSpreadsheet, ChevronRight, Package, Weight, AlertCircle, User, Calendar } from "lucide-react";

type ImportBatch = {
  id: number;
  companyId: number;
  fileName: string;
  baleCount: number;
  errorCount: number;
  totalWeightKg: string;
  importedByUserId: string | null;
  importedByName: string | null;
  notes: string | null;
  createdAt: string;
};

type FactoryBale = {
  id: number;
  baleCode: string;
  referenceNumber: string;
  articleCode: string | null;
  productName: string | null;
  category: string | null;
  grade: string | null;
  weightKg: string;
  costPerKg: string;
  totalCost: string;
  status: string;
  createdAt: string;
};

const STATUS_COLORS: Record<string, string> = {
  IN_STOCK: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  SOLD: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  REMOVED: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  FINALIZED: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  PENDING_PRESSING: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
};

function fmt(n: number | null | undefined) {
  if (n == null || isNaN(n)) return "0";
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function formatDate(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function FactoryBaleImportHistory() {
  const [selectedBatch, setSelectedBatch] = useState<ImportBatch | null>(null);

  const { data: batches = [], isLoading } = useQuery<ImportBatch[]>({
    queryKey: ["/api/factory/bale-import-batches"],
  });

  const { data: batchBales = [], isLoading: balesLoading } = useQuery<FactoryBale[]>({
    queryKey: ["/api/factory/bale-import-batches", selectedBatch?.id, "bales"],
    queryFn: async () => {
      if (!selectedBatch) return [];
      const r = await fetch(`/api/factory/bale-import-batches/${selectedBatch.id}/bales`);
      if (!r.ok) throw new Error("Failed to load bales");
      return r.json();
    },
    enabled: !!selectedBatch,
  });

  const totalBalesEver = batches.reduce((s, b) => s + b.baleCount, 0);
  const totalWeightEver = batches.reduce((s, b) => s + parseFloat(b.totalWeightKg || "0"), 0);

  return (
    <div className="p-4 space-y-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground mb-1">Total Imports</p>
            <p className="text-2xl font-semibold" data-testid="stat-import-count">
              {batches.length}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground mb-1">Total Bales Imported</p>
            <p className="text-2xl font-semibold" data-testid="stat-total-bales">
              {fmt(totalBalesEver)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 pb-3">
            <p className="text-xs text-muted-foreground mb-1">Total Weight Imported</p>
            <p className="text-2xl font-semibold" data-testid="stat-total-weight">
              {fmt(totalWeightEver)} <span className="text-sm font-normal text-muted-foreground">kg</span>
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Import batches list */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4" />
            Import History
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground text-sm">Loading...</div>
          ) : batches.length === 0 ? (
            <div className="p-8 text-center text-muted-foreground text-sm space-y-2">
              <FileSpreadsheet className="h-8 w-8 mx-auto opacity-30" />
              <p>No Excel imports found yet.</p>
              <p className="text-xs">Future imports done from the Bales tab will appear here.</p>
            </div>
          ) : (
            <div className="divide-y">
              {batches.map((batch) => (
                <div
                  key={batch.id}
                  className="px-4 py-3 flex items-center gap-3 hover-elevate cursor-pointer"
                  onClick={() => setSelectedBatch(batch)}
                  data-testid={`row-import-batch-${batch.id}`}
                >
                  <div className="p-2 rounded-md bg-muted">
                    <FileSpreadsheet className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{batch.fileName}</p>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 mt-0.5">
                      <span className="text-xs text-muted-foreground flex items-center gap-1">
                        <Calendar className="h-3 w-3" />
                        {formatDate(batch.createdAt)}
                      </span>
                      {batch.importedByName && (
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <User className="h-3 w-3" />
                          {batch.importedByName}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3 shrink-0">
                    <div className="text-right hidden sm:block">
                      <p className="text-sm font-medium flex items-center gap-1 justify-end">
                        <Package className="h-3.5 w-3.5 text-muted-foreground" />
                        {batch.baleCount.toLocaleString()} bales
                      </p>
                      <p className="text-xs text-muted-foreground flex items-center gap-1 justify-end">
                        <Weight className="h-3 w-3" />
                        {fmt(parseFloat(batch.totalWeightKg || "0"))} kg
                      </p>
                    </div>
                    {batch.errorCount > 0 && (
                      <Badge variant="destructive" className="text-xs">
                        <AlertCircle className="h-3 w-3 mr-1" />
                        {batch.errorCount} err
                      </Badge>
                    )}
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Detail dialog */}
      <Dialog open={!!selectedBatch} onOpenChange={(o) => !o && setSelectedBatch(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <FileSpreadsheet className="h-4 w-4" />
              {selectedBatch?.fileName}
            </DialogTitle>
            {selectedBatch && (
              <div className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
                <span>{formatDate(selectedBatch.createdAt)}</span>
                {selectedBatch.importedByName && <span>By: {selectedBatch.importedByName}</span>}
                <span>
                  {selectedBatch.baleCount.toLocaleString()} bales &bull;{" "}
                  {fmt(parseFloat(selectedBatch.totalWeightKg || "0"))} kg total
                </span>
                {selectedBatch.errorCount > 0 && (
                  <span className="text-destructive">{selectedBatch.errorCount} row errors</span>
                )}
              </div>
            )}
          </DialogHeader>

          <div className="flex-1 overflow-auto min-h-0 rounded-md border">
            {balesLoading ? (
              <div className="p-8 text-center text-muted-foreground text-sm">Loading bales...</div>
            ) : batchBales.length === 0 ? (
              <div className="p-8 text-center text-muted-foreground text-sm">No bales found for this batch.</div>
            ) : (
              <Table>
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Ref #</TableHead>
                    <TableHead>Bale Code</TableHead>
                    <TableHead>Article</TableHead>
                    <TableHead>Product</TableHead>
                    <TableHead>Grade</TableHead>
                    <TableHead className="text-right">Weight (kg)</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {batchBales.map((bale) => (
                    <TableRow key={bale.id} data-testid={`row-bale-${bale.id}`}>
                      <TableCell className="font-mono text-xs">{bale.referenceNumber}</TableCell>
                      <TableCell className="font-mono text-xs">{bale.baleCode}</TableCell>
                      <TableCell className="text-sm">
                        {bale.articleCode || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-sm max-w-[160px] truncate">
                        {bale.productName || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-sm">
                        {bale.grade || <span className="text-muted-foreground">—</span>}
                      </TableCell>
                      <TableCell className="text-right text-sm">{fmt(parseFloat(bale.weightKg))}</TableCell>
                      <TableCell>
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded-sm text-xs font-medium ${STATUS_COLORS[bale.status] || "bg-muted text-muted-foreground"}`}
                        >
                          {bale.status.replace(/_/g, " ")}
                        </span>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

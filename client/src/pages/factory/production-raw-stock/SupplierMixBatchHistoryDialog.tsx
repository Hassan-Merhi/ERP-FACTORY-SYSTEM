import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { History, PackagePlus, MinusCircle, Layers, Container } from "lucide-react";
import { formatNumber } from "@/lib/formatNumber";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

interface SupplierMixBatchHistoryDialogProps {
  supplierId: number | null;
  supplierName: string;
  open: boolean;
  onClose: () => void;
}

interface RawStockHistoryRow {
  kind: "adjustment" | "batch" | "receipt";
  date: string;
  createdAt: string;
  type: string; // ADD | REMOVE | DEDUCT | USED | RECEIPT
  kg: number;
  usedKg?: number;
  costPerKg: number;
  currencyCode: string;
  notes?: string | null;
  reference?: string | null;
  label: string;
  ref: string;
  batchStatus?: string | null;
  batchId?: number | null;
  adjId?: number | null;
  rawStockId?: number | null;
}

function getKindMeta(row: RawStockHistoryRow) {
  if (row.kind === "receipt") {
    return {
      icon: Container,
      badgeClass:
        "bg-blue-50 dark:bg-blue-900/20 text-blue-700 dark:text-blue-400 border-blue-200 dark:border-blue-800",
      label: "Offload / Receipt",
      sign: "+" as const,
    };
  }
  if (row.kind === "batch") {
    return {
      icon: Layers,
      badgeClass:
        "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
      label: row.batchStatus || "Mix Batch",
      sign: "-" as const,
    };
  }
  if (row.type === "ADD") {
    return {
      icon: PackagePlus,
      badgeClass:
        "bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800",
      label: "Addition",
      sign: "+" as const,
    };
  }
  return {
    icon: MinusCircle,
    badgeClass: "bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800",
    label: row.type === "DEDUCT" ? "Deduct from Received" : "Deduction",
    sign: "-" as const,
  };
}

export function SupplierMixBatchHistoryDialog({
  supplierId,
  supplierName,
  open,
  onClose,
}: SupplierMixBatchHistoryDialogProps) {
  const { data: history = [], isLoading } = useQuery<RawStockHistoryRow[]>({
    queryKey: [`/api/factory/raw-stock/history/${supplierId}`],
    enabled: open && supplierId !== null,
  });

  const totalIn = history.filter((r) => r.kind === "receipt" || r.type === "ADD").reduce((s, r) => s + (r.kg || 0), 0);
  // Note: DEDUCT adjustments reduce receivedKg directly on the container/receipt record
  // (history-only entry, not a separate movement against the balance) — see
  // rawStockReceiptRoutes.ts's DEDUCT-skip logic. Counting it here too would double-subtract
  // against the already-reduced receipt kg, so only REMOVE and batch usage count as "Out".
  const totalOut = history
    .filter((r) => r.kind === "batch" || r.type === "REMOVE")
    .reduce((s, r) => s + (r.kg || 0), 0);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <History className="h-4 w-4 text-primary" />
            Raw Material History — {supplierName}
          </DialogTitle>
        </DialogHeader>

        <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
          <span>
            <span className="font-medium text-foreground">{history.length}</span> total entries
          </span>
          <span className="text-border">|</span>
          <span className="text-emerald-600 dark:text-emerald-400">
            In (received/added): <span className="font-medium">{formatNumber(totalIn)} kg</span>
          </span>
          <span className="text-border">|</span>
          <span className="text-red-600 dark:text-red-400">
            Out (used/deducted): <span className="font-medium">{formatNumber(totalOut)} kg</span>
          </span>
        </div>

        <div className="flex-1 overflow-y-auto border rounded-md">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : history.length === 0 ? (
            <div className="h-32 flex items-center justify-center text-muted-foreground text-sm">
              No raw material history found for this supplier.
            </div>
          ) : (
            <Table>
              <TableHeader className="bg-muted sticky top-0">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="py-3">Entry</TableHead>
                  <TableHead className="py-3">Date</TableHead>
                  <TableHead className="text-right py-3">Weight (kg)</TableHead>
                  <TableHead className="text-right py-3">Cost/kg</TableHead>
                  <TableHead className="py-3">Type</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((row, idx) => {
                  const meta = getKindMeta(row);
                  const Icon = meta.icon;
                  const rowKey = `${row.kind}-${row.adjId ?? row.batchId ?? row.rawStockId ?? idx}`;
                  return (
                    <TableRow key={rowKey} data-testid={`row-raw-stock-history-${rowKey}`}>
                      <TableCell className="py-2.5">
                        <div className="flex flex-col">
                          <span className="font-medium text-sm font-mono">{row.ref}</span>
                          <span className="text-[11px] text-muted-foreground">{row.label}</span>
                          {row.notes && <span className="text-[10px] text-muted-foreground/70">{row.notes}</span>}
                        </div>
                      </TableCell>
                      <TableCell className="py-2.5 text-sm text-muted-foreground">
                        {row.date ? format(new Date(row.date), "dd MMM yyyy") : "—"}
                      </TableCell>
                      <TableCell
                        className={`text-right font-mono text-sm py-2.5 ${
                          meta.sign === "+"
                            ? "text-emerald-600 dark:text-emerald-400"
                            : "text-red-600 dark:text-red-400"
                        }`}
                      >
                        {meta.sign}
                        {formatNumber(row.kg)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm py-2.5 text-muted-foreground">
                        ${(row.costPerKg || 0).toFixed(6)}
                      </TableCell>
                      <TableCell className="py-2.5">
                        <Badge variant="outline" className={`text-[10px] gap-1 ${meta.badgeClass}`}>
                          <Icon className="h-2.5 w-2.5" />
                          {meta.label}
                        </Badge>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

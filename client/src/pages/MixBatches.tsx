import type { ClientErrorLike } from "@/lib/clientError";
import { useState, Suspense } from "react";
import { lazyRetry as lazy } from "@/lib/lazyRetry";
import * as XLSX from "@/lib/excelHelper";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Plus, Package, CheckCircle, PlayCircle, Link2, AlertTriangle, Pencil, Trash2, BarChart2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { PageHeader } from "@/components/PageHeader";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { CreateMixBatchDialog } from "../components/CreateMixBatchDialog";
import { EditMixBatchDialog } from "../components/EditMixBatchDialog";
import { formatNumber } from "@/lib/formatNumber";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import type { FactoryMixBatch } from "@shared/schema";
import { useEscapeBack } from "@/hooks/use-escape-back";

const BatchDetail = lazy(() => import("./BatchDetail"));

interface UnlinkedBale {
  id: number;
  weightKg?: string;
  baleCode?: string;
  productName?: string;
  status?: string;
}

export default function MixBatches() {
  const { formatDisplayDate } = useDateFormat();
  const { toast } = useToast();
  const [statusFilter, setStatusFilter] = useState<string>("ACTIVE");
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [selectedBatchId, setSelectedBatchId] = useState<number | null>(null);
  const [assignDialogOpen, setAssignDialogOpen] = useState(false);
  const [sourceBatchId, setSourceBatchId] = useState<string>("");
  const [selectedBaleIds, setSelectedBaleIds] = useState<Set<number>>(new Set());

  // Edit state
  const [editBatch, setEditBatch] = useState<FactoryMixBatch | null>(null);

  // Delete state
  const [deleteId, setDeleteId] = useState<number | null>(null);
  const [showAllBatches, setShowAllBatches] = useState(false);

  useEscapeBack(selectedBatchId !== null ? () => setSelectedBatchId(null) : null);
  const appMode = useAppMode();
  const modeApiRequest = getApiRequest(appMode);

  const { data: batches, isLoading } = useQuery<FactoryMixBatch[]>({
    queryKey: ["/api/factory/mix-batches"],
  });

  const deleteBatch = deleteId ? (batches?.find((b) => b.id === deleteId) ?? null) : null;

  const { data: unlinkedBales } = useQuery<UnlinkedBale[]>({
    queryKey: ["/api/factory/bales/unlinked"],
    enabled: assignDialogOpen,
  });

  const sourceBatch = sourceBatchId ? batches?.find((b) => b.id === parseInt(sourceBatchId)) : null;

  const availableKg = sourceBatch
    ? parseFloat(sourceBatch.totalWeightKg || "0") - parseFloat(sourceBatch.usedKg || "0")
    : 0;

  const selectedKg =
    unlinkedBales
      ?.filter((b) => selectedBaleIds.has(b.id))
      .reduce((sum: number, b) => sum + parseFloat(b.weightKg || "0"), 0) ?? 0;

  const overLimit = selectedKg > availableKg + 0.001;

  const assignMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("POST", `/api/factory/mix-batches/${sourceBatchId}/assign-bales`, {
        baleIds: Array.from(selectedBaleIds),
      });
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Assignment failed");
      }
      return res.json();
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales/unlinked"] });
      setAssignDialogOpen(false);
      setSourceBatchId("");
      setSelectedBaleIds(new Set());
      toast({ title: "Success", description: `${data.balesUpdated} bale(s) assigned to batch` });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async () => {
      const res = await modeApiRequest("DELETE", `/api/factory/mix-batches/${deleteId}`);
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.message || "Delete failed");
      }
      return res.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/factory/mix-batches"] });
      queryClient.invalidateQueries({ queryKey: ["/api/factory/bales/unlinked"] });
      setDeleteId(null);
      toast({ title: "Deleted", description: "Batch deleted. Bales have been unlinked and are preserved." });
    },
    onError: (err: ClientErrorLike) => {
      if (err?._handledGlobally) return;
      toast({ title: "Error", description: err.message, variant: "destructive" });
    },
  });

  const filteredBatches = batches?.filter((batch) => {
    if (statusFilter === "all") return true;
    return batch.status === statusFilter;
  });

  const activeBatchesWithStock =
    batches?.filter((b) => {
      const remaining = parseFloat(b.totalWeightKg || "0") - parseFloat(b.usedKg || "0");
      return remaining > 0.001;
    }) ?? [];

  const _getStatusIcon = (status: string) => {
    switch (status) {
      case "ACTIVE":
        return <PlayCircle className="h-4 w-4" />;
      case "COMPLETED":
        return <CheckCircle className="h-4 w-4" />;
      default:
        return <Package className="h-4 w-4" />;
    }
  };

  const _getStatusVariant = (status: string) => {
    switch (status) {
      case "ACTIVE":
        return "default";
      case "COMPLETED":
        return "secondary";
      default:
        return "outline";
    }
  };

  const handleExportReport = async () => {
    if (!batches || batches.length === 0) {
      toast({ title: "No data to export" });
      return;
    }

    // Unique batch names (columns), sorted
    const batchNames = Array.from(new Set(batches.map((b) => (b.name || b.batchCode).toUpperCase()))).sort();

    // Unique dates, sorted
    const dates = Array.from(new Set(batches.filter((b) => b.batchDate).map((b) => b.batchDate as string))).sort();

    // Build date × name → kg map
    const matrix: Record<string, Record<string, number>> = {};
    for (const b of batches) {
      if (!b.batchDate) continue;
      const name = (b.name || b.batchCode).toUpperCase();
      const kg = parseFloat(b.totalWeightKg || "0");
      if (!matrix[b.batchDate]) matrix[b.batchDate] = {};
      matrix[b.batchDate][name] = (matrix[b.batchDate][name] || 0) + kg;
    }

    // Build row data
    const totals: Record<string, number> = {};
    const rows = dates.map((date) => {
      const row: Record<string, string | number> = { DATE: date };
      for (const name of batchNames) {
        const val = matrix[date]?.[name] || 0;
        row[name] = val > 0 ? val : "";
        totals[name] = (totals[name] || 0) + val;
      }
      return row;
    });

    // Total row
    const totalRow: Record<string, string | number> = { DATE: "TOTAL" };
    for (const name of batchNames) {
      totalRow[name] = totals[name] || "";
    }
    rows.push(totalRow);

    const ws = XLSX.utils.json_to_sheet(rows, { header: ["DATE", ...batchNames] });
    ws["!cols"] = [{ wch: 14 }, ...batchNames.map(() => ({ wch: 14 }))];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Mix Batches");
    await XLSX.writeFile(wb, `mix-batches-${new Date().toLocaleDateString("en-CA")}.xlsx`);
  };

  if (selectedBatchId !== null) {
    return (
      <Suspense
        fallback={
          <div className="space-y-2">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-96 w-full" />
          </div>
        }
      >
        <BatchDetail
          batchId={selectedBatchId}
          onBack={() => setSelectedBatchId(null)}
          onDeleted={() => setSelectedBatchId(null)}
        />
      </Suspense>
    );
  }

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <PageHeader
            title="Mix Batches"
            subtitle="Combine raw stock containers and existing batches for bale production"
          />
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={handleExportReport} data-testid="button-report">
            <BarChart2 className="h-4 w-4 mr-2" />
            Report
          </Button>
          <Button
            variant="outline"
            onClick={() => {
              setSourceBatchId("");
              setSelectedBaleIds(new Set());
              setAssignDialogOpen(true);
            }}
            data-testid="button-assign-to-bales"
          >
            <Link2 className="h-4 w-4 mr-2" />
            Assign to Bales
          </Button>
          <Button onClick={() => setCreateDialogOpen(true)} data-testid="button-create-mix-batch">
            <Plus className="h-4 w-4 mr-2" />
            Create Batch
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <CardTitle>Batch List</CardTitle>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-48" data-testid="select-status-filter">
                <SelectValue placeholder="Filter by status" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ACTIVE">Active</SelectItem>
                <SelectItem value="CLOSED">Closed</SelectItem>
                <SelectItem value="COMPLETED">Completed</SelectItem>
                <SelectItem value="all">All Batches</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
              <Skeleton className="h-12 w-full" />
            </div>
          ) : filteredBatches && filteredBatches.length > 0 ? (
            <div>
              <Table wrapperClassName="overflow-visible">
                <TableHeader className="sticky top-0 z-30 bg-background">
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Total (kg)</TableHead>
                    <TableHead className="text-right">Cost/kg</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="w-20"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(() => {
                    const sorted = [...filteredBatches].sort((a, b) => {
                      const da = a.batchDate || a.createdAt || "";
                      const db = b.batchDate || b.createdAt || "";
                      return db > da ? 1 : db < da ? -1 : b.id - a.id;
                    });
                    return showAllBatches ? sorted : sorted.slice(0, 15);
                  })().map((batch) => {
                    const total = parseFloat(batch.totalWeightKg || "0");
                    return (
                      <TableRow
                        key={batch.id}
                        className="hover-elevate cursor-pointer"
                        onClick={() => setSelectedBatchId(batch.id)}
                        data-testid={`row-batch-${batch.id}`}
                      >
                        <TableCell className="font-medium" data-testid={`text-batch-name-${batch.id}`}>
                          {batch.name || batch.batchCode}
                        </TableCell>
                        <TableCell className="text-right font-mono">{formatNumber(total)}</TableCell>
                        <TableCell className="text-right font-mono">
                          ${parseFloat(batch.costPerKg).toFixed(4)}
                        </TableCell>
                        <TableCell className="text-muted-foreground text-sm">
                          {formatDisplayDate(batch.batchDate || batch.createdAt)}
                        </TableCell>
                        <TableCell onClick={(e) => e.stopPropagation()}>
                          <div className="flex items-center gap-1">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setEditBatch(batch)}
                              data-testid={`button-edit-batch-${batch.id}`}
                            >
                              <Pencil className="h-4 w-4" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setDeleteId(batch.id)}
                              data-testid={`button-delete-batch-${batch.id}`}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                {(() => {
                  const summaryTotal = filteredBatches.reduce((s, b) => s + parseFloat(b.totalWeightKg || "0"), 0);
                  const weightedCost = filteredBatches.reduce(
                    (s, b) => s + parseFloat(b.totalWeightKg || "0") * parseFloat(b.costPerKg || "0"),
                    0
                  );
                  const blendedCost = summaryTotal > 0 ? weightedCost / summaryTotal : 0;
                  return (
                    <tfoot className="border-t-2 border-border bg-muted/40">
                      <tr>
                        <td className="px-4 py-3 text-sm font-semibold text-foreground">
                          Combined Total
                          <div className="text-xs text-muted-foreground font-normal">
                            {filteredBatches.length} batch{filteredBatches.length !== 1 ? "es" : ""}
                          </div>
                        </td>
                        <td
                          className="px-4 py-3 text-right font-mono font-semibold text-sm"
                          data-testid="text-summary-total-kg"
                        >
                          {formatNumber(summaryTotal)}
                        </td>
                        <td
                          className="px-4 py-3 text-right font-mono font-semibold text-sm"
                          data-testid="text-summary-blended-cost"
                        >
                          ${blendedCost.toFixed(4)}
                          <span className="text-xs text-muted-foreground font-normal">/kg</span>
                        </td>
                        <td colSpan={2} />
                      </tr>
                    </tfoot>
                  );
                })()}
              </Table>
              {filteredBatches.length > 15 && (
                <div className="flex justify-center py-3 border-t">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAllBatches((v) => !v)}
                    data-testid="button-toggle-show-all-batches"
                  >
                    {showAllBatches ? `Show less` : `Show all ${filteredBatches.length} batches`}
                  </Button>
                </div>
              )}
            </div>
          ) : (
            <div className="text-center py-12">
              <Package className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
              <h3 className="text-lg font-medium mb-2">No batches found</h3>
              <p className="text-muted-foreground mb-4">
                {statusFilter === "all" || statusFilter === "ACTIVE"
                  ? "Create your first mix batch to get started"
                  : `No batches with status: ${statusFilter}`}
              </p>
              {(statusFilter === "all" || statusFilter === "ACTIVE") && (
                <Button onClick={() => setCreateDialogOpen(true)}>
                  <Plus className="h-4 w-4 mr-2" />
                  Create First Batch
                </Button>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <CreateMixBatchDialog open={createDialogOpen} onOpenChange={setCreateDialogOpen} />

      <EditMixBatchDialog
        batch={editBatch}
        open={!!editBatch}
        onOpenChange={(open) => {
          if (!open) setEditBatch(null);
        }}
      />

      {/* Delete Confirmation Dialog */}
      <Dialog
        open={deleteId !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteId(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Batch</DialogTitle>
            <DialogDescription>
              This will permanently delete the batch and unlink any bales associated with it. The bales themselves are
              not deleted — they will simply become unlinked and available to reassign.
            </DialogDescription>
          </DialogHeader>
          {deleteBatch && (
            <div className="p-3 rounded-md bg-muted text-sm space-y-1">
              <p>
                <span className="text-muted-foreground">Batch:</span>{" "}
                <span className="font-medium">{deleteBatch.name || deleteBatch.batchCode}</span>
              </p>
              <p>
                <span className="text-muted-foreground">Total weight:</span>{" "}
                <span className="font-mono">{formatNumber(parseFloat(deleteBatch.totalWeightKg || "0"))} kg</span>
              </p>
              <p>
                <span className="text-muted-foreground">Status:</span>{" "}
                <span className="font-medium">{deleteBatch.status}</span>
              </p>
            </div>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteId(null)} data-testid="button-cancel-delete">
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => deleteMutation.mutate()}
              disabled={deleteMutation.isPending}
              data-testid="button-confirm-delete"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Batch"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Assign to Bales Dialog */}
      <Dialog
        open={assignDialogOpen}
        onOpenChange={(open) => {
          setAssignDialogOpen(open);
          if (!open) {
            setSourceBatchId("");
            setSelectedBaleIds(new Set());
          }
        }}
      >
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Assign Raw Stock to Bales</DialogTitle>
            <DialogDescription>
              Choose which batch is the raw stock source, then select the bales to assign it to.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1">
              <p className="text-sm font-medium">Step 1 — Select raw stock (batch)</p>
              {activeBatchesWithStock.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No batches with remaining stock found. Create a batch first.
                </p>
              ) : (
                <Select
                  value={sourceBatchId}
                  onValueChange={(v) => {
                    setSourceBatchId(v);
                    setSelectedBaleIds(new Set());
                  }}
                >
                  <SelectTrigger data-testid="select-source-batch">
                    <SelectValue placeholder="Pick a batch…" />
                  </SelectTrigger>
                  <SelectContent>
                    {activeBatchesWithStock.map((b) => {
                      const rem = parseFloat(b.totalWeightKg || "0") - parseFloat(b.usedKg || "0");
                      return (
                        <SelectItem key={b.id} value={String(b.id)}>
                          {b.name || b.batchCode} — {formatNumber(rem)} kg left
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              )}
              {sourceBatch && (
                <p className="text-xs text-muted-foreground">
                  Available:{" "}
                  <span className="font-mono font-medium text-foreground">{formatNumber(availableKg)} kg</span>
                  {" · "}Cost/kg:{" "}
                  <span className="font-mono font-medium text-foreground">
                    ${parseFloat(sourceBatch.costPerKg || "0").toFixed(4)}
                  </span>
                </p>
              )}
            </div>

            {sourceBatchId && (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Step 2 — Select bales to assign</p>
                  {unlinkedBales && unlinkedBales.length > 0 && (
                    <span className="text-xs text-muted-foreground flex items-center gap-2">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1 text-xs"
                        onClick={() => setSelectedBaleIds(new Set(unlinkedBales.map((b) => b.id)))}
                      >
                        All
                      </Button>
                      /
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-6 px-1 text-xs"
                        onClick={() => setSelectedBaleIds(new Set())}
                      >
                        None
                      </Button>
                    </span>
                  )}
                </div>

                {selectedBaleIds.size > 0 && (
                  <p className={`text-xs ${overLimit ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                    {selectedBaleIds.size} bales · {formatNumber(selectedKg)} kg selected (
                    {formatNumber(availableKg - selectedKg)} kg remaining after)
                  </p>
                )}

                <div className="max-h-64 overflow-y-auto border rounded-md">
                  {!unlinkedBales ? (
                    <div className="p-4 space-y-2">
                      <Skeleton className="h-8 w-full" />
                      <Skeleton className="h-8 w-full" />
                    </div>
                  ) : unlinkedBales.length === 0 ? (
                    <div className="p-8 text-center text-muted-foreground text-sm">
                      No unlinked bales found — all pressed bales already have a raw stock source.
                    </div>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead className="w-10"></TableHead>
                          <TableHead>Bale Code</TableHead>
                          <TableHead>Product</TableHead>
                          <TableHead className="text-right">Weight (kg)</TableHead>
                          <TableHead>Status</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {unlinkedBales.map((bale) => (
                          <TableRow
                            key={bale.id}
                            className="cursor-pointer"
                            onClick={() =>
                              setSelectedBaleIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(bale.id)) next.delete(bale.id);
                                else next.add(bale.id);
                                return next;
                              })
                            }
                            data-testid={`row-unlinked-bale-${bale.id}`}
                          >
                            <TableCell>
                              <input
                                type="checkbox"
                                checked={selectedBaleIds.has(bale.id)}
                                readOnly
                                className="cursor-pointer"
                              />
                            </TableCell>
                            <TableCell className="font-mono text-sm">{bale.baleCode}</TableCell>
                            <TableCell className="text-sm">{bale.productName || "—"}</TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {formatNumber(parseFloat(bale.weightKg || "0"))}
                            </TableCell>
                            <TableCell>
                              <Badge variant="outline" className="text-xs">
                                {bale.status}
                              </Badge>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </div>

                {overLimit && (
                  <div className="flex items-center gap-2 text-destructive text-sm">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    Selected bales ({formatNumber(selectedKg)} kg) exceed available stock ({formatNumber(availableKg)}{" "}
                    kg)
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <Button variant="outline" onClick={() => setAssignDialogOpen(false)} data-testid="button-cancel-assign">
                Cancel
              </Button>
              <Button
                disabled={!sourceBatchId || selectedBaleIds.size === 0 || overLimit || assignMutation.isPending}
                data-testid="button-confirm-assign"
                onClick={() => assignMutation.mutate()}
              >
                {assignMutation.isPending
                  ? "Assigning…"
                  : `Assign ${selectedBaleIds.size > 0 ? selectedBaleIds.size : ""} Bale${selectedBaleIds.size !== 1 ? "s" : ""}`}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}

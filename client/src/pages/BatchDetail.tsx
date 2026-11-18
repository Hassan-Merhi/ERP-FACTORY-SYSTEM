import { ArrowLeft, Package, Boxes, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatusBadge } from "@/components/StatusBadge";
import { EmptyState } from "@/components/ui/page-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/formatNumber";
import { recordedMixBatchCost } from "@/lib/recordedMixBatchCost";
import {
  BatchDetailCardSources,
  costPerKgText,
  useBatchDetailState,
  type BatchDetailProps,
} from "./useBatchDetailState";

export default function BatchDetail(props: BatchDetailProps) {
  const {
    balesData,
    batch,
    deleteMutation,
    deleteOpen,
    editMutation,
    editName,
    editNotes,
    editOpen,
    formatDisplayDate,
    isLoading,
    onBack,
    setDeleteOpen,
    setEditName,
    setEditNotes,
    setEditOpen,
    sources,
  } = useBatchDetailState(props);

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-9 w-32" />
        <Skeleton className="h-48 w-full" />
        <Skeleton className="h-64 w-full" />
        <Skeleton className="h-96 w-full" />
      </div>
    );
  }

  if (!batch) {
    return (
      <div className="space-y-4">
        <Button variant="ghost" onClick={onBack} data-testid="button-back">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <div className="text-center py-12 text-muted-foreground">
          <Package className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Batch not found</p>
        </div>
      </div>
    );
  }

  const totalWeight = parseFloat(batch.totalWeightKg || "0");
  const usedWeight = parseFloat(batch.usedKg || "0");
  const remainingWeight = totalWeight - usedWeight;
  const usagePercent = totalWeight > 0 ? Math.min((usedWeight / totalWeight) * 100, 100) : 0;
  const costPerKg = recordedMixBatchCost(batch).costPerKg;

  const bales = balesData || [];
  const totalBalesCount = bales.length;
  const totalBalesWeight = bales.reduce((sum: number, row) => sum + parseFloat(row.bale?.weightKg || "0"), 0);
  const avgCost =
    totalBalesCount > 0
      ? bales.reduce((sum: number, row) => sum + parseFloat(row.bale?.costPerKg || "0"), 0) / totalBalesCount
      : 0;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <Button variant="ghost" onClick={onBack} data-testid="button-back">
          <ArrowLeft className="h-4 w-4 mr-2" />
          Back
        </Button>
        <div className="flex items-center gap-2">
          <Button
            size="icon"
            variant="outline"
            onClick={() => {
              setEditName(batch.name || "");
              setEditNotes(batch.notes || "");
              setEditOpen(true);
            }}
            data-testid="button-edit-batch"
          >
            <Pencil className="h-4 w-4" />
          </Button>
          <Button size="icon" variant="outline" onClick={() => setDeleteOpen(true)} data-testid="button-delete-batch">
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      <Card data-testid="card-batch-info">
        <CardHeader>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <Boxes className="h-5 w-5 text-muted-foreground" />
              <CardTitle data-testid="text-batch-name">{batch.name || batch.batchCode}</CardTitle>
              <StatusBadge
                status={batch.status}
                label={batch.status}
                showIcon={false}
                data-testid="badge-batch-status"
              />
            </div>
            <span className="text-sm text-muted-foreground" data-testid="text-batch-date">
              {formatDisplayDate(batch.createdAt)}
            </span>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-muted-foreground">Total Weight</p>
              <p className="text-lg font-mono font-semibold" data-testid="text-total-weight">
                {formatNumber(totalWeight)} kg
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Used Weight</p>
              <p className="text-lg font-mono font-semibold" data-testid="text-used-weight">
                {formatNumber(usedWeight)} kg
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Remaining</p>
              <p className="text-lg font-mono font-semibold" data-testid="text-remaining-weight">
                {formatNumber(remainingWeight)} kg
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Recorded cost/kg</p>
              <p className="text-lg font-mono font-semibold" data-testid="text-cost-per-kg">
                {costPerKgText(costPerKg)}
              </p>
            </div>
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-xs text-muted-foreground">
              <span>
                Utilization: <span className="font-mono font-medium text-foreground">{formatNumber(usedWeight)}</span> /{" "}
                {formatNumber(totalWeight)} kg
              </span>
              <span>{usagePercent.toFixed(0)}%</span>
            </div>
            <Progress value={usagePercent} className="h-2" data-testid="progress-utilization" />
          </div>
        </CardContent>
      </Card>

      <BatchDetailCardSources sources={sources} />

      <Card data-testid="card-bales">
        <CardHeader>
          <div className="flex items-center gap-3 flex-wrap">
            <Package className="h-5 w-5 text-muted-foreground" />
            <CardTitle>Bales Produced</CardTitle>
            <Badge variant="secondary" data-testid="badge-bales-count">
              {totalBalesCount} bales
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          {bales.length === 0 ? (
            <EmptyState icon={Package} title="No bales produced from this batch yet" className="py-8" />
          ) : (
            <>
              <div className="border rounded-md overflow-auto">
                <Table mobileLayout="cards">
                  <TableHeader className="sticky top-0 z-30 bg-background">
                    <TableRow>
                      <TableHead>Bale Code</TableHead>
                      <TableHead>Product Name</TableHead>
                      <TableHead>Article Code</TableHead>
                      <TableHead className="text-right">Weight (kg)</TableHead>
                      <TableHead className="text-right">Cost/kg</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Location</TableHead>
                      <TableHead>Date</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bales.map((row) => {
                      const bale = row.bale;
                      const product = row.product;
                      const location = row.location;
                      return (
                        <TableRow key={bale.id} data-testid={`row-bale-${bale.id}`}>
                          <TableCell className="font-mono text-xs">{bale.baleCode}</TableCell>
                          <TableCell>{product?.name || "-"}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {product?.articleCode || bale.category || "-"}
                          </TableCell>
                          <TableCell className="text-right font-mono">
                            {formatNumber(parseFloat(bale.weightKg || "0"))}
                          </TableCell>
                          <TableCell className="text-right font-mono text-muted-foreground">
                            {costPerKgText(parseFloat(bale.costPerKg || "0"))}
                          </TableCell>
                          <TableCell>
                            <StatusBadge
                              status={bale.status}
                              label={bale.status.replace(/_/g, " ")}
                              showIcon={false}
                              data-testid={`badge-status-${bale.id}`}
                            />
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {location?.name || bale.warehouseLocation || "-"}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {bale.createdAt ? formatDisplayDate(bale.createdAt) : "-"}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>

              <div
                className="flex items-center gap-6 flex-wrap mt-4 pt-4 border-t text-sm text-muted-foreground"
                data-testid="summary-footer"
              >
                <span>
                  Total Bales: <span className="font-mono font-medium text-foreground">{totalBalesCount}</span>
                </span>
                <span>
                  Total Weight:{" "}
                  <span className="font-mono font-medium text-foreground">{formatNumber(totalBalesWeight)} kg</span>
                </span>
                <span>
                  Avg Cost/kg: <span className="font-mono font-medium text-foreground">{costPerKgText(avgCost)}</span>
                </span>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Edit Batch</DialogTitle>
            <DialogDescription>
              Update the name or notes for this batch. Sources and weights cannot be changed after creation.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Batch Name</Label>
              <Input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                placeholder={batch.batchCode}
                data-testid="input-edit-batch-name"
              />
              <p className="text-xs text-muted-foreground">Leave blank to use the auto-generated batch code.</p>
            </div>
            <div className="space-y-2">
              <Label>Notes</Label>
              <Textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                placeholder="Optional notes..."
                rows={3}
                data-testid="input-edit-batch-notes"
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setEditOpen(false)} data-testid="button-cancel-edit">
                Cancel
              </Button>
              <Button
                onClick={() => editMutation.mutate()}
                disabled={editMutation.isPending}
                data-testid="button-save-edit"
              >
                {editMutation.isPending ? "Saving..." : "Save"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteOpen} onOpenChange={setDeleteOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete Batch</DialogTitle>
            <DialogDescription>
              This will permanently delete the batch and unlink any bales associated with it. The bales themselves are
              not deleted — they will simply become unlinked and available to reassign.
            </DialogDescription>
          </DialogHeader>
          <div className="p-3 rounded-md bg-muted text-sm space-y-1">
            <p>
              <span className="text-muted-foreground">Batch:</span>{" "}
              <span className="font-medium">{batch.name || batch.batchCode}</span>
            </p>
            <p>
              <span className="text-muted-foreground">Bales linked:</span>{" "}
              <span className="font-mono">{totalBalesCount}</span>
            </p>
            <p>
              <span className="text-muted-foreground">Total weight:</span>{" "}
              <span className="font-mono">{formatNumber(totalWeight)} kg</span>
            </p>
          </div>
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setDeleteOpen(false)} data-testid="button-cancel-delete">
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
    </div>
  );
}

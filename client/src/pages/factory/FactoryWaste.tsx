import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Loader2, Plus, AlertTriangle } from "lucide-react";
import { PageHeader } from "@/components/PageHeader";
import { RowsExportMenu } from "@/components/export/RowsExportMenu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useFactoryWasteState } from "./useFactoryWasteState";
import { FactoryWasteCard } from "./FactoryWasteCard";

export default function FactoryWaste() {
  const {
    formatDisplayDate,
    recordChanges,
    canAddWaste,
    from,
    setFrom,
    to,
    setTo,
    dialogOpen,
    setDialogOpen,
    setPendingDeleteId,
    pendingDeleteId,
    formDate,
    setFormDate,
    formKg,
    setFormKg,
    formWasteType,
    setFormWasteType,
    formReason,
    setFormReason,
    formMixBatchId,
    setFormMixBatchId,
    formSupplierId,
    setFormSupplierId,
    formContainerId,
    setFormContainerId,
    wasteQuery,
    createMutation,
    deleteMutation,
  } = useFactoryWasteState();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!canAddWaste) return;
    const payload: {
      date: string;
      kgWaste: number;
      wasteType?: string;
      reason?: string;
      mixBatchId?: number;
      supplierId?: number;
      containerId?: number;
    } = {
      date: formDate,
      kgWaste: parseFloat(formKg),
    };
    if (formWasteType) payload.wasteType = formWasteType;
    if (formReason.trim()) payload.reason = formReason.trim();
    if (formMixBatchId) payload.mixBatchId = parseInt(formMixBatchId, 10);
    if (formSupplierId) payload.supplierId = parseInt(formSupplierId, 10);
    if (formContainerId) payload.containerId = parseInt(formContainerId, 10);
    createMutation.mutate(payload);
  }

  const totalWasteKg = wasteQuery.data ? wasteQuery.data.reduce((sum, entry) => sum + (entry.kgWaste || 0), 0) : 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <PageHeader title="Factory Waste" subtitle="Track and manage waste entries" />
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
          <RowsExportMenu
            title="Factory Waste"
            rows={wasteQuery.data ?? []}
            columns={[
              { header: "Date", value: (entry) => (entry.date ? formatDisplayDate(entry.date) : "—") },
              { header: "Type", value: (entry) => entry.wasteType || "—" },
              { header: "KG", value: (entry) => entry.kgWaste, type: "number" },
              { header: "Reason", value: (entry) => entry.reason || "—" },
              { header: "Mix Batch", value: (entry) => entry.mixBatchId ?? "—" },
              { header: "Supplier", value: (entry) => entry.supplierId ?? "—" },
              { header: "Container", value: (entry) => entry.containerId ?? "—" },
            ]}
            footer={["Total", null, totalWasteKg]}
            period={{ from, to }}
            resource="factory.production"
            className="self-end"
          />
        </div>
      </div>

      <div className="flex items-center justify-between flex-wrap gap-3">
        <Card className="min-w-[200px]">
          <CardHeader className="flex flex-row items-center justify-between gap-1 space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">Total Waste KG</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-bold font-mono" data-testid="text-total-waste-kg">
              {wasteQuery.isLoading ? "..." : totalWasteKg.toFixed(2)}
            </div>
            <p className="text-xs text-muted-foreground">in selected period</p>
          </CardContent>
        </Card>

        {canAddWaste && (
          <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
            <DialogTrigger asChild>
              <Button data-testid="button-add-waste">
                <Plus className="mr-2 h-4 w-4" />
                Add Waste Entry
              </Button>
            </DialogTrigger>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add Waste Entry</DialogTitle>
              </DialogHeader>
              <form onSubmit={handleSubmit} className="space-y-4" noValidate>
                <div className="space-y-2">
                  <Label htmlFor="waste-date">Date</Label>
                  <Input
                    id="waste-date"
                    type="date"
                    value={formDate}
                    onChange={(e) => setFormDate(e.target.value)}
                    data-testid="input-waste-date"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="waste-type">Waste Type</Label>
                  <Select
                    value={formWasteType || "__none__"}
                    onValueChange={(v) => setFormWasteType(v === "__none__" ? "" : v)}
                  >
                    <SelectTrigger id="waste-type" className="w-full" data-testid="select-waste-type">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__none__">— None —</SelectItem>
                      <SelectItem value="GARBAGE">Garbage</SelectItem>
                      <SelectItem value="WIPERS">Wipers</SelectItem>
                      <SelectItem value="OTHER">Other</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="waste-kg">KG Waste *</Label>
                  <Input
                    id="waste-kg"
                    type="number"
                    step="0.01"
                    required
                    value={formKg}
                    onChange={(e) => setFormKg(e.target.value)}
                    data-testid="input-waste-kg"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="waste-reason">Reason</Label>
                  <Textarea
                    id="waste-reason"
                    value={formReason}
                    onChange={(e) => setFormReason(e.target.value)}
                    data-testid="input-waste-reason"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="waste-mix-batch">Mix Batch ID (optional)</Label>
                  <Input
                    id="waste-mix-batch"
                    type="number"
                    value={formMixBatchId}
                    onChange={(e) => setFormMixBatchId(e.target.value)}
                    data-testid="input-waste-mix-batch-id"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="waste-supplier">Supplier ID (optional)</Label>
                  <Input
                    id="waste-supplier"
                    type="number"
                    value={formSupplierId}
                    onChange={(e) => setFormSupplierId(e.target.value)}
                    data-testid="input-waste-supplier-id"
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="waste-container">Container ID (optional)</Label>
                  <Input
                    id="waste-container"
                    type="number"
                    value={formContainerId}
                    onChange={(e) => setFormContainerId(e.target.value)}
                    data-testid="input-waste-container-id"
                  />
                </div>
                <Button type="submit" disabled={createMutation.isPending} data-testid="button-submit-waste">
                  {createMutation.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Save
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        )}
      </div>

      <FactoryWasteCard
        deleteMutation={deleteMutation}
        formatDisplayDate={formatDisplayDate}
        recordChanges={recordChanges}
        setPendingDeleteId={setPendingDeleteId}
        wasteQuery={wasteQuery}
      />

      {/* Delete Waste Entry Confirmation */}
      <Dialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 text-destructive">
              <AlertTriangle className="h-4 w-4" />
              Delete Waste Entry?
            </DialogTitle>
            <DialogDescription>This will permanently remove the waste record. This cannot be undone.</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setPendingDeleteId(null)} disabled={deleteMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleteMutation.isPending}
              onClick={() => {
                if (pendingDeleteId !== null) deleteMutation.mutate(pendingDeleteId);
              }}
              data-testid="button-confirm-delete-waste"
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete Entry"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

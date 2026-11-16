import { TabsList, PillTabButton } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { PageHeader } from "@/components/PageHeader";
import { Plus, Truck, Package, BarChart2 } from "lucide-react";
import { useFactoryDispatchBatchesState } from "./useFactoryDispatchBatchesState";
import { FactoryDispatchBatchesSection } from "./FactoryDispatchBatchesSection";

export default function FactoryDispatchBatches() {
  const {
    activeProformas,
    canCreateBatch,
    createMutation,
    createOpen,
    customers,
    effectiveActiveTab,
    filterCustomer,
    filterStatus,
    filtered,
    form,
    formatDisplayDate,
    isLoading,
    navigate,
    reportsLoading,
    reportsSummary,
    resetForm,
    search,
    selectedProforma,
    setActiveTab,
    setCreateOpen,
    setFilterCustomer,
    setFilterStatus,
    setForm,
    setSearch,
    showBatches,
    showReports,
  } = useFactoryDispatchBatchesState();

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Dispatch Batches" subtitle="Manage local truck dispatch batches for bale sales">
        <div className="flex items-center gap-2 flex-wrap">
          {showBatches && canCreateBatch && (
            <Button onClick={() => setCreateOpen(true)} data-testid="button-new-dispatch-batch">
              <Plus className="w-4 h-4 mr-2" />
              New Dispatch Batch
            </Button>
          )}
        </div>
      </PageHeader>

      {effectiveActiveTab && (
        <div className="erp-mobile-scroll-tabs shrink-0 px-4 pt-2 pb-1">
          <TabsList className="w-max min-w-full sm:min-w-0 sm:w-fit" aria-label="Dispatch batches sections">
            {showBatches && (
              <PillTabButton
                selected={effectiveActiveTab === "list"}
                onClick={() => setActiveTab("list")}
                data-testid="button-tab-list"
              >
                <Truck className="h-4 w-4 shrink-0" />
                Batches
              </PillTabButton>
            )}
            {showReports && (
              <PillTabButton
                selected={effectiveActiveTab === "reports"}
                onClick={() => setActiveTab("reports")}
                data-testid="button-tab-reports"
              >
                <BarChart2 className="h-4 w-4 shrink-0" />
                Reports
              </PillTabButton>
            )}
          </TabsList>
        </div>
      )}

      <FactoryDispatchBatchesSection
        canCreateBatch={canCreateBatch}
        customers={customers}
        effectiveActiveTab={effectiveActiveTab}
        filterCustomer={filterCustomer}
        filterStatus={filterStatus}
        filtered={filtered}
        formatDisplayDate={formatDisplayDate}
        isLoading={isLoading}
        navigate={navigate}
        reportsLoading={reportsLoading}
        reportsSummary={reportsSummary}
        search={search}
        setActiveTab={setActiveTab}
        setCreateOpen={setCreateOpen}
        setFilterCustomer={setFilterCustomer}
        setFilterStatus={setFilterStatus}
        setSearch={setSearch}
        showBatches={showBatches}
        showReports={showReports}
      />

      <Dialog
        open={canCreateBatch && createOpen}
        onOpenChange={(o) => {
          if (!o) resetForm();
          setCreateOpen(o);
        }}
      >
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>New Dispatch Batch</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-3">
              <div className="col-span-2 space-y-1.5">
                <Label>
                  Customer <span className="text-destructive">*</span>
                </Label>
                <Select
                  value={form.customerId}
                  onValueChange={(v) => setForm((f) => ({ ...f, customerId: v, proformaId: "_none" }))}
                >
                  <SelectTrigger data-testid="select-create-customer">
                    <SelectValue placeholder="Select customer..." />
                  </SelectTrigger>
                  <SelectContent>
                    {customers.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.legalName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {form.customerId && (
                <div className="col-span-2 space-y-1.5">
                  <Label>Proforma (optional)</Label>
                  <Select value={form.proformaId} onValueChange={(v) => setForm((f) => ({ ...f, proformaId: v }))}>
                    <SelectTrigger data-testid="select-create-proforma">
                      <SelectValue placeholder="No proforma" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="_none">No proforma</SelectItem>
                      {activeProformas.map((p) => (
                        <SelectItem key={p.id} value={String(p.id)}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {form.customerId && activeProformas.length === 0 && (
                    <p className="text-xs text-muted-foreground">No active proformas for this customer.</p>
                  )}
                </div>
              )}

              <div className="space-y-1.5">
                <Label>
                  Batch Date <span className="text-destructive">*</span>
                </Label>
                <Input
                  type="date"
                  value={form.batchDate}
                  onChange={(e) => setForm((f) => ({ ...f, batchDate: e.target.value }))}
                  data-testid="input-batch-date"
                />
              </div>

              <div className="space-y-1.5">
                <Label>Currency</Label>
                <Select value={form.currency} onValueChange={(v) => setForm((f) => ({ ...f, currency: v }))}>
                  <SelectTrigger data-testid="select-currency">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="USD">USD</SelectItem>
                    <SelectItem value="LBP">LBP</SelectItem>
                    <SelectItem value="EUR">EUR</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="col-span-2 space-y-1.5">
                <Label>Price Mode</Label>
                <Select value={form.priceMode} onValueChange={(v) => setForm((f) => ({ ...f, priceMode: v }))}>
                  <SelectTrigger data-testid="select-price-mode">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PER_BALE">Per Bale (fixed price per bale)</SelectItem>
                    <SelectItem value="PER_KG">Per Kg (price × weight)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="col-span-2 space-y-1.5">
                <Label>Destination</Label>
                <Input
                  placeholder="e.g. Lubumbashi Port"
                  value={form.destination}
                  onChange={(e) => setForm((f) => ({ ...f, destination: e.target.value }))}
                  data-testid="input-destination"
                />
              </div>

              <div className="col-span-2 space-y-1.5">
                <Label>Notes</Label>
                <Textarea
                  placeholder="Optional notes..."
                  value={form.notes}
                  onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
                  rows={2}
                  data-testid="textarea-notes"
                />
              </div>
            </div>

            {selectedProforma && (
              <div className="border rounded-md p-3 space-y-2 bg-muted/40">
                <p className="text-sm font-medium flex items-center gap-1.5">
                  <Package className="w-4 h-4" />
                  Proforma Summary — {selectedProforma.name}
                </p>
                {selectedProforma.lines && selectedProforma.lines.length > 0 ? (
                  <table className="text-xs w-full">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="text-left font-normal pb-1">Article</th>
                        <th className="text-left font-normal pb-1">Product</th>
                        <th className="text-right font-normal pb-1">Qty</th>
                        <th className="text-right font-normal pb-1">Price</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedProforma.lines.map((l, i) => (
                        <tr key={i}>
                          <td className="font-mono">{l.articleCode}</td>
                          <td className="text-muted-foreground">{l.productName}</td>
                          <td className="text-right">{l.quantity}</td>
                          <td className="text-right">{l.pricePerBale}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-xs text-muted-foreground">Loading proforma lines...</p>
                )}
              </div>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setCreateOpen(false);
                resetForm();
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => createMutation.mutate()}
              disabled={!form.customerId || !form.batchDate || createMutation.isPending}
              data-testid="button-create-batch-submit"
            >
              {createMutation.isPending ? "Creating..." : "Create Batch"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

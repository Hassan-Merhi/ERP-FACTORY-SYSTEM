import { PageHeader } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { Plus, Pencil, Archive, RefreshCw, ChevronRight } from "lucide-react";
import type { CostCenter } from "@/api/costCentersApi";
import { CostCenterAutomationRules } from "@/components/financial/CostCenterAutomationRules";
import { CostCenterReports } from "@/components/financial/CostCenterReports";
import { CostCenterReleaseReadiness } from "@/components/financial/CostCenterReleaseReadiness";
import { CostCenterHistorical } from "@/components/financial/CostCenterHistorical";
import { confirmAction } from "@/components/ConfirmHost";
import { errorMessage } from "./CostCentersHelpers";
import { useCostCentersState } from "./useCostCentersState";
import { CostCentersCard } from "./CostCentersCard";

export default function CostCenters() {
  const {
    isFactory,
    baseUrl,
    navigate,
    canWrite,
    setIncludeArchived,
    includeArchived,
    filter,
    setFilter,
    selectedId,
    setSelectedId,
    editingId,
    setActivityOffset,
    activityOffset,
    activityFrom,
    setActivityFrom,
    activityTo,
    setActivityTo,
    dialogOpen,
    setDialogOpen,
    form,
    setForm,
    refetch,
    isError,
    error,
    isLoading,
    centers,
    rows,
    selected,
    balance,
    loadingBalance,
    loadingActivity,
    activity,
    save,
    archive,
    edit,
  } = useCostCentersState();
  async function handleArchive(center: CostCenter) {
    const confirmed = await confirmAction({
      title: "Archive this cost center?",
      description: "Existing allocations will remain available in historical reports.",
      details: [{ label: "Cost center", value: center.name }],
      confirmText: "Archive",
      tone: "warning",
    });
    if (!confirmed) return;
    archive.mutate(center.id);
  }
  return (
    <div className="space-y-4 p-3 sm:p-5">
      <PageHeader
        title="Cost Centers"
        subtitle="Analytical expense tracking — separate from the general ledger"
        onBack={() => navigate(isFactory ? "/factory/accounts" : "/accounts")}
      />
      <div className="flex flex-wrap items-center gap-2 justify-between">
        <div className="flex flex-wrap gap-2 items-center">
          <Input
            aria-label="Search cost centers"
            placeholder="Search by name or code"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full sm:w-64"
          />
          <Button variant="outline" size="sm" onClick={() => setIncludeArchived((v) => !v)}>
            {includeArchived ? "Hide archived" : "Show archived"}
          </Button>
          <Button variant="ghost" size="icon" title="Refresh" onClick={() => void refetch()}>
            <RefreshCw className="h-4 w-4" />
          </Button>
        </div>
        {canWrite && (
          <Button onClick={() => edit()} data-testid="create-cost-center">
            <Plus className="w-4 h-4 mr-2" /> Add Cost Center
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        Cost centers group expenses for analysis. They cannot receive payments or vouchers as ledger accounts. Budget
        reporting, historical reconciliation, and controlled allocations are available below.
      </p>
      {isError && (
        <p role="alert" className="text-destructive text-sm">
          Could not load cost centers: {errorMessage(error)}. Check that the database migrations were applied.
        </p>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Cost Center Directory</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {isLoading && <p className="text-sm text-muted-foreground">Loading cost centers…</p>}
            {!isLoading && rows.length === 0 && !isError && (
              <p className="text-sm text-muted-foreground p-6 text-center">
                No matching centers. Create one to start tracking costs.
              </p>
            )}
            {rows.map(({ center, depth }) => (
              <div
                key={center.id}
                className={
                  "flex flex-wrap items-center gap-1 rounded-md border p-2 " +
                  (selectedId === center.id ? "border-primary bg-muted/40" : "")
                }
              >
                <button
                  type="button"
                  className="text-left flex-1 min-w-0 flex items-center gap-2"
                  onClick={() => {
                    setSelectedId(center.id);
                    setActivityOffset(0);
                  }}
                  aria-label={"View " + center.name}
                >
                  <span style={{ marginLeft: Math.min(depth, 4) * 12 }} className="shrink-0">
                    <ChevronRight className="h-3 w-3 text-muted-foreground" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium break-words">{center.name}</span>
                    <span className="block text-xs text-muted-foreground">{center.code}</span>
                  </span>
                </button>
                {!center.active && <Badge variant="secondary">Archived</Badge>}
                {canWrite && (
                  <>
                    <Button variant="ghost" size="icon" title={"Edit " + center.name} onClick={() => edit(center)}>
                      <Pencil className="h-4 w-4" />
                    </Button>
                    {center.active && (
                      <Button
                        variant="ghost"
                        size="icon"
                        title={"Archive " + center.name}
                        onClick={() => handleArchive(center)}
                        disabled={archive.isPending}
                      >
                        <Archive className="h-4 w-4" />
                      </Button>
                    )}
                  </>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
        <CostCentersCard
          activity={activity}
          activityFrom={activityFrom}
          activityOffset={activityOffset}
          activityTo={activityTo}
          balance={balance}
          isFactory={isFactory}
          loadingActivity={loadingActivity}
          loadingBalance={loadingBalance}
          navigate={navigate}
          selected={selected}
          setActivityFrom={setActivityFrom}
          setActivityOffset={setActivityOffset}
          setActivityTo={setActivityTo}
        />
      </div>
      <CostCenterReleaseReadiness baseUrl={baseUrl} />
      <CostCenterReports baseUrl={baseUrl} centers={centers} />
      <CostCenterHistorical baseUrl={baseUrl} centers={centers} />
      <CostCenterAutomationRules baseUrl={baseUrl} centers={centers} />
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit Cost Center" : "New Cost Center"}</DialogTitle>
          </DialogHeader>
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              if (!save.isPending) save.mutate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="cc-code">Code</Label>
              <Input
                id="cc-code"
                required
                maxLength={50}
                value={form.code}
                onChange={(e) => setForm((p) => ({ ...p, code: e.target.value }))}
                placeholder="e.g. WH-01"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cc-name">Name</Label>
              <Input
                id="cc-name"
                required
                maxLength={180}
                value={form.name}
                onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="Warehouse Operations"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cc-parent">Parent Cost Center</Label>
              <Select value={form.parentId} onValueChange={(v) => setForm((p) => ({ ...p, parentId: v }))}>
                <SelectTrigger id="cc-parent">
                  <SelectValue placeholder="No parent" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="root">None (top level)</SelectItem>
                  {centers
                    .filter((c) => c.active && c.id !== editingId)
                    .map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.code} — {c.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="cc-description">Description (optional)</Label>
              <Textarea
                id="cc-description"
                maxLength={2000}
                value={form.description}
                onChange={(e) => setForm((p) => ({ ...p, description: e.target.value }))}
              />
            </div>
            <DialogFooter className="gap-2">
              <Button type="button" variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!form.code.trim() || !form.name.trim() || save.isPending}>
                {save.isPending ? "Saving…" : "Save Cost Center"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

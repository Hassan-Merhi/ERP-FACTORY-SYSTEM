import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
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
import { useLocation } from "wouter";
import type { CostCenter, CostCenterCatalog, CostCenterBalance, CostCenterActivity } from "@/api/costCentersApi";
import { readCostCenterApi, writeCostCenterApi } from "@/api/costCentersApi";
import { CostCenterAutomationRules } from "@/components/financial/CostCenterAutomationRules";
import { CostCenterReports } from "@/components/financial/CostCenterReports";
import { CostCenterReleaseReadiness } from "@/components/financial/CostCenterReleaseReadiness";
import { CostCenterHistorical } from "@/components/financial/CostCenterHistorical";

type Form = { code: string; name: string; description: string; parentId: string };
const emptyForm: Form = { code: "", name: "", description: "", parentId: "root" };
function detailsFrom(center: CostCenter): Form {
  return {
    code: center.code,
    name: center.name,
    description: center.description || "",
    parentId: center.parentId == null ? "root" : String(center.parentId),
  };
}
function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Request failed";
}
function sortCenters(centers: CostCenter[]) {
  const map = new Map<number, CostCenter[]>();
  centers.forEach((center) => {
    const key = centers.some((c) => c.id === center.parentId) ? center.parentId! : 0;
    map.set(key, [...(map.get(key) || []), center]);
  });
  const result: Array<{ center: CostCenter; depth: number }> = [];
  const seen = new Set<number>();
  function visit(parent: number, depth: number) {
    for (const center of (map.get(parent) || []).sort((a, b) => a.code.localeCompare(b.code))) {
      if (seen.has(center.id)) continue;
      seen.add(center.id);
      result.push({ center, depth });
      visit(center.id, depth + 1);
    }
  }
  visit(0, 0);
  centers.filter((c) => !seen.has(c.id)).forEach((c) => result.push({ center: c, depth: 0 }));
  return result;
}

export default function CostCenters() {
  const { selectedCompany } = useCompany();
  const isFactory = useAppMode() === "factory";
  const baseUrl = isFactory ? "/api/factory/cost-centers" : "/api/cost-centers";
  const { toast } = useToast();
  const [, navigate] = useLocation();
  const companyId = selectedCompany?.id;
  const role = selectedCompany?.role || "";
  const canWrite = ["Admin", "Owner", "Developer"].includes(role);
  const key = [baseUrl, companyId];
  const [includeArchived, setIncludeArchived] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [activityOffset, setActivityOffset] = useState(0);
  const [activityFrom, setActivityFrom] = useState("");
  const [activityTo, setActivityTo] = useState("");
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<Form>(emptyForm);
  const { data, isLoading, isError, error, refetch } = useQuery<CostCenterCatalog>({
    queryKey: [...key, includeArchived],
    queryFn: () => readCostCenterApi<CostCenterCatalog>(baseUrl + (includeArchived ? "?includeArchived=true" : "")),
    enabled: !!companyId,
    staleTime: 30000,
  });
  const centers = useMemo(() => data?.costCenters ?? [], [data]);
  const rows = useMemo(
    () =>
      sortCenters(centers).filter(({ center }) =>
        [center.name, center.code, center.description || ""].some((s) => s.toLowerCase().includes(filter.toLowerCase()))
      ),
    [centers, filter]
  );
  const selected = centers.find((c) => c.id === selectedId) || null;
  const { data: balance, isLoading: loadingBalance } = useQuery<CostCenterBalance>({
    queryKey: [baseUrl, companyId, selectedId, "balance"],
    queryFn: () => readCostCenterApi<CostCenterBalance>(baseUrl + "/" + selectedId + "/balance"),
    enabled: !!companyId && !!selectedId,
  });
  const { data: activity, isLoading: loadingActivity } = useQuery<CostCenterActivity>({
    queryKey: [baseUrl, companyId, selectedId, "activity", activityOffset, activityFrom, activityTo],
    queryFn: () =>
      readCostCenterApi<CostCenterActivity>(
        baseUrl +
          "/" +
          selectedId +
          "/activity?limit=50&offset=" +
          activityOffset +
          (activityFrom ? "&fromDate=" + activityFrom : "") +
          (activityTo ? "&toDate=" + activityTo : "")
      ),
    enabled: !!companyId && !!selectedId,
  });
  const invalidate = async () => {
    await queryClient.invalidateQueries({ queryKey: [baseUrl, companyId] });
  };
  const save = useMutation({
    mutationFn: () => {
      const body = {
        code: form.code.trim(),
        name: form.name.trim(),
        description: form.description.trim() || null,
        parentId: form.parentId === "root" ? null : Number(form.parentId),
      };
      return editingId == null
        ? writeCostCenterApi("POST", baseUrl, body)
        : writeCostCenterApi("PATCH", baseUrl + "/" + editingId, body);
    },
    onSuccess: async () => {
      setDialogOpen(false);
      await invalidate();
      toast({ title: editingId == null ? "Cost center created" : "Cost center updated" });
    },
    onError: (e: unknown) =>
      toast({ title: "Could not save cost center", description: errorMessage(e), variant: "destructive" }),
  });
  const archive = useMutation({
    mutationFn: (id: number) => writeCostCenterApi("POST", baseUrl + "/" + id + "/archive", {}),
    onSuccess: async () => {
      await invalidate();
      setSelectedId(null);
      toast({ title: "Cost center archived", description: "Historical allocations are preserved." });
    },
    onError: (e: unknown) =>
      toast({ title: "Could not archive cost center", description: errorMessage(e), variant: "destructive" }),
  });
  function edit(center?: CostCenter) {
    setEditingId(center?.id || null);
    setForm(center ? detailsFrom(center) : emptyForm);
    setDialogOpen(true);
  }
  function handleArchive(center: CostCenter) {
    if (
      !window.confirm("Archive " + center.name + "? Existing allocations will remain available in historical reports.")
    )
      return;
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
            <Plus className="w-4 h-4 mr-2" /> New Cost Center
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
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Center Activity</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {!selected && (
              <p className="text-sm text-muted-foreground">
                Select a cost center to view its allocations and source vouchers.
              </p>
            )}
            {selected && (
              <>
                <div>
                  <div className="font-semibold">{selected.name}</div>
                  <div className="text-sm text-muted-foreground">
                    {selected.code} · {selected.active ? "Active" : "Archived"}
                  </div>
                  {selected.description && <p className="text-sm mt-1">{selected.description}</p>}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {(balance?.byTreatment || []).map((row) => (
                    <div key={row.costTreatment} className="rounded-md border p-3">
                      <p className="text-xs text-muted-foreground">
                        {row.costTreatment === "INVENTORY_COST" ? "Capitalized / inventory" : row.costTreatment}
                      </p>
                      <p className="font-mono font-semibold">
                        USD{" "}
                        {Number(row.amountBase).toLocaleString(undefined, {
                          minimumFractionDigits: 2,
                          maximumFractionDigits: 2,
                        })}
                      </p>
                      <p className="text-xs text-muted-foreground">{row.entryCount} allocations</p>
                    </div>
                  ))}
                </div>
                {loadingBalance && <p className="text-xs text-muted-foreground">Loading totals…</p>}
                {loadingActivity && <p className="text-xs text-muted-foreground">Loading activity…</p>}
                <div className="flex flex-wrap gap-2 items-center">
                  <div className="space-y-1 flex-1 min-w-[125px]">
                    <Label htmlFor="cost-center-from-date">From</Label>
                    <Input
                      id="cost-center-from-date"
                      type="date"
                      value={activityFrom}
                      onChange={(e) => {
                        setActivityFrom(e.target.value);
                        setActivityOffset(0);
                      }}
                    />
                  </div>
                  <div className="space-y-1 flex-1 min-w-[125px]">
                    <Label htmlFor="cost-center-to-date">To</Label>
                    <Input
                      id="cost-center-to-date"
                      type="date"
                      value={activityTo}
                      onChange={(e) => {
                        setActivityTo(e.target.value);
                        setActivityOffset(0);
                      }}
                    />
                  </div>
                </div>
                <div className="space-y-1">
                  {(activity?.activity || []).map((row) => (
                    <div key={row.id} className="border-b py-2 flex items-start justify-between gap-2 text-sm">
                      <div>
                        {row.voucherId ? (
                          <button
                            type="button"
                            className="font-medium text-primary hover:underline text-left"
                            onClick={() =>
                              navigate((isFactory ? "/factory/voucher-detail/" : "/voucher-detail/") + row.voucherId)
                            }
                          >
                            {row.voucherNumber || "Voucher #" + row.voucherId}
                          </button>
                        ) : row.factoryDaybookEntryId && isFactory ? (
                          <button
                            className="font-medium text-primary hover:underline text-left"
                            type="button"
                            onClick={() => navigate("/factory/daybook?entryId=" + row.factoryDaybookEntryId)}
                          >
                            {row.factoryTxType || "Factory daybook entry"} #{row.factoryDaybookEntryId}
                          </button>
                        ) : (
                          <p className="font-medium">{row.factoryTxType || "Entry #" + row.id}</p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {row.sourceDate ? String(row.sourceDate).slice(0, 10) : "Date unavailable"} ·{" "}
                          {row.costTreatment} · {row.allocationOrigin === "AUTO" ? "Automatic" : "Manual"}
                        </p>
                        {row.voucherEntryId && (
                          <p className="text-xs text-muted-foreground">Voucher entry #{row.voucherEntryId}</p>
                        )}
                      </div>
                      <span className="font-mono shrink-0">USD {Number(row.amountBase).toFixed(2)}</span>
                    </div>
                  ))}
                  {!loadingActivity && activity?.activity?.length === 0 && (
                    <p className="text-sm text-muted-foreground">No allocated transactions in this date range.</p>
                  )}
                </div>
                <div className="flex justify-between gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!activityOffset || loadingActivity}
                    onClick={() => setActivityOffset((v) => Math.max(0, v - 50))}
                  >
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={loadingActivity || (activity?.activity?.length || 0) < 50}
                    onClick={() => setActivityOffset((v) => v + 50)}
                  >
                    Next
                  </Button>
                </div>
              </>
            )}
          </CardContent>
        </Card>
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

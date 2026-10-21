/**
 * Phase 5 opt-in mapping editor, used by both ERP and Factory Cost Centers.
 * Rules apply only to newly posted eligible expenses. Source amounts are never
 * changed and unallocated portions remain visible.
 */
import { useMemo, useState } from "react";
import Decimal from "decimal.js";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCompany } from "@/contexts/CompanyContext";
import { useAppMode } from "@/contexts/AppModeContext";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Plus, Pencil, Trash2, Zap } from "lucide-react";
import { readCostCenterApi, writeCostCenterApi, type CostCenter } from "@/api/costCentersApi";

type Account = { id: number; code: string; name: string; accountType: string };
type Rule = {
  id: number;
  sourceKind: "VOUCHER_ENTRY" | "FACTORY_DAYBOOK";
  ledgerAccountId: number | null;
  ledgerAccountName: string | null;
  ledgerAccountCode: string | null;
  sourceModule: string | null;
  factoryTxType: string | null;
  costCenterId: number;
  costCenterCode: string;
  costCenterName: string;
  percent: string;
  active: boolean;
};
type DraftSplit = { costCenterId: string; percent: string };
type FormState = {
  sourceKind: "VOUCHER_ENTRY" | "FACTORY_DAYBOOK";
  ledgerAccountId: string;
  sourceModule: string;
  factoryTxType: string;
  reason: string;
  splits: DraftSplit[];
};
const initialForm = (): FormState => ({
  sourceKind: "VOUCHER_ENTRY",
  ledgerAccountId: "",
  sourceModule: "all",
  factoryTxType: "EXPENSE",
  reason: "Update automatic cost center mapping",
  splits: [{ costCenterId: "", percent: "100" }],
});
const factoryTypes = ["EXPENSE", "OPERATING_EXPENSE", "FACTORY_EXPENSE"] as const;
function idFor(rule: Rule): string {
  return [rule.sourceKind, rule.ledgerAccountId ?? "", rule.sourceModule ?? "", rule.factoryTxType ?? ""].join("|");
}
function requestError(error: unknown) {
  return error instanceof Error ? error.message : "Could not save automatic allocation rule";
}

export function CostCenterAutomationRules({ baseUrl, centers }: { baseUrl: string; centers: CostCenter[] }) {
  const { selectedCompany } = useCompany();
  const isFactory = useAppMode() === "factory";
  const { toast } = useToast();
  const companyId = selectedCompany?.id;
  const canWrite = ["Admin", "Owner", "Developer"].includes(selectedCompany?.role || "");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<FormState>(initialForm);
  const { data: accountData, isLoading: accountsLoading } = useQuery<{ accounts: Account[] }>({
    queryKey: [baseUrl, companyId, "automation", "accounts"],
    queryFn: () => readCostCenterApi<{ accounts: Account[] }>(baseUrl + "/automation/accounts"),
    enabled: !!companyId,
    staleTime: 60000,
  });
  const {
    data: ruleData,
    isLoading: rulesLoading,
    isError,
    error,
  } = useQuery<{ rules: Rule[] }>({
    queryKey: [baseUrl, companyId, "automation", "rules"],
    queryFn: () => readCostCenterApi<{ rules: Rule[] }>(baseUrl + "/automation/rules"),
    enabled: !!companyId,
    staleTime: 15000,
  });
  const { data: failureData } = useQuery<{
    failures: Array<{
      id: number;
      sourceKind: string;
      sourceId: number;
      message: string;
      failureCount: number;
      lastSeen: string;
    }>;
  }>({
    queryKey: [baseUrl, companyId, "automation", "failures"],
    queryFn: () =>
      readCostCenterApi<{
        failures: Array<{
          id: number;
          sourceKind: string;
          sourceId: number;
          message: string;
          failureCount: number;
          lastSeen: string;
        }>;
      }>(baseUrl + "/automation/failures"),
    enabled: !!companyId,
    staleTime: 30000,
  });
  const rules = useMemo(() => ruleData?.rules ?? [], [ruleData]);
  const grouped = useMemo(() => {
    const result = new Map<string, Rule[]>();
    for (const item of rules) {
      if (!item.active) continue;
      const key = idFor(item);
      result.set(key, [...(result.get(key) || []), item]);
    }
    return [...result.values()];
  }, [rules]);
  const percentTotal = useMemo(() => {
    try {
      return form.splits.reduce((sum, split) => sum.plus(new Decimal(split.percent || 0)), new Decimal(0));
    } catch {
      return new Decimal(-1);
    }
  }, [form.splits]);
  const valid =
    form.splits.every(
      (s) =>
        s.costCenterId &&
        /^(?:0|[1-9]\d{0,2})(?:\.\d{1,4})?$/.test(s.percent) &&
        new Decimal(s.percent).gt(0) &&
        centers.some((c) => c.active && String(c.id) === s.costCenterId)
    ) &&
    new Set(form.splits.map((s) => s.costCenterId)).size === form.splits.length &&
    percentTotal.gte(0) &&
    percentTotal.lte(100) &&
    (form.sourceKind === "FACTORY_DAYBOOK" ? isFactory && !!form.factoryTxType : !!form.ledgerAccountId) &&
    form.reason.trim().length >= 3;
  function editRule(rows: Rule[]) {
    const first = rows[0];
    setEditing(true);
    setForm({
      sourceKind: first.sourceKind,
      ledgerAccountId: String(first.ledgerAccountId ?? ""),
      sourceModule: first.sourceModule || "all",
      factoryTxType: first.factoryTxType || "EXPENSE",
      reason: "Update automatic cost center mapping",
      splits: rows.map((r) => ({ costCenterId: String(r.costCenterId), percent: r.percent })),
    });
    setOpen(true);
  }
  function createRule() {
    setEditing(false);
    setForm(initialForm());
    setOpen(true);
  }
  function editSplit(index: number, patch: Partial<DraftSplit>) {
    setForm((old) => ({ ...old, splits: old.splits.map((v, i) => (i === index ? { ...v, ...patch } : v)) }));
  }
  const save = useMutation({
    mutationFn: () =>
      writeCostCenterApi("PUT", baseUrl + "/automation/rules", {
        sourceKind: form.sourceKind,
        ledgerAccountId: form.sourceKind === "VOUCHER_ENTRY" ? Number(form.ledgerAccountId) : null,
        sourceModule: form.sourceKind === "VOUCHER_ENTRY" && form.sourceModule !== "all" ? form.sourceModule : null,
        factoryTxType: form.sourceKind === "FACTORY_DAYBOOK" ? form.factoryTxType : null,
        splits: form.splits.map((s) => ({
          costCenterId: Number(s.costCenterId),
          percent: new Decimal(s.percent).toFixed(4),
        })),
        reason: form.reason.trim(),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [baseUrl, companyId, "automation"] });
      setOpen(false);
      toast({
        title: "Automatic rule saved",
        description: "Only future eligible posted expense entries use this mapping.",
      });
    },
    onError: (e) => toast({ title: "Could not save rule", description: requestError(e), variant: "destructive" }),
  });
  const remove = useMutation({
    mutationFn: (rows: Rule[]) => {
      const first = rows[0];
      return writeCostCenterApi("PUT", baseUrl + "/automation/rules", {
        sourceKind: first.sourceKind,
        ledgerAccountId: first.ledgerAccountId,
        sourceModule: first.sourceModule,
        factoryTxType: first.factoryTxType,
        splits: [],
        reason: "Disable automatic mapping",
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [baseUrl, companyId, "automation"] });
      toast({ title: "Rule disabled", description: "Existing allocation snapshots were preserved." });
    },
    onError: (e) => toast({ title: "Could not disable rule", description: requestError(e), variant: "destructive" }),
  });
  return (
    <Card data-testid="cost-center-automation-rules">
      <CardHeader className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base flex items-center gap-2">
            <Zap className="h-4 w-4" /> Automatic Expense Allocation
          </CardTitle>
          {canWrite && (
            <Button size="sm" variant="outline" onClick={createRule}>
              <Plus className="h-4 w-4 mr-1" /> New Rule
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Opt-in mappings for new posted expense debits only. Payroll, utilities, maintenance, transport, and loading
          costs can be mapped to centers when an eligible expense ledger account is posted. Inventory, payments,
          non-finalized containers, stock transfers, and mix movements do not become new expenses. Manual allocation
          changes always take priority.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {(failureData?.failures?.length || 0) > 0 && (
          <div className="rounded-md border border-destructive/30 p-3 space-y-2" role="status">
            <p className="text-sm font-semibold">Automatic allocation attention required</p>
            <p className="text-xs text-muted-foreground">
              Accounting postings were preserved, but these analytical assignments could not be completed. An authorized
              user can inspect the original source and assign its cost center manually.
            </p>
            {failureData?.failures.slice(0, 5).map((item) => (
              <p className="text-xs" key={item.id}>
                {item.sourceKind === "VOUCHER_ENTRY" ? "Voucher entry" : "Factory Daybook entry"} #{item.sourceId}:{" "}
                {item.message}
              </p>
            ))}
          </div>
        )}

        {rulesLoading && <p className="text-sm text-muted-foreground">Loading automatic rules…</p>}
        {isError && (
          <p role="alert" className="text-sm text-destructive">
            {requestError(error)}
          </p>
        )}
        {!rulesLoading && !isError && !grouped.length && (
          <p className="text-sm text-muted-foreground">
            No automatic rules configured. Existing and future expenses remain Unallocated unless assigned manually or
            matched by a new rule.
          </p>
        )}
        {grouped.map((rows) => {
          const first = rows[0];
          return (
            <div key={idFor(first)} className="flex flex-wrap items-center gap-3 rounded-md border p-3">
              <div className="flex-1 min-w-0 space-y-1">
                <p className="text-sm font-medium">
                  {first.sourceKind === "VOUCHER_ENTRY"
                    ? (first.ledgerAccountCode || "") + " — " + (first.ledgerAccountName || "Expense Account")
                    : "Standalone Factory: " + first.factoryTxType}
                </p>
                <div className="text-xs text-muted-foreground">
                  {first.sourceKind === "VOUCHER_ENTRY"
                    ? first.sourceModule || "Any source module"
                    : "Factory Daybook only"}
                </div>
                <div className="flex gap-1 flex-wrap">
                  {rows.map((rule) => (
                    <Badge key={rule.id} variant="secondary">
                      {rule.costCenterCode} {rule.percent}%
                    </Badge>
                  ))}
                </div>
              </div>
              {canWrite && (
                <div className="flex gap-1">
                  <Button variant="outline" size="sm" onClick={() => editRule(rows)}>
                    <Pencil className="h-3 w-3 mr-1" /> Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Disable rule"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (
                        window.confirm("Disable this mapping for future entries? Existing tagged costs stay unchanged.")
                      )
                        remove.mutate(rows);
                    }}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </CardContent>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90dvh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit" : "New"} Automatic Allocation Rule</DialogTitle>
            <DialogDescription>
              Configured rule applies only to eligible future postings. 100% assigns the full amount; lower totals leave
              a portion Unallocated.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {isFactory && (
              <div className="space-y-1">
                <Label>Source</Label>
                <Select
                  value={form.sourceKind}
                  disabled={editing}
                  onValueChange={(v) => setForm({ ...initialForm(), sourceKind: v as FormState["sourceKind"] })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="VOUCHER_ENTRY">Posted expense ledger account</SelectItem>
                    <SelectItem value="FACTORY_DAYBOOK">Standalone Factory expense</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
            {form.sourceKind === "VOUCHER_ENTRY" ? (
              <>
                <div className="space-y-1">
                  <Label>Expense Ledger Account</Label>
                  <Select
                    value={form.ledgerAccountId}
                    disabled={editing || accountsLoading}
                    onValueChange={(v) => setForm((p) => ({ ...p, ledgerAccountId: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Choose an expense account" />
                    </SelectTrigger>
                    <SelectContent>
                      {(accountData?.accounts || []).map((a) => (
                        <SelectItem key={a.id} value={String(a.id)}>
                          {a.code} — {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label>Source Module</Label>
                  <Select
                    value={form.sourceModule}
                    disabled={editing}
                    onValueChange={(v) => setForm((p) => ({ ...p, sourceModule: v }))}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">Any source (fallback)</SelectItem>
                      <SelectItem value="ERP">ERP only</SelectItem>
                      <SelectItem value="FACTORY">Factory only</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </>
            ) : (
              <div className="space-y-1">
                <Label>Standalone Daybook Expense Type</Label>
                <Select
                  value={form.factoryTxType}
                  disabled={editing}
                  onValueChange={(v) => setForm((p) => ({ ...p, factoryTxType: v }))}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {factoryTypes.map((t) => (
                      <SelectItem key={t} value={t}>
                        {t}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <div className="space-y-2">
              <Label>Assign to Cost Centers</Label>
              {form.splits.map((split, index) => (
                <div key={index} className="flex flex-col sm:flex-row gap-2 items-end rounded-md border p-2">
                  <div className="w-full flex-1">
                    <Label className="text-xs">Cost Center</Label>
                    <Select value={split.costCenterId} onValueChange={(v) => editSplit(index, { costCenterId: v })}>
                      <SelectTrigger>
                        <SelectValue placeholder="Select center" />
                      </SelectTrigger>
                      <SelectContent>
                        {centers
                          .filter((c) => c.active)
                          .map((c) => (
                            <SelectItem key={c.id} value={String(c.id)}>
                              {c.code} — {c.name}
                            </SelectItem>
                          ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="w-full sm:w-28">
                    <Label className="text-xs">Percent</Label>
                    <Input
                      inputMode="decimal"
                      value={split.percent}
                      onChange={(e) => editSplit(index, { percent: e.target.value })}
                    />
                  </div>
                  <Button
                    title="Remove split"
                    size="icon"
                    variant="ghost"
                    onClick={() => setForm((p) => ({ ...p, splits: p.splits.filter((_, i) => i !== index) }))}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              <div className="flex items-center justify-between gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setForm((p) => ({ ...p, splits: [...p.splits, { costCenterId: "", percent: "" }] }))}
                >
                  <Plus className="h-4 w-4 mr-1" /> Add Split
                </Button>
                <span className={"text-sm " + (percentTotal.gt(100) ? "text-destructive" : "text-muted-foreground")}>
                  Allocated {percentTotal.toFixed(4)}% · Unallocated{" "}
                  {percentTotal.gte(0)
                    ? Decimal.max(new Decimal(0), new Decimal(100).minus(percentTotal)).toFixed(4)
                    : "—"}
                  %
                </span>
              </div>
            </div>
            <div className="space-y-1">
              <Label htmlFor="cost-center-rule-reason">Change Reason</Label>
              <Input
                id="cost-center-rule-reason"
                maxLength={500}
                value={form.reason}
                onChange={(e) => setForm((p) => ({ ...p, reason: e.target.value }))}
              />
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button disabled={!valid || save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save Automatic Rule"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

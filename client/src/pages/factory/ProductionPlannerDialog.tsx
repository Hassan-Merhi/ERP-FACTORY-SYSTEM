import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  CheckCircle2,
  ChevronsUpDown,
  ClipboardList,
  Copy,
  Loader2,
  Plus,
  Save,
  Tag,
  Trash2,
  XCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { cn } from "@/lib/utils";
import { WorkerCategoriesManager } from "./bale-stock-entry/WorkerCategoriesTab";

interface Worker {
  id: number;
  fullName?: string;
  full_name?: string;
  position?: string;
  active?: boolean;
}

interface WorkerCategory {
  id: number;
  name: string;
  workerIds?: number[];
  worker_ids?: number[];
}

interface PlanEntry {
  id?: number;
  workerId: number;
  workerName: string;
  targetBales: number;
  workerCount: number;
}

interface PlanData {
  plan: { id: number; planDate: string; categoryIds: number[]; notes: string } | null;
  entries: PlanEntry[];
  actuals: Record<number, number>;
}

interface CopyPreviousResponse {
  entries: PlanEntry[];
  categoryIds: number[];
  notes: string;
  fromDate: string | null;
}

type EditableEntry = PlanEntry & { key: string };

function workerName(worker: Worker): string {
  return worker.fullName || worker.full_name || `Worker #${worker.id}`;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `Request failed (${response.status})`);
  return payload as T;
}

function CategorySelector({
  value,
  onChange,
  categories,
}: {
  value: number[];
  onChange: (value: number[]) => void;
  categories: WorkerCategory[];
}) {
  const label =
    value.length === 0
      ? "All workers"
      : value.length === 1
        ? (categories.find((category) => category.id === value[0])?.name ?? "1 selected")
        : `${value.length} teams`;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="max-w-[220px] justify-between gap-1"
          data-testid="button-category-filter"
        >
          <span className="truncate text-xs">{label}</span>
          <ChevronsUpDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="max-h-64 w-56 overflow-y-auto p-2">
        <div className="mb-2 px-1 text-xs font-medium text-muted-foreground">Filter workers by team</div>
        <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted">
          <Checkbox checked={value.length === 0} onCheckedChange={() => onChange([])} />
          <span>All workers</span>
        </label>
        {categories.map((category) => (
          <label
            key={category.id}
            className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm hover:bg-muted"
          >
            <Checkbox
              checked={value.includes(category.id)}
              onCheckedChange={() =>
                onChange(
                  value.includes(category.id) ? value.filter((id) => id !== category.id) : [...value, category.id]
                )
              }
            />
            <span className="truncate">{category.name}</span>
          </label>
        ))}
      </PopoverContent>
    </Popover>
  );
}

function WorkerSelector({
  entry,
  workers,
  onChange,
}: {
  entry: EditableEntry;
  workers: Worker[];
  onChange: (workerId: number, name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const selected = workers.find((worker) => worker.id === entry.workerId);
  const selectedName = selected ? workerName(selected) : entry.workerName || `Worker #${entry.workerId}`;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 w-full justify-between font-normal"
          data-testid={`select-worker-${entry.key}`}
        >
          <span className="truncate">{selectedName}</span>
          <ChevronsUpDown className="ml-1 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-64 p-0" align="start">
        <Command>
          <CommandInput placeholder="Search worker…" className="h-9" />
          <CommandList>
            <CommandEmpty>No workers found.</CommandEmpty>
            <CommandGroup>
              {workers.map((worker) => (
                <CommandItem
                  key={worker.id}
                  value={workerName(worker)}
                  onSelect={() => {
                    onChange(worker.id, workerName(worker));
                    setOpen(false);
                  }}
                >
                  <Check className={cn("mr-2 h-4 w-4", worker.id === entry.workerId ? "opacity-100" : "opacity-0")} />
                  <span className={cn("truncate", worker.active === false && "text-muted-foreground")}>
                    {workerName(worker)}
                    {worker.active === false && <span className="ml-1 text-xs">(inactive)</span>}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

export default function ProductionPlannerDialog() {
  const [open, setOpen] = useState(false);
  const [showCategoryManager, setShowCategoryManager] = useState(false);
  const [date, setDate] = useState(() => new Date().toLocaleDateString("en-CA"));
  const [categoryIds, setCategoryIds] = useState<number[]>([]);
  const [entries, setEntries] = useState<EditableEntry[]>([]);
  const [notes, setNotes] = useState("");
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: allWorkers = [] } = useQuery<Worker[]>({
    queryKey: ["/api/factory/workers?profile=picker"],
    enabled: open,
  });
  const { data: categories = [] } = useQuery<WorkerCategory[]>({
    queryKey: ["/api/factory/worker-categories"],
    enabled: open,
  });
  const workers = useMemo(() => {
    const selectedWorkerIds = new Set(
      categories
        .filter((category) => categoryIds.includes(category.id))
        .flatMap((category) => category.workerIds ?? category.worker_ids ?? [])
        .map(Number)
    );
    const activeWorkers = allWorkers.filter((worker) => worker.active !== false);
    return selectedWorkerIds.size ? activeWorkers.filter((worker) => selectedWorkerIds.has(worker.id)) : activeWorkers;
  }, [allWorkers, categories, categoryIds]);

  const {
    data: planData,
    isLoading: planLoading,
    isError,
    error,
    refetch: refetchPlan,
  } = useQuery<PlanData>({
    queryKey: ["/api/factory/production-planner", date],
    queryFn: () => fetchJson<PlanData>(`/api/factory/production-planner/${date}`),
    enabled: open,
  });

  useEffect(() => {
    if (!planData) return;
    setCategoryIds(planData.plan?.categoryIds ?? []);
    setNotes(planData.plan?.notes ?? "");
    setEntries(
      (planData.entries ?? []).map((entry, index) => ({
        ...entry,
        workerCount: entry.workerCount ?? 0,
        key: `loaded-${entry.workerId}-${index}`,
      }))
    );
  }, [planData]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiRequest("POST", `/api/factory/production-planner/${date}`, {
        notes,
        categoryIds,
        entries: entries.map((entry) => ({
          workerId: entry.workerId,
          targetBales: entry.targetBales,
          workerCount: entry.workerCount,
        })),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["/api/factory/production-planner", date] });
      await refetchPlan();
      toast({ title: "Plan saved" });
    },
    onError: (saveError: Error) =>
      toast({ title: "Could not save plan", description: saveError.message, variant: "destructive" }),
  });

  const copyPreviousMutation = useMutation({
    mutationFn: () => fetchJson<CopyPreviousResponse>(`/api/factory/production-planner/${date}/copy-previous`),
    onSuccess: (data) => {
      if (!data.fromDate) {
        toast({ title: "No previous plan found" });
        return;
      }
      setEntries(
        data.entries.map((entry, index) => ({
          ...entry,
          workerCount: entry.workerCount ?? 0,
          key: `copied-${entry.workerId}-${index}-${Date.now()}`,
        }))
      );
      setCategoryIds(data.categoryIds ?? []);
      setNotes(data.notes ?? "");
      toast({ title: `Copied plan from ${data.fromDate}` });
    },
    onError: (copyError: Error) =>
      toast({ title: "Could not copy previous plan", description: copyError.message, variant: "destructive" }),
  });

  const addRow = useCallback(() => {
    if (workers.length === 0) return;
    const usedIds = new Set(entries.map((entry) => entry.workerId));
    const worker = workers.find((candidate) => !usedIds.has(candidate.id)) ?? workers[0];
    setEntries((current) => [
      ...current,
      {
        workerId: worker.id,
        workerName: workerName(worker),
        targetBales: 0,
        workerCount: 0,
        key: `new-${worker.id}-${Date.now()}`,
      },
    ]);
  }, [entries, workers]);

  const updateEntry = (
    key: string,
    patch: Partial<Pick<EditableEntry, "workerId" | "workerName" | "targetBales" | "workerCount">>
  ) => setEntries((current) => current.map((entry) => (entry.key === key ? { ...entry, ...patch } : entry)));

  const actuals = planData?.actuals ?? {};
  const totalTarget = entries.reduce((sum, entry) => sum + (entry.targetBales || 0), 0);
  const totalActual = entries.reduce((sum, entry) => sum + (actuals[entry.workerId] ?? 0), 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" data-testid="button-production-planner">
          <ClipboardList className="mr-1 h-4 w-4" />
          Production Planner
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90vh] max-w-4xl flex-col p-0">
        <DialogHeader className="shrink-0 border-b px-6 pb-3 pt-5">
          <DialogTitle className="flex items-center gap-2">
            <ClipboardList className="h-5 w-5" />
            Production Planner
          </DialogTitle>
        </DialogHeader>

        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4">
          <div className="flex flex-wrap items-center gap-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Date</span>
              <Input
                type="date"
                value={date}
                onChange={(event) => setDate(event.target.value)}
                className="w-40 text-sm"
                data-testid="input-plan-date"
              />
            </div>
            <CategorySelector value={categoryIds} onChange={setCategoryIds} categories={categories} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowCategoryManager((visible) => !visible)}
              aria-expanded={showCategoryManager}
              data-testid="button-manage-worker-groups"
            >
              <Tag className="mr-1 h-4 w-4" />
              {showCategoryManager ? "Hide Groups" : "Manage Groups"}
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => copyPreviousMutation.mutate()}
              disabled={copyPreviousMutation.isPending || planLoading}
              data-testid="button-copy-yesterday"
            >
              {copyPreviousMutation.isPending ? (
                <Loader2 className="mr-1 h-4 w-4 animate-spin" />
              ) : (
                <Copy className="mr-1 h-4 w-4" />
              )}
              Copy Previous Plan
            </Button>
            <div className="ml-auto">
              <Button
                size="sm"
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending || planLoading || isError}
                data-testid="button-save-plan"
              >
                {saveMutation.isPending ? (
                  <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                ) : (
                  <Save className="mr-1 h-4 w-4" />
                )}
                Save Plan
              </Button>
            </div>
          </div>

          {showCategoryManager && <WorkerCategoriesManager compact />}

          {entries.length > 0 && (
            <div className="flex flex-wrap items-center gap-4 rounded-md bg-muted/50 p-3 text-sm">
              <div>
                <span className="text-muted-foreground">Total Target: </span>
                <span className="font-semibold">{totalTarget} bales</span>
              </div>
              <div>
                <span className="text-muted-foreground">Total Actual: </span>
                <span className="font-semibold">{totalActual} bales</span>
              </div>
              {totalTarget > 0 && (
                <div className="ml-auto">
                  {totalActual >= totalTarget ? (
                    <Badge className="bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
                      Target Met
                    </Badge>
                  ) : (
                    <Badge className="bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200">
                      {totalTarget - totalActual} short
                    </Badge>
                  )}
                </div>
              )}
            </div>
          )}

          {planLoading ? (
            <div className="flex items-center justify-center py-10 text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Loading plan…
            </div>
          ) : isError ? (
            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4 text-sm text-destructive">
              Could not load the production planner: {(error as Error)?.message || "Unknown error"}
            </div>
          ) : (
            <div className="overflow-x-auto rounded-md border">
              <table className="min-w-[760px] w-full text-sm">
                <thead className="border-b bg-muted/50">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Worker</th>
                    <th className="w-36 px-3 py-2 text-left font-semibold">Role</th>
                    <th className="w-28 px-3 py-2 text-right font-semibold">Target</th>
                    <th className="w-24 px-3 py-2 text-right font-semibold">Actual</th>
                    <th className="w-28 px-3 py-2 text-right font-semibold">Workers</th>
                    <th className="w-24 px-3 py-2 text-center font-semibold">Status</th>
                    <th className="w-10 px-2" />
                  </tr>
                </thead>
                <tbody>
                  {entries.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-muted-foreground">
                        No workers in plan. Add workers below or copy from a previous plan.
                      </td>
                    </tr>
                  ) : (
                    entries.map((entry) => {
                      const actual = actuals[entry.workerId] ?? 0;
                      const met = entry.targetBales > 0 && actual >= entry.targetBales;
                      const notMet = entry.targetBales > 0 && actual < entry.targetBales;
                      return (
                        <tr key={entry.key} className="border-b last:border-0 hover:bg-muted/30">
                          <td className="px-3 py-2">
                            <WorkerSelector
                              entry={entry}
                              workers={
                                workers.length ? workers : allWorkers.filter((worker) => worker.active !== false)
                              }
                              onChange={(workerId, name) => updateEntry(entry.key, { workerId, workerName: name })}
                            />
                          </td>
                          <td className="px-3 py-2">
                            <Select value="WORKER" onValueChange={() => undefined} disabled>
                              <SelectTrigger className="h-8 text-sm" data-testid={`select-role-${entry.key}`}>
                                <SelectValue />
                              </SelectTrigger>
                              <SelectContent>
                                <SelectItem value="WORKER">Worker</SelectItem>
                              </SelectContent>
                            </Select>
                          </td>
                          <td className="px-3 py-2">
                            <Input
                              type="number"
                              min={0}
                              step={1}
                              value={entry.targetBales}
                              onChange={(event) =>
                                updateEntry(entry.key, { targetBales: Math.max(0, parseInt(event.target.value) || 0) })
                              }
                              className="h-8 text-right"
                              data-testid={`input-target-${entry.key}`}
                            />
                          </td>
                          <td className="px-3 py-2 text-right font-mono font-semibold">{actual}</td>
                          <td className="px-3 py-2">
                            <Input
                              type="number"
                              min={0}
                              step={1}
                              value={entry.workerCount}
                              onChange={(event) =>
                                updateEntry(entry.key, {
                                  workerCount: Math.max(0, parseInt(event.target.value) || 0),
                                })
                              }
                              className="h-8 text-right"
                              data-testid={`input-worker-count-${entry.key}`}
                            />
                          </td>
                          <td className="px-3 py-2 text-center">
                            {met ? (
                              <CheckCircle2 className="mx-auto h-5 w-5 text-green-500" />
                            ) : notMet ? (
                              <XCircle className="mx-auto h-5 w-5 text-red-500" />
                            ) : (
                              <span className="text-xs text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-center">
                            <Button
                              size="icon"
                              variant="ghost"
                              onClick={() => setEntries((current) => current.filter((item) => item.key !== entry.key))}
                              data-testid={`button-remove-${entry.key}`}
                            >
                              <Trash2 className="h-4 w-4 text-muted-foreground" />
                            </Button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={addRow}
              disabled={workers.length === 0 && allWorkers.length === 0}
              data-testid="button-add-worker-row"
            >
              <Plus className="mr-1 h-4 w-4" /> Add Worker
            </Button>
            {entries.length > 0 && <Badge variant="secondary">Workers in plan: {entries.length}</Badge>}
          </div>

          <div className="space-y-1">
            <label className="text-sm font-medium">Notes (optional)</label>
            <Input
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
              placeholder="e.g. short shift, holiday schedule…"
              className="text-sm"
              data-testid="input-plan-notes"
            />
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// The planner intentionally remains team/worker based; position administration is a separate workflow.

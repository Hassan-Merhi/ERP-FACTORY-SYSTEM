import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Archive, CalendarClock, CheckCircle2, History, Pencil, Plus, Target, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { queryClient } from "@/lib/queryClient";
import { useAppMode } from "@/contexts/AppModeContext";
import { getApiRequest } from "@/lib/factoryApi";

type Worker = { id: number; fullName?: string; name?: string; employeeCode?: string | null; active?: boolean };
type Position = {
  id: number;
  name: string;
  active: boolean;
  targetBales: number;
  bonusPerExtraBale: string;
  bonusEnabled: boolean;
  ruleEffectiveFrom: string | null;
  workerIds: number[];
  members: Array<{ workerId: number; fullName: string; employeeCode?: string | null }>;
};

type HistoryPayload = {
  position: { id: number; name: string };
  rules: Array<{
    id: number;
    effectiveFrom: string;
    effectiveTo: string | null;
    targetBales: number;
    bonusPerExtraBale: string;
    bonusEnabled: boolean;
  }>;
  memberships: Array<{
    id: number;
    workerId: number;
    fullName: string;
    employeeCode?: string | null;
    effectiveFrom: string;
    effectiveTo: string | null;
  }>;
};

const todayIso = () => new Date().toLocaleDateString("en-CA");

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.message || `Request failed (${response.status})`);
  return payload as T;
}

export function ProductionPositionsTab() {
  const { toast } = useToast();
  const appMode = useAppMode();
  const factoryRequest = getApiRequest(appMode);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Position | null>(null);
  const [historyPosition, setHistoryPosition] = useState<Position | null>(null);
  const [name, setName] = useState("");
  const [targetBales, setTargetBales] = useState("144");
  const [bonusPerExtraBale, setBonusPerExtraBale] = useState("1");
  const [bonusEnabled, setBonusEnabled] = useState(true);
  const [active, setActive] = useState(true);
  const [workerIds, setWorkerIds] = useState<number[]>([]);
  const [effectiveFrom, setEffectiveFrom] = useState(todayIso());

  const { data: workers = [] } = useQuery<Worker[]>({
    queryKey: ["/api/factory/workers?profile=picker"],
    queryFn: () => fetchJson<Worker[]>("/api/factory/workers?profile=picker"),
  });

  const { data: positions = [], isLoading } = useQuery<Position[]>({
    queryKey: ["/api/factory/production-positions"],
    queryFn: () => fetchJson<Position[]>("/api/factory/production-positions"),
  });

  const { data: history, isLoading: historyLoading } = useQuery<HistoryPayload>({
    queryKey: ["/api/factory/production-positions", historyPosition?.id, "history"],
    queryFn: () => fetchJson<HistoryPayload>(`/api/factory/production-positions/${historyPosition!.id}/history`),
    enabled: !!historyPosition,
  });

  const activeWorkers = useMemo(() => workers.filter((worker) => worker.active !== false), [workers]);

  const resetForm = () => {
    setEditing(null);
    setName("");
    setTargetBales("144");
    setBonusPerExtraBale("1");
    setBonusEnabled(true);
    setActive(true);
    setWorkerIds([]);
    setEffectiveFrom(todayIso());
  };

  const openNew = () => {
    resetForm();
    setDialogOpen(true);
  };

  const openEdit = (position: Position) => {
    setEditing(position);
    setName(position.name);
    setTargetBales(String(position.targetBales ?? 0));
    setBonusPerExtraBale(String(position.bonusPerExtraBale ?? 0));
    setBonusEnabled(position.bonusEnabled !== false);
    setActive(position.active !== false);
    setWorkerIds(Array.isArray(position.workerIds) ? position.workerIds : []);
    setEffectiveFrom(todayIso());
    setDialogOpen(true);
  };

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ["/api/factory/production-positions"] });

  const saveMutation = useMutation({
    mutationFn: async () => {
      const payload = {
        name: name.trim(),
        targetBales: Number(targetBales),
        bonusPerExtraBale: Number(bonusPerExtraBale),
        bonusEnabled,
        active,
        workerIds,
        effectiveFrom,
      };
      const response = editing
        ? await factoryRequest("PATCH", `/api/factory/production-positions/${editing.id}`, payload)
        : await factoryRequest("POST", "/api/factory/production-positions", payload);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || "Failed to save production position");
      }
      return response.json();
    },
    onSuccess: async () => {
      await invalidate();
      setDialogOpen(false);
      toast({ title: editing ? "Production position updated" : "Production position created" });
    },
    onError: (error: Error) => toast({ title: "Could not save", description: error.message, variant: "destructive" }),
  });

  const archiveMutation = useMutation({
    mutationFn: async (id: number) => {
      const response = await factoryRequest("DELETE", `/api/factory/production-positions/${id}`);
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        throw new Error(body?.message || "Failed to archive production position");
      }
    },
    onSuccess: async () => {
      await invalidate();
      toast({ title: "Production position archived", description: "History and prior memberships were preserved." });
    },
    onError: (error: Error) =>
      toast({ title: "Could not archive", description: error.message, variant: "destructive" }),
  });

  const toggleWorker = (workerId: number) =>
    setWorkerIds((current) =>
      current.includes(workerId) ? current.filter((id) => id !== workerId) : [...current, workerId]
    );

  const save = () => {
    const target = Number(targetBales);
    const rate = Number(bonusPerExtraBale);
    if (!name.trim()) return toast({ title: "Position name is required", variant: "destructive" });
    if (!Number.isInteger(target) || target < 0)
      return toast({ title: "Target bales must be a whole number of 0 or more", variant: "destructive" });
    if (!Number.isFinite(rate) || rate < 0)
      return toast({ title: "Bonus per extra bale must be 0 or more", variant: "destructive" });
    saveMutation.mutate();
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <Target className="h-4 w-4 text-emerald-500" />
            <h2 className="text-sm font-bold uppercase tracking-widest text-muted-foreground">Production Positions</h2>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            Set the team, daily bale target and standard bonus paid for every bale above target.
          </p>
        </div>
        <Button onClick={openNew} size="sm" className="gap-2" data-testid="button-new-production-position">
          <Plus className="h-4 w-4" />
          New Position
        </Button>
      </div>

      <div className="rounded-xl border bg-card overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead>Position</TableHead>
              <TableHead>Team</TableHead>
              <TableHead className="text-right">Daily Target</TableHead>
              <TableHead className="text-right">$/Extra Bale</TableHead>
              <TableHead>Bonus</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="w-32 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              <TableRow>
                <TableCell colSpan={7} className="h-32 text-center text-muted-foreground">
                  Loading production positions...
                </TableCell>
              </TableRow>
            ) : positions.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="h-36 text-center">
                  <div className="space-y-2 text-muted-foreground">
                    <Users className="mx-auto h-7 w-7 opacity-60" />
                    <p>No production positions created yet.</p>
                    <p className="text-xs">
                      Create positions such as T SHIRTS, JEANS, SPORTS or HHR and assign workers.
                    </p>
                  </div>
                </TableCell>
              </TableRow>
            ) : (
              positions.map((position) => (
                <TableRow key={position.id} className={position.active ? "" : "opacity-60"}>
                  <TableCell>
                    <div className="font-bold">{position.name}</div>
                    {position.ruleEffectiveFrom && (
                      <div className="text-[10px] text-muted-foreground">Rule from {position.ruleEffectiveFrom}</div>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex max-w-md flex-wrap gap-1">
                      {position.members?.length ? (
                        position.members.map((member) => (
                          <Badge key={member.workerId} variant="secondary" className="text-[10px]">
                            {member.fullName}
                          </Badge>
                        ))
                      ) : (
                        <span className="text-xs italic text-muted-foreground">No active team members</span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-right font-mono font-semibold">{position.targetBales}</TableCell>
                  <TableCell className="text-right font-mono font-semibold">
                    ${Number(position.bonusPerExtraBale || 0).toFixed(2)}
                  </TableCell>
                  <TableCell>
                    <Badge variant={position.bonusEnabled ? "default" : "outline"}>
                      {position.bonusEnabled ? "Enabled" : "Disabled"}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={position.active ? "secondary" : "outline"}>
                      {position.active ? "Active" : "Archived"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => setHistoryPosition(position)}
                        title="History"
                      >
                        <History className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        onClick={() => openEdit(position)}
                        title="Edit"
                        data-testid={`button-edit-production-position-${position.id}`}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {position.active && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          onClick={() =>
                            confirm(`Archive ${position.name}? Historical rules and memberships will be kept.`) &&
                            archiveMutation.mutate(position.id)
                          }
                          title="Archive"
                        >
                          <Archive className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.name}` : "New Production Position"}</DialogTitle>
            <DialogDescription>
              Changes use an effective date so earlier production history is not rewritten. Workers may belong to
              multiple positions.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-2 sm:grid-cols-2">
            <div className="space-y-2 sm:col-span-2">
              <label className="text-sm font-medium">Position Name</label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. T SHIRTS"
                data-testid="input-production-position-name"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Daily Target Bales</label>
              <Input
                type="number"
                min="0"
                step="1"
                value={targetBales}
                onChange={(e) => setTargetBales(e.target.value)}
                data-testid="input-production-position-target"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Bonus per Extra Bale ($)</label>
              <Input
                type="number"
                min="0"
                step="0.01"
                value={bonusPerExtraBale}
                onChange={(e) => setBonusPerExtraBale(e.target.value)}
                data-testid="input-production-position-rate"
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-medium">Effective From</label>
              <Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} />
            </div>
            <div className="space-y-3 pt-1">
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={bonusEnabled}
                  onChange={(e) => setBonusEnabled(e.target.checked)}
                  className="h-4 w-4"
                />
                Bonus enabled for this position
              </label>
              <label className="flex cursor-pointer items-center gap-2 text-sm font-medium">
                <input
                  type="checkbox"
                  checked={active}
                  onChange={(e) => setActive(e.target.checked)}
                  className="h-4 w-4"
                />
                Position active
              </label>
            </div>
            <div className="space-y-2 sm:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <label className="text-sm font-medium">Team Members</label>
                <span className="text-xs text-muted-foreground">{workerIds.length} selected</span>
              </div>
              <div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto rounded-xl border p-2 sm:grid-cols-2">
                {activeWorkers.map((worker) => {
                  const selected = workerIds.includes(worker.id);
                  return (
                    <button
                      type="button"
                      key={worker.id}
                      onClick={() => toggleWorker(worker.id)}
                      className={`flex items-center gap-2 rounded-lg border p-2 text-left transition-colors ${selected ? "border-primary bg-primary/10" : "hover:bg-muted"}`}
                    >
                      <span
                        className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${selected ? "border-primary bg-primary" : "border-input"}`}
                      >
                        {selected && <CheckCircle2 className="h-3 w-3 text-primary-foreground" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-xs font-medium">{worker.fullName || worker.name}</span>
                        {worker.employeeCode && (
                          <span className="block text-[10px] text-muted-foreground">{worker.employeeCode}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)}>
              Cancel
            </Button>
            <Button onClick={save} disabled={saveMutation.isPending} data-testid="button-save-production-position">
              {saveMutation.isPending ? "Saving..." : "Save Position"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!historyPosition} onOpenChange={(open) => !open && setHistoryPosition(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <CalendarClock className="h-5 w-5" />
              {historyPosition?.name} History
            </DialogTitle>
            <DialogDescription>
              Previous targets, bonus rates and worker memberships are retained instead of being overwritten.
            </DialogDescription>
          </DialogHeader>
          {historyLoading ? (
            <div className="py-10 text-center text-muted-foreground">Loading history...</div>
          ) : (
            <div className="grid gap-5 py-2 md:grid-cols-2">
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Rule Versions</h3>
                <div className="max-h-72 space-y-2 overflow-y-auto">
                  {history?.rules?.length ? (
                    history.rules.map((rule) => (
                      <div key={rule.id} className="rounded-lg border p-3 text-xs">
                        <div className="flex justify-between gap-2">
                          <span className="font-semibold">
                            {rule.effectiveFrom} → {rule.effectiveTo || "Current"}
                          </span>
                          <Badge variant={rule.bonusEnabled ? "default" : "outline"}>
                            {rule.bonusEnabled ? "Bonus on" : "Bonus off"}
                          </Badge>
                        </div>
                        <div className="mt-2 text-muted-foreground">
                          Target: <b className="text-foreground">{rule.targetBales}</b> · Rate:{" "}
                          <b className="text-foreground">${Number(rule.bonusPerExtraBale || 0).toFixed(2)}</b>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-muted-foreground">No rule history.</div>
                  )}
                </div>
              </div>
              <div className="space-y-2">
                <h3 className="text-sm font-semibold">Membership History</h3>
                <div className="max-h-72 space-y-2 overflow-y-auto">
                  {history?.memberships?.length ? (
                    history.memberships.map((membership) => (
                      <div key={membership.id} className="rounded-lg border p-3 text-xs">
                        <div className="font-semibold">{membership.fullName}</div>
                        <div className="mt-1 text-muted-foreground">
                          {membership.effectiveFrom} → {membership.effectiveTo || "Current"}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="text-xs text-muted-foreground">No membership history.</div>
                  )}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

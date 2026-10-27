import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Factory, History, Plus, UserRound, Wrench, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { ContinuousPressingScanner } from "./ContinuousPressingScanner";
import { usePressingOfflineSync } from "./pressing-scanner/usePressingOfflineSync";
import PressingOfflineQueueStatus from "./PressingOfflineQueueStatus";
import PressingHistoryReport from "./PressingHistoryReport";
import PressingShiftAnalytics from "./PressingShiftAnalytics";
import { useCompany } from "@/contexts/CompanyContext";

const ROOT = "/api/factory/pressing-machines";
type Assignment = { id: number; machineId: number; userId: string; username: string | null; assignedAt: string };
type Machine = { id: number; machineCode: string; name: string; active: boolean; targetBalesPerHour: string | null };
type Operator = { id: string; username: string; role: string };
type Dashboard = { machines: Machine[]; assignments: Assignment[]; operators: Operator[] };
type MyMachine = {
  companyId: number;
  userId: string;
  canManage: boolean;
  assignment: null | { assignmentId: number; machineId: number; machineCode: string; machineName: string; machineActive: boolean; assignedAt: string };
};
type HistoricalAssignment = Assignment & {
  machineCode: string; machineName: string; assignedBy: string;
  unassignedAt: string | null; unassignedBy: string | null;
};
const formatted = (time: string) => new Date(time).toLocaleString();
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

function MachineManagerCard({
  machine, operators, assigned, busy, change,
}: {
  machine: Machine;
  operators: Operator[];
  assigned: Assignment[];
  busy: boolean;
  change: (url: string, payload: Record<string, unknown>) => void;
}) {
  const [name, setName] = useState(machine.name);
  const [operatorId, setOperatorId] = useState("");
  return (
    <Card data-testid={`pressing-machine-${machine.id}`}>
      <CardHeader className="space-y-1 pb-2">
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="text-base">{machine.machineCode}</CardTitle>
          <Badge variant={machine.active ? "default" : "secondary"}>
            {machine.active ? "Active" : "Inactive"}
          </Badge>
        </div>
        <p className="text-xs text-muted-foreground">Machine ID {machine.id}</p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input aria-label={`Machine ${machine.machineCode} name`} value={name}
            onChange={event => setName(event.target.value)} maxLength={160} disabled={busy} />
          <Button size="sm" variant="outline" disabled={busy || !name.trim() || name.trim() === machine.name}
            onClick={() => change(`${ROOT}/${machine.id}/update`, { name: name.trim() })}>Save</Button>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm text-muted-foreground">Assigned operators: {assigned.length}</span>
          <Button size="sm" variant="outline" disabled={busy}
            onClick={() => change(`${ROOT}/${machine.id}/update`, { active: !machine.active })}>
            {machine.active ? "Deactivate" : "Activate"}
          </Button>
        </div>
        {assigned.map(a => (
          <div key={a.id} className="flex items-center justify-between rounded-md border p-2 gap-2">
            <span className="min-w-0 truncate text-sm"><UserRound className="mr-1 inline h-4 w-4" />{a.username || a.userId}</span>
            <Button size="sm" variant="outline" disabled={busy}
              onClick={() => change(`${ROOT}/assignments/${a.id}/end`, {})}>Unassign</Button>
          </div>
        ))}
        {machine.active && (
          <div className="flex flex-col gap-2 sm:flex-row">
            <select aria-label={`Assign operator to ${machine.machineCode}`} value={operatorId}
              onChange={event => setOperatorId(event.target.value)} disabled={busy}
              className="min-h-10 w-full rounded-md border bg-background px-3 text-sm">
              <option value="">Select an employee...</option>
              {operators.map(op => <option key={op.id} value={op.id}>{op.username} ({op.role})</option>)}
            </select>
            <Button disabled={busy || !operatorId} onClick={() => {
              change(`${ROOT}/assignments`, { machineId: machine.id, userId: operatorId });
              setOperatorId("");
            }}>Assign</Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function PressingMachineManagement({ active }: { active: boolean }) {
  const { toast } = useToast();
  const { selectedCompany } = useCompany();
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const myQuery = useQuery<MyMachine>({
    queryKey: [ROOT, "me", selectedCompany?.id ?? null],
    queryFn: async () => {
      const response = await fetch(`${ROOT}/me`, { credentials: "include" });
      if (!response.ok) throw new Error("Could not load assigned pressing machine");
      return response.json();
    },
    staleTime: 0, gcTime: 0, enabled: selectedCompany !== null,
    refetchOnMount: "always", refetchOnWindowFocus: true,
  });
  const pressingQueue = usePressingOfflineSync(
    myQuery.data ? { companyId: myQuery.data.companyId, userId: myQuery.data.userId } : null,
    active,
  );
  const canManage = myQuery.data?.canManage === true;
  // Supervisor data is keyed by the authenticated company so switching
  // companies never paints another tenant's cached machines or employees.
  const scopedCompanyId = myQuery.data?.companyId ?? null;
  const dashboardQuery = useQuery<Dashboard>({
    queryKey: [ROOT, "dashboard", scopedCompanyId],
    enabled: canManage && scopedCompanyId !== null,
    queryFn: async () => {
      const response = await fetch(ROOT, { credentials: "include" });
      if (!response.ok) throw new Error("Could not load machine management");
      return response.json();
    },
    staleTime: 30_000, refetchOnWindowFocus: false,
  });
  const historyQuery = useQuery<HistoricalAssignment[]>({
    queryKey: [ROOT, "history", scopedCompanyId],
    enabled: canManage && showHistory && scopedCompanyId !== null,
    queryFn: async () => {
      const response = await fetch(`${ROOT}/history?limit=200`, { credentials: "include" });
      if (!response.ok) throw new Error("Could not load assignment history");
      return response.json();
    },
    staleTime: 30_000, refetchOnWindowFocus: false,
  });
  const mutation = useMutation({
    mutationFn: async ({ url, payload }: { url: string; payload: Record<string, unknown> }) => {
      const response = await apiRequest("POST", url, payload);
      if (!response.ok) throw new Error("Machine change failed");
      return response.json();
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: [ROOT, "me"] }),
        queryClient.invalidateQueries({ queryKey: [ROOT, "dashboard"] }),
        queryClient.invalidateQueries({ queryKey: [ROOT, "history"] }),
      ]);
      toast({ title: "Pressing machine settings saved" });
    },
    onError: error => toast({ title: "Could not save", description: errorText(error), variant: "destructive" }),
  });
  const change = (url: string, payload: Record<string, unknown>) => mutation.mutate({ url, payload });
  const dashboard = scopedCompanyId === selectedCompany?.id ? dashboardQuery.data : undefined;
  return (
    <div className="space-y-5" data-testid="pressing-machine-management">
      <div className="flex flex-wrap items-center gap-2">
        <Factory className="h-6 w-6 text-emerald-500" />
        <h2 className="text-xl font-bold">Pressing Machines</h2>
        <Badge variant="outline">Physical pressing only</Badge>
      </div>
      <p className="text-sm text-muted-foreground">
        Assign employees to a press and preserve their assignment history.
        Every accepted barcode confirms physical pressing and saves the machine, operator and server timestamp. Stock finalization stays separate.
      </p>
      {myQuery.isLoading && <p className="text-sm">Loading your machine...</p>}
      {myQuery.isError && <p role="alert" className="text-sm text-destructive">{errorText(myQuery.error)}</p>}
      {myQuery.data && (
        <Card>
          <CardHeader><CardTitle className="text-base">My assigned machine</CardTitle></CardHeader>
          <CardContent>
            {myQuery.data.assignment ? (
              <div className="space-y-1">
                <p className="font-semibold">{myQuery.data.assignment.machineCode} — {myQuery.data.assignment.machineName}</p>
                <p className="text-sm text-muted-foreground">Assigned {formatted(myQuery.data.assignment.assignedAt)}</p>
                <Badge variant={myQuery.data.assignment.machineActive ? "default" : "destructive"}>
                  {myQuery.data.assignment.machineActive ? "Ready for pressing confirmation" : "Inactive"}
                </Badge>
              </div>
            ) : <p className="text-sm text-muted-foreground">No machine assigned. Ask your supervisor for an assignment.</p>}
          </CardContent>
        </Card>
      )}
      <ContinuousPressingScanner
        active={active}
        assignment={myQuery.data?.assignment ?? null}
        onBarcode={pressingQueue.submit}
      />
      {myQuery.data && (
        <PressingOfflineQueueStatus snapshot={pressingQueue.snapshot} retryNow={pressingQueue.retryNow} />
      )}
      {myQuery.data && myQuery.data.companyId === selectedCompany?.id && (
        <PressingShiftAnalytics
          key={"shift:" + myQuery.data.companyId + ":" + myQuery.data.userId}
          active={active} companyId={myQuery.data.companyId}
          userId={myQuery.data.userId} canManage={canManage}
        />
      )}
      {myQuery.data && myQuery.data.companyId === selectedCompany?.id && (
        <PressingHistoryReport
          key={myQuery.data.companyId + ":" + myQuery.data.userId}
          active={active}
          companyId={myQuery.data.companyId}
          userId={myQuery.data.userId}
        />
      )}
      {canManage && (
        <>
          <Card>
            <CardHeader><CardTitle className="text-base"><ShieldCheck className="mr-2 inline h-5 w-5" />Supervisor controls</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Input aria-label="New machine code" placeholder="Machine code (PRESS-01)" value={code}
                  maxLength={60} disabled={mutation.isPending} onChange={e => setCode(e.target.value)} />
                <Input aria-label="New machine name" placeholder="Machine name" value={name}
                  maxLength={160} disabled={mutation.isPending} onChange={e => setName(e.target.value)} />
              </div>
              <Button disabled={mutation.isPending || !code.trim() || !name.trim()}
                onClick={() => {
                  change(ROOT, { machineCode: code.trim(), name: name.trim() });
                  setCode(""); setName("");
                }}>
                <Plus className="mr-2 h-4 w-4" /> Add pressing machine
              </Button>
            </CardContent>
          </Card>
          {dashboardQuery.isError && <p role="alert" className="text-sm text-destructive">{errorText(dashboardQuery.error)}</p>}
          {dashboardQuery.isLoading && <p className="text-sm">Loading machines and employees...</p>}
          {dashboard && (
            <div className="grid gap-3 lg:grid-cols-2">
              {dashboard.machines.map(machine => (
                <MachineManagerCard key={machine.id} machine={machine} operators={dashboard.operators}
                  assigned={dashboard.assignments.filter(a => a.machineId === machine.id)}
                  change={change} busy={mutation.isPending} />
              ))}
              {dashboard.machines.length === 0 && <p className="text-sm text-muted-foreground">No machines created yet.</p>}
            </div>
          )}
          <div className="space-y-3">
            <Button variant="outline" onClick={() => setShowHistory(x => !x)}>
              <History className="mr-2 h-4 w-4" />{showHistory ? "Hide assignment history" : "View assignment history"}
            </Button>
            {showHistory && (
              <div className="overflow-x-auto rounded-lg border">
                {historyQuery.isLoading && <p className="p-3 text-sm">Loading history...</p>}
                {historyQuery.isError && <p className="p-3 text-sm text-destructive">{errorText(historyQuery.error)}</p>}
                {historyQuery.data && (
                  <table className="w-full min-w-[650px] text-left text-sm">
                    <thead className="bg-muted">
                      <tr><th className="p-2">Machine</th><th className="p-2">Employee</th>
                        <th className="p-2">Assigned</th><th className="p-2">Ended</th><th className="p-2">Status</th></tr>
                    </thead>
                    <tbody>
                      {historyQuery.data.map(row => (
                        <tr key={row.id} className="border-t">
                          <td className="p-2">{row.machineCode} — {row.machineName}</td>
                          <td className="p-2">{row.username || row.userId}</td>
                          <td className="p-2">{formatted(row.assignedAt)}</td>
                          <td className="p-2">{row.unassignedAt ? formatted(row.unassignedAt) : "—"}</td>
                          <td className="p-2">{row.unassignedAt ? "Ended" : "Active"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </>
      )}
      <p className="text-xs text-muted-foreground"><Wrench className="mr-1 inline h-3 w-3" />Physical pressing scans do not automatically finalize stock.</p>
    </div>
  );
}

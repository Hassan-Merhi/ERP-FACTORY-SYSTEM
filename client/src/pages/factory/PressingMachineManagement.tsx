import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Camera, ChevronDown, ChevronUp, ScanLine, CheckCircle2, AlertCircle, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useCompany } from "@/contexts/CompanyContext";
import { ContinuousPressingScanner, type PressingScanOutcome } from "./ContinuousPressingScanner";
import { usePressingOfflineSync } from "./pressing-scanner/usePressingOfflineSync";
import PressingOfflineQueueStatus from "./PressingOfflineQueueStatus";
import PressingHistoryReport from "./PressingHistoryReport";
import PressingWorkerTotals from "./PressingWorkerTotals";
import PressingHourlyTargets from "./PressingHourlyTargets";

const ROOT = "/api/factory/pressing-machines";
type Assignment = {
  assignmentId: number; machineId: number; machineCode: string;
  machineName: string; machineActive: boolean; assignedAt: string;
};
type MyAccess = {
  companyId: number; userId: string; canManage: boolean; assignment: Assignment | null;
};
const problem = (error: unknown) => error instanceof Error ? error.message : "Unable to open pressing scan";

export default function PressingMachineManagement({ active }: { active: boolean }) {
  const { selectedCompany } = useCompany();
  const { toast } = useToast();
  const [barcode, setBarcode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [last, setLast] = useState<{ barcode: string; outcome: PressingScanOutcome } | null>(null);
  const [showCamera, setShowCamera] = useState(false);
  const [showSync, setShowSync] = useState(false);
  const [activationError, setActivationError] = useState("");
  const activating = useRef<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const access = useQuery<MyAccess>({
    queryKey: [ROOT, "me", selectedCompany?.id ?? null],
    queryFn: async () => {
      const response = await fetch(ROOT + "/me", { credentials: "include", cache: "no-store" });
      if (!response.ok) throw new Error("Pressing access is not available for this user");
      return response.json() as Promise<MyAccess>;
    },
    enabled: active && selectedCompany !== null,
    staleTime: 0, gcTime: 0, refetchOnMount: "always",
    refetchOnWindowFocus: false,
  });
  const companyId = access.data?.companyId;
  const userId = access.data?.userId;
  const validCompany = companyId === selectedCompany?.id;
  const assignment = validCompany ? access.data?.assignment ?? null : null;
  const fullControls = validCompany && access.data?.canManage === true;
  const scanner = usePressingOfflineSync(
    active && validCompany && companyId !== undefined && userId
      ? { companyId, userId } : null, active,
  );

  const activate = useCallback(async () => {
    if (!active || !validCompany || !access.data || assignment) return;
    const key = String(companyId) + ":" + String(userId);
    if (activating.current === key) return;
    activating.current = key;
    setActivationError("");
    try {
      // The page/tab permission is checked by Factory middleware. This
      // creates an internal station and assignment, not a user-facing machine.
      await apiRequest("POST", ROOT + "/activate", {});
      await queryClient.invalidateQueries({ queryKey: [ROOT, "me", selectedCompany?.id ?? null] });
    } catch (error) {
      setActivationError(problem(error));
    }
  }, [active, validCompany, access.data, assignment, companyId, userId, selectedCompany?.id]);

  useEffect(() => {
    if (active && access.data && validCompany && !assignment) void activate();
  }, [active, access.data, validCompany, assignment, activate]);

  useEffect(() => {
    activating.current = null;
    setBarcode("");
    setLast(null);
    setActivationError("");
  }, [selectedCompany?.id]);

  useEffect(() => {
    if (active && assignment && !showCamera) inputRef.current?.focus();
  }, [active, assignment, showCamera]);

  const scanOne = async (code: string) => {
    const value = code.trim().toUpperCase();
    if (!value || !assignment || submitting || !active) return;
    setSubmitting(true);
    setBarcode("");
    try {
      const outcome = await scanner.submit({
        barcode: value,
        deviceCapturedAt: new Date().toISOString(),
        machineId: assignment.machineId,
        assignmentId: assignment.assignmentId,
      });
      setLast({ barcode: value, outcome });
      if (outcome.kind === "confirmed") {
        void queryClient.invalidateQueries({ queryKey: [ROOT + "/report"] });
        toast({ title: "Bale scanned", description: value + " — pressing recorded" });
      } else if (outcome.kind === "duplicate" || outcome.kind === "rejected") {
        toast({ title: "Scan not accepted", description: outcome.message, variant: "destructive" });
      }
    } finally {
      setSubmitting(false);
      inputRef.current?.focus();
    }
  };
  const cameraRead = async (capture: Parameters<typeof scanner.submit>[0]) => {
    const result = await scanner.submit(capture);
    setLast({ barcode: capture.barcode, outcome: result });
    if (result.kind === "confirmed") {
      void queryClient.invalidateQueries({ queryKey: [ROOT + "/report"] });
    }
    return result;
  };
  const outstanding = scanner.snapshot.pending + scanner.snapshot.syncing;

  return (
    <div className="min-w-0 space-y-4" data-testid="pressing-machine-management">
      <div className="flex flex-wrap items-center gap-2">
        <ScanLine className="h-5 w-5 text-emerald-500" />
        <h2 className="text-lg font-semibold">Pressing Scan</h2>
        {fullControls && <Badge variant="secondary">Recorded by logged-in user</Badge>}
      </div>

      {access.isLoading && <p className="text-sm">Checking pressing access…</p>}
      {access.isError && <p className="text-sm text-destructive" role="alert">{problem(access.error)}</p>}
      {!assignment && !access.isLoading && !access.isError && (
        <div className="rounded-md border p-3 text-sm">
          {activationError ? (
            <>
              <p role="alert" className="text-destructive">{activationError}</p>
              <Button size="sm" className="mt-2" variant="outline" onClick={() => {
                activating.current = null;
                void activate();
              }}>Retry access setup</Button>
            </>
          ) : "Preparing your pressing scanner…"}
        </div>
      )}

      <div className="rounded-lg border bg-card p-3 space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          {fullControls && <><div className="relative min-w-0 flex-1">
            <ScanLine className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input ref={inputRef} autoComplete="off" data-testid="input-pressing-scan"
              className="h-11 pl-10 font-mono" placeholder="Scan bale reference / barcode..."
              value={barcode} onChange={e => setBarcode(e.target.value)}
              onKeyDown={e => { if (e.key === "Enter") { e.preventDefault(); void scanOne(barcode); } }}
              disabled={!assignment || !active || submitting} />
          </div>
          <Button data-testid="button-pressing-scan" className="h-11" disabled={!barcode.trim() || !assignment || submitting}
            onClick={() => void scanOne(barcode)}>
            <ScanLine className="mr-2 h-4 w-4" />
            {submitting ? "Saving…" : "Scan"}
          </Button></>}
          <Button data-testid="button-pressing-camera" className={fullControls ? "h-11" : "h-12 w-full sm:w-auto"} variant={showCamera ? "destructive" : "default"} onClick={() => setShowCamera(v => !v)}
            disabled={!assignment}>
            <Camera className="mr-2 h-4 w-4" />{showCamera ? "Close Camera" : "Open Camera"}
          </Button>
        </div>
        {fullControls && last && (
          <div className={"rounded-md border p-3 text-sm " +
            (last.outcome.kind === "confirmed" ? "border-emerald-500/50 bg-emerald-500/10" :
              last.outcome.kind === "queued" ? "border-amber-500/50 bg-amber-500/10" :
              "border-red-500/50 bg-red-500/10")} role="status">
            {last.outcome.kind === "confirmed"
              ? <CheckCircle2 className="mr-2 inline h-4 w-4 text-emerald-600" />
              : <AlertCircle className="mr-2 inline h-4 w-4" />}
            <strong>{last.barcode}</strong> — {last.outcome.message}
          </div>
        )}
        {fullControls && outstanding > 0 && (
          <p className="text-sm text-amber-700 dark:text-amber-300" role="status">
            {outstanding} scan{outstanding === 1 ? "" : "s"} saved locally, waiting for server verification.
          </p>
        )}
        {fullControls && <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="ghost" onClick={() => setShowSync(v => !v)}>
            {showSync ? <ChevronUp className="mr-1 h-4 w-4" /> : <ChevronDown className="mr-1 h-4 w-4" />}
            Scan sync {outstanding ? "(" + outstanding + " pending)" : ""}
          </Button>
          {outstanding > 0 && <Button size="sm" variant="outline"
            onClick={() => void scanner.retryNow()}>
            <RefreshCw className="mr-1 h-4 w-4" />Retry
          </Button>}
        </div>}
      </div>
      {showCamera && assignment && (
        <ContinuousPressingScanner active={active} assignment={assignment} onBarcode={cameraRead} simpleControls={!fullControls} />
      )}
      {fullControls && showSync && <PressingOfflineQueueStatus snapshot={scanner.snapshot}
        retryNow={scanner.retryNow} />}

      {active && validCompany && companyId !== undefined && userId && (
        fullControls
          ? <PressingHistoryReport key={companyId + ":" + userId}
              active={active} companyId={companyId} userId={userId} />
          : assignment
            ? <div key={companyId + ":" + userId} className="min-w-0 space-y-4">
                <PressingWorkerTotals active={active} companyId={companyId} userId={userId} />
                <PressingHourlyTargets active={active} companyId={companyId} />
              </div>
            : null
      )}
    </div>
  );
}

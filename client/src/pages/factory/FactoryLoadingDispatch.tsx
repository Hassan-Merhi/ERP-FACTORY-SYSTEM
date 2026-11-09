/**
 * Phase 2 — truck-trip management for one existing Factory loading order.
 * Verification-only: displays main-loading totals but never writes to the
 * main loading, stock, proforma, invoice or accounting endpoints.
 *
 * Phase 3 provides physical scan verification; Phase 4 comparison; Phase 6 close/reopen.
 */
import { useMemo, useState, type FormEvent } from "react";
import { useLocation, useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  ArrowLeft, ArrowRight, ClipboardCheck, Clock3, Edit3, FileSearch,
  Loader2, Package, Plus, RefreshCw, Route, ShieldCheck, Truck,
  Weight,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { TabsList, PillTabButton } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { apiRequest, queryClient } from "@/lib/queryClient";
import FactoryLoadingDispatchScanner from "./FactoryLoadingDispatchScanner";
import FactoryLoadingDispatchAllocation from "./FactoryLoadingDispatchAllocation";
import FactoryLoadingDispatchLifecycle from "./FactoryLoadingDispatchLifecycle";

interface OrderBale {
  id: number;
  baleId: number;
  weight: string | number;
}
interface LoadingOrder {
  id: number;
  status: string;
  customerName?: string | null;
  containerNumber?: string | null;
  bales: OrderBale[];
}
type TripStatus = "OPEN" | "CLOSED" | "CANCELLED";
interface DispatchTrip {
  id: number;
  orderId: number;
  dispatchNumber: number;
  status: TripStatus;
  containerNumberSnapshot?: string | null;
  truckPlate: string | null;
  driverName: string | null;
  destination: string | null;
  notes: string | null;
  createdAt: string;
  createdByUsername?: string;
  updatedAt?: string;
  closedAt?: string | null;
  scannedBales?: number | string;
  scannedWeightKg?: number | string;
}
interface DispatchList {
  orderId: number;
  containerNumber: string | null;
  dispatches: DispatchTrip[];
}
interface TripForm {
  truckPlate: string;
  driverName: string;
  destination: string;
  notes: string;
}
type TripFilter = "all" | "open" | "closed";

const blankForm: TripForm = { truckPlate: "", driverName: "", destination: "", notes: "" };
const activeOrderStatuses = new Set(["DRAFT", "LOADING", "PENDING_VERIFICATION"]);

function tripPath(orderId: number, dispatchId?: number): string {
  return "/factory/sales/loading/dispatch/" + orderId + (dispatchId ? "/" + dispatchId : "");
}

function numberValue(raw: number | string | undefined): number {
  const n = Number(raw ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function printNumber(n: number, digits = 0): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new Error(body?.message || "Unable to load dispatch information");
  }
  return response.json() as Promise<T>;
}

function getError(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred";
}

function fromTrip(trip: DispatchTrip): TripForm {
  return {
    truckPlate: trip.truckPlate ?? "",
    driverName: trip.driverName ?? "",
    destination: trip.destination ?? "",
    notes: trip.notes ?? "",
  };
}

function TripStatusBadge({ status }: { status: TripStatus }) {
  const statusStyle =
    status === "OPEN"
      ? "border-blue-300 bg-blue-50 text-blue-700 dark:border-blue-500/30 dark:bg-blue-500/15 dark:text-blue-200"
      : status === "CLOSED"
        ? "border-emerald-300 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-200"
        : "border-red-300 bg-red-50 text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200";
  return <Badge variant="outline" className={statusStyle}>{status === "OPEN" ? "Open" : status === "CLOSED" ? "Closed" : "Cancelled"}</Badge>;
}

function StatCard({ label, value, unit, icon: Icon }: {
  label: string;
  value: string;
  unit?: string;
  icon: typeof Package;
}) {
  return (
    <Card className="border-slate-200/90 bg-white/90 dark:border-blue-500/20 dark:bg-[#101c34]">
      <CardContent className="flex items-center justify-between gap-2 p-3 sm:p-4">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
          <p className="mt-1 font-mono text-xl font-bold tracking-tight sm:text-2xl" data-testid={"stat-" + label.toLowerCase().replace(/\s+/g, "-")}>
            {value} {unit && <span className="text-xs font-normal text-muted-foreground">{unit}</span>}
          </p>
        </div>
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600 dark:bg-blue-500/15 dark:text-sky-300">
          <Icon className="h-4 w-4" />
        </div>
      </CardContent>
    </Card>
  );
}

function TripEditor({ open, onOpenChange, value, onChange, onSubmit, title, submitLabel, busy }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: TripForm;
  onChange: (next: TripForm) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  title: string;
  submitLabel: string;
  busy: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Each trip has a separate record for this loading. Truck and driver details are optional.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={onSubmit} className="space-y-4" data-testid="dispatch-trip-form">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="dispatch-truck-plate">Truck number / plate</Label>
              <Input id="dispatch-truck-plate" maxLength={120} value={value.truckPlate}
                placeholder="e.g. Truck 01" onChange={(e) => onChange({ ...value, truckPlate: e.target.value })} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="dispatch-driver-name">Driver</Label>
              <Input id="dispatch-driver-name" maxLength={200} value={value.driverName}
                placeholder="Driver name" onChange={(e) => onChange({ ...value, driverName: e.target.value })} />
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dispatch-destination">Destination</Label>
            <Input id="dispatch-destination" maxLength={500} value={value.destination}
              placeholder="Truck destination" onChange={(e) => onChange({ ...value, destination: e.target.value })} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="dispatch-notes">Notes</Label>
            <Textarea id="dispatch-notes" maxLength={3000} rows={3} value={value.notes}
              placeholder="Optional instructions or loading notes"
              onChange={(e) => onChange({ ...value, notes: e.target.value })} />
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button>
            <Button type="submit" disabled={busy} data-testid="button-save-dispatch">
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function FactoryLoadingDispatch() {
  const { orderId: orderIdText, dispatchId: dispatchIdText } = useParams<{ orderId: string; dispatchId?: string }>();
  const orderId = Number(orderIdText);
  const dispatchId = dispatchIdText ? Number(dispatchIdText) : null;
  const validOrder = Number.isSafeInteger(orderId) && orderId > 0;
  const validDispatch = dispatchId === null || (Number.isSafeInteger(dispatchId) && dispatchId > 0);

  const [, navigate] = useLocation();
  const { toast } = useToast();
  const { formatDisplayDateTime } = useDateFormat();
  const [filter, setFilter] = useState<TripFilter>("all");
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [newTrip, setNewTrip] = useState<TripForm>(blankForm);
  const [editTrip, setEditTrip] = useState<TripForm>(blankForm);

  const { data: user } = useQuery<{ currentCompanyId?: number | null; currentRole?: string | null; role?: string | null }>({
    queryKey: ["/api/auth/me"],
  });
  const companyId = user?.currentCompanyId;
  const listUrl = "/api/factory/customer-orders/" + orderId + "/loading-dispatches";
  const orderUrl = "/api/factory/customer-orders/" + orderId;
  const selectedUrl = dispatchId ? listUrl + "/" + dispatchId : null;

  const tripsQuery = useQuery<DispatchList>({
    queryKey: companyQueryKey(listUrl, companyId),
    queryFn: () => getJson<DispatchList>(listUrl),
    enabled: validOrder && Boolean(companyId),
    refetchInterval: 15000,
  });
  const orderQuery = useQuery<LoadingOrder>({
    queryKey: companyQueryKey(orderUrl, companyId),
    queryFn: () => getJson<LoadingOrder>(orderUrl),
    enabled: validOrder && Boolean(companyId),
    refetchInterval: 15000,
  });
  const selectedQuery = useQuery<DispatchTrip>({
    queryKey: companyQueryKey(selectedUrl ?? listUrl, companyId),
    queryFn: () => getJson<DispatchTrip>(selectedUrl!),
    enabled: validOrder && validDispatch && Boolean(selectedUrl) && Boolean(companyId),
    refetchInterval: 15000,
  });

  const canEdit = !["View Only", "Create Only"].includes(user?.currentRole ?? user?.role ?? "");
  const canCreate = canEdit && activeOrderStatuses.has(orderQuery.data?.status ?? "");

  const trips = tripsQuery.data?.dispatches ?? [];
  const loadedQty = orderQuery.data?.bales?.length ?? 0;
  const loadedWeight = (orderQuery.data?.bales ?? []).reduce((sum, bale) => sum + numberValue(bale.weight), 0);
  const verifiedQty = trips.reduce((sum, trip) => sum + numberValue(trip.scannedBales), 0);
  const verifiedWeight = trips.reduce((sum, trip) => sum + numberValue(trip.scannedWeightKg), 0);
  const remainingQty = Math.max(0, loadedQty - verifiedQty);
  const openTrips = trips.filter((trip) => trip.status === "OPEN").length;
  const completion = loadedQty > 0 ? Math.min(100, Math.round((verifiedQty / loadedQty) * 100)) : 0;

  const visibleTrips = useMemo(() => trips.filter((trip) => (
    filter === "all" || (filter === "open" ? trip.status === "OPEN" : trip.status !== "OPEN")
  )), [trips, filter]);
  const selectedTrip = selectedQuery.data ??
    trips.find((trip) => Number(trip.id) === dispatchId) ?? null;

  const refresh = async () => {
    await Promise.all([
      tripsQuery.refetch(),
      orderQuery.refetch(),
      ...(dispatchId ? [selectedQuery.refetch()] : []),
    ]);
  };

  const createMutation = useMutation({
    mutationFn: async (form: TripForm) => {
      const response = await apiRequest("POST", listUrl, form);
      return response.json() as Promise<DispatchTrip>;
    },
    onSuccess: (trip) => {
      setCreateOpen(false);
      setNewTrip(blankForm);
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(listUrl, companyId) });
      toast({ title: "Dispatch created", description: "Trip #" + trip.dispatchNumber + " is now open for verification." });
      navigate(tripPath(orderId, trip.id));
    },
    onError: (error) => toast({ title: "Could not create dispatch", description: getError(error), variant: "destructive" }),
  });

  const editMutation = useMutation({
    mutationFn: async (form: TripForm) => {
      if (!selectedUrl) throw new Error("Choose a dispatch to edit");
      const response = await apiRequest("PATCH", selectedUrl, form);
      return response.json() as Promise<DispatchTrip>;
    },
    onSuccess: () => {
      setEditOpen(false);
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(listUrl, companyId) });
      if (selectedUrl) void queryClient.invalidateQueries({ queryKey: companyQueryKey(selectedUrl, companyId) });
      toast({ title: "Dispatch details saved" });
    },
    onError: (error) => toast({ title: "Could not save changes", description: getError(error), variant: "destructive" }),
  });

  const backToLoading = () => navigate("/factory/sales/loading/new?orderId=" + orderId);

  if (!validOrder || !validDispatch) {
    return <div className="p-6 text-sm text-destructive">Invalid loading order or dispatch ID.</div>;
  }

  return (
    <div className="flex h-full min-w-0 flex-col overflow-y-auto bg-slate-50/70 dark:bg-[#080f1c]" data-testid="factory-loading-dispatch-page">
      <div className="mx-auto w-full max-w-[1480px] space-y-5 p-3 pb-10 sm:p-5 lg:p-7">
        <div className="relative overflow-hidden rounded-[22px] border border-blue-200/80 bg-gradient-to-r from-white via-blue-50/90 to-sky-100/80 p-4 shadow-sm dark:border-blue-500/25 dark:from-[#12213e] dark:via-[#102448] dark:to-[#092853] sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-3">
              <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-600 text-white shadow-lg shadow-blue-500/20">
                <Truck className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-lg font-bold tracking-tight sm:text-xl">Dispatch Management</h1>
                  <Badge variant="secondary">Loading #{orderId}</Badge>
                  {orderQuery.data?.containerNumber && <Badge variant="outline">{orderQuery.data.containerNumber}</Badge>}
                </div>
                <p className="mt-1 text-xs text-muted-foreground sm:text-sm">
                  Verify truck trips independently from your main loading record.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="outline" onClick={backToLoading} data-testid="button-return-to-loading">
                <ArrowLeft className="mr-1.5 h-4 w-4" /> Loading
              </Button>
              <Button size="sm" variant="outline" onClick={() => navigate("/factory/sales/loading/dispatch/" + orderId + "/compare")} data-testid="button-compare-all-dispatches">
                <FileSearch className="mr-1.5 h-4 w-4" /> Compare All
              </Button>
              <Button size="sm" variant="outline" onClick={() => void refresh()} disabled={tripsQuery.isFetching || orderQuery.isFetching} data-testid="button-refresh-dispatch">
                <RefreshCw className="mr-1.5 h-4 w-4" /> Refresh
              </Button>
              {canCreate && (
                <Button size="sm" onClick={() => { setNewTrip(blankForm); setCreateOpen(true); }} data-testid="button-new-dispatch">
                  <Plus className="mr-1.5 h-4 w-4" /> New Dispatch
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="flex items-start gap-2 rounded-xl border border-indigo-200 bg-indigo-50/80 p-3 text-xs text-indigo-900 dark:border-indigo-500/25 dark:bg-indigo-500/10 dark:text-indigo-100">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <span className="font-semibold">Verification only.</span> A Dispatch never adds bales to Loading,
            changes inventory or posts financial transactions. Only unique bales from this loading may be verified on trucks.
          </div>
        </div>

        {(tripsQuery.isError || orderQuery.isError) && (
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-950/30">
            <span>{getError(tripsQuery.error ?? orderQuery.error)}</span>
            <Button size="sm" variant="outline" onClick={() => void refresh()}>Retry</Button>
          </div>
        )}

        <div className="grid gap-3 grid-cols-2 xl:grid-cols-4">
          <StatCard label="Loaded bales" value={printNumber(loadedQty)} icon={Package} />
          <StatCard label="Verified on trips" value={printNumber(verifiedQty)} icon={ClipboardCheck} />
          <StatCard label="Not yet verified" value={printNumber(remainingQty)} icon={FileSearch} />
          <StatCard label="Open dispatches" value={printNumber(openTrips)} icon={Truck} />
        </div>

        <Card className="border-blue-100 bg-white dark:border-blue-500/20 dark:bg-[#101c34]">
          <CardContent className="space-y-3 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-semibold">Overall truck verification</span>
              <span className="font-mono text-sm font-bold">{completion}%</span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-700">
              <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: completion + "%" }} />
            </div>
            <div className="flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
              <span>Loading: {printNumber(loadedQty)} bales · {printNumber(loadedWeight, 2)} kg</span>
              <span>Truck verified: {printNumber(verifiedQty)} bales · {printNumber(verifiedWeight, 2)} kg</span>
            </div>
          </CardContent>
        </Card>

        {dispatchId === null ? (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold">Truck trips</h2>
                <p className="text-xs text-muted-foreground">Each trip has its own record, operator and status.</p>
              </div>
              <TabsList className="w-max" aria-label="Dispatch status filter">
                <PillTabButton selected={filter === "all"} onClick={() => setFilter("all")}>All ({trips.length})</PillTabButton>
                <PillTabButton selected={filter === "open"} onClick={() => setFilter("open")}>Open ({openTrips})</PillTabButton>
                <PillTabButton selected={filter === "closed"} onClick={() => setFilter("closed")}>Finished ({trips.length - openTrips})</PillTabButton>
              </TabsList>
            </div>
            {tripsQuery.isPending && <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading dispatch records…</div>}
            {!tripsQuery.isPending && tripsQuery.isSuccess && visibleTrips.length === 0 && (
              <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-blue-200 bg-white/80 p-10 text-center dark:border-blue-500/25 dark:bg-[#101c34]">
                <Truck className="h-9 w-9 text-blue-500" />
                <p className="font-semibold">{trips.length === 0 ? "No dispatch trips yet" : "No dispatches match this filter"}</p>
                <p className="max-w-sm text-sm text-muted-foreground">
                  {trips.length === 0
                    ? "Create a dispatch for the first truck. Every additional trip will be tracked separately."
                    : "Try another status filter to see the other trips."}
                </p>
                {canCreate && trips.length === 0 && <Button onClick={() => setCreateOpen(true)}><Plus className="mr-2 h-4 w-4" />Create first dispatch</Button>}
              </div>
            )}
            <div className="grid gap-3 lg:grid-cols-2">
              {visibleTrips.map((trip) => (
                <button type="button" key={trip.id} onClick={() => navigate(tripPath(orderId, trip.id))}
                  className="group rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm transition-colors hover:border-blue-400 hover:bg-blue-50/30 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-500 dark:border-blue-500/20 dark:bg-[#101c34] dark:hover:border-blue-400"
                  data-testid={"dispatch-trip-" + trip.id}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <div className="rounded-lg bg-blue-50 p-2 text-blue-600 dark:bg-blue-500/15 dark:text-sky-300"><Truck className="h-4 w-4" /></div>
                      <div>
                        <h3 className="text-sm font-bold">Dispatch #{String(trip.dispatchNumber).padStart(3, "0")}</h3>
                        <p className="text-xs text-muted-foreground">{trip.truckPlate || "Truck not assigned"}</p>
                      </div>
                    </div>
                    <TripStatusBadge status={trip.status} />
                  </div>
                  <div className="mt-4 grid grid-cols-2 gap-2 rounded-xl bg-slate-50 p-3 dark:bg-[#0b162a]">
                    <div><p className="text-[11px] text-muted-foreground">Bales verified</p><p className="font-mono font-bold">{printNumber(numberValue(trip.scannedBales))}</p></div>
                    <div><p className="text-[11px] text-muted-foreground">Verified kg</p><p className="font-mono font-bold">{printNumber(numberValue(trip.scannedWeightKg), 2)}</p></div>
                  </div>
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                    <span>{trip.driverName || trip.createdByUsername || "No driver set"}</span>
                    <span className="flex items-center gap-1">{formatDisplayDateTime(trip.createdAt)} <ArrowRight className="h-3.5 w-3.5 text-blue-500" /></span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <Button size="sm" variant="ghost" onClick={() => navigate(tripPath(orderId))} data-testid="button-dispatch-back">
              <ArrowLeft className="mr-1.5 h-4 w-4" /> All dispatches
            </Button>
            {selectedQuery.isPending && !selectedTrip && (
              <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading trip details…</div>
            )}
            {selectedQuery.isError && (
              <div className="rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/30">
                {getError(selectedQuery.error)}
              </div>
            )}
            {selectedTrip && dispatchId !== null && (
              <div className="grid gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(290px,0.7fr)]">
                <Card className="border-blue-100 dark:border-blue-500/20 dark:bg-[#101c34]">
                  <CardContent className="space-y-5 p-4 sm:p-5">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h2 className="text-lg font-bold">Dispatch #{String(selectedTrip.dispatchNumber).padStart(3, "0")}</h2>
                          <TripStatusBadge status={selectedTrip.status} />
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          Opened {formatDisplayDateTime(selectedTrip.createdAt)} by {selectedTrip.createdByUsername || "Unknown"}
                        </p>
                      </div>
                      {canEdit && selectedTrip.status === "OPEN" && (
                        <Button size="sm" variant="outline" onClick={() => { setEditTrip(fromTrip(selectedTrip)); setEditOpen(true); }} data-testid="button-edit-dispatch">
                          <Edit3 className="mr-1.5 h-4 w-4" /> Edit details
                        </Button>
                      )}
                    </div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {([
                        ["Truck", selectedTrip.truckPlate || "Not assigned"],
                        ["Driver", selectedTrip.driverName || "Not assigned"],
                        ["Destination", selectedTrip.destination || "Not assigned"],
                        ["Container", selectedTrip.containerNumberSnapshot || tripsQuery.data?.containerNumber || "Not assigned"],
                      ] as const).map(([label, value]) => (
                        <div key={label} className="min-w-0 rounded-xl border border-slate-200 p-3 dark:border-slate-700">
                          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
                          <p className="mt-1 break-words text-sm font-semibold">{value}</p>
                        </div>
                      ))}
                    </div>
                    {selectedTrip.notes && (
                      <div className="rounded-xl bg-slate-50 p-3 dark:bg-[#0b162a]">
                        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Notes</p>
                        <p className="mt-1 whitespace-pre-wrap text-sm">{selectedTrip.notes}</p>
                      </div>
                    )}
                    <div className="flex flex-wrap gap-3 border-t pt-4 text-xs text-muted-foreground">
                      <span className="flex items-center gap-1"><Package className="h-3.5 w-3.5" /> {printNumber(numberValue(selectedTrip.scannedBales ?? trips.find((trip) => Number(trip.id) === dispatchId)?.scannedBales))} scans</span>
                      <span className="flex items-center gap-1"><Weight className="h-3.5 w-3.5" /> {printNumber(numberValue(selectedTrip.scannedWeightKg ?? trips.find((trip) => Number(trip.id) === dispatchId)?.scannedWeightKg), 2)} kg</span>
                      <span className="flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" /> {selectedTrip.status === "OPEN" ? "Barcode verification active" : "Trip finished"}</span>
                    </div>
                  </CardContent>
                </Card>
                <div className="space-y-3">
                  <Card className="border-blue-100 dark:border-blue-500/20 dark:bg-[#101c34]">
                    <CardContent className="space-y-3 p-4">
                      <div className="flex items-center gap-2"><Route className="h-4 w-4 text-blue-500" /><h3 className="text-sm font-semibold">Truck verification</h3></div>
                      <p className="text-xs text-muted-foreground">Use the scanner below for each bale entering this truck. Scans never change the main loading.</p>
                      <Badge variant="secondary">Scanner available below</Badge>
                    </CardContent>
                  </Card>
                  <Card className="border-blue-100 dark:border-blue-500/20 dark:bg-[#101c34]">
                    <CardContent className="space-y-3 p-4">
                      <div className="flex items-center gap-2"><FileSearch className="h-4 w-4 text-blue-500" /><h3 className="text-sm font-semibold">Trip comparison</h3></div>
                      <p className="text-xs text-muted-foreground">Compare the expected truck load configured below against physically scanned barcodes, missing references and KG differences.</p>
                      <Button type="button" size="sm" variant="outline" className="w-full justify-between"
                        onClick={() => navigate("/factory/sales/loading/dispatch/" + orderId + "/" + dispatchId + "/compare")}
                        data-testid="button-compare-dispatch">
                        Compare this trip <ArrowRight className="h-4 w-4" />
                      </Button>
                    </CardContent>
                  </Card>
                  <FactoryLoadingDispatchLifecycle
                    key={dispatchId}
                    orderId={orderId}
                    dispatchId={dispatchId}
                    companyId={companyId}
                    status={selectedTrip.status}
                    role={user?.currentRole ?? user?.role ?? ""}
                    onChanged={() => {
                      void queryClient.invalidateQueries({ queryKey: companyQueryKey(listUrl, companyId) });
                      if (selectedUrl) void queryClient.invalidateQueries({ queryKey: companyQueryKey(selectedUrl, companyId) });
                    }}
                  />
                </div>
                <div className="xl:col-span-2">
                  <FactoryLoadingDispatchAllocation
                    orderId={orderId}
                    dispatchId={dispatchId}
                    companyId={companyId}
                    status={selectedTrip.status}
                    role={user?.currentRole ?? user?.role ?? ""}
                    onChanged={() => {
                      void queryClient.invalidateQueries({ queryKey: companyQueryKey(listUrl, companyId) });
                      if (selectedUrl) void queryClient.invalidateQueries({ queryKey: companyQueryKey(selectedUrl, companyId) });
                    }}
                  />
                </div>
                <div className="xl:col-span-2">
                  <FactoryLoadingDispatchScanner
                    key={dispatchId}
                    orderId={orderId}
                    dispatchId={dispatchId}
                    companyId={companyId}
                    status={selectedTrip.status}
                    role={user?.currentRole ?? user?.role ?? ""}
                    onChanged={() => {
                      void queryClient.invalidateQueries({ queryKey: companyQueryKey(listUrl, companyId) });
                      if (selectedUrl) void queryClient.invalidateQueries({ queryKey: companyQueryKey(selectedUrl, companyId) });
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4 text-xs text-muted-foreground dark:border-slate-700">
          <ShieldCheck className="h-4 w-4" /> Separate truck records · Same loading order · No stock or accounting changes
        </div>
      </div>

      <TripEditor open={createOpen} onOpenChange={(open) => { if (!createMutation.isPending) setCreateOpen(open); }}
        value={newTrip} onChange={setNewTrip} title="New truck dispatch" submitLabel="Create dispatch"
        busy={createMutation.isPending}
        onSubmit={(event) => { event.preventDefault(); if (canCreate) createMutation.mutate(newTrip); }} />
      <TripEditor open={editOpen} onOpenChange={(open) => { if (!editMutation.isPending) setEditOpen(open); }}
        value={editTrip} onChange={setEditTrip} title="Edit dispatch details" submitLabel="Save changes"
        busy={editMutation.isPending}
        onSubmit={(event) => { event.preventDefault(); if (canEdit && selectedTrip?.status === "OPEN") editMutation.mutate(editTrip); }} />
    </div>
  );
}

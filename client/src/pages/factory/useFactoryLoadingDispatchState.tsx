// Extracted from ./FactoryLoadingDispatch.tsx to keep that module under the source-size cap.
import { useMemo, useState } from "react";
import { useLocation, useParams } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Loader2, Plus, Truck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PillTabButton, TabsList } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { useDateFormat } from "@/contexts/DateFormatContext";
import { companyQueryKey } from "@/lib/companyQueryScope";
import { apiRequest, queryClient } from "@/lib/queryClient";
import {
  TripStatusBadge,
  activeOrderStatuses,
  blankForm,
  getError,
  getJson,
  numberValue,
  printNumber,
  tripPath,
  type DispatchList,
  type DispatchTrip,
  type LoadingOrder,
  type TripFilter,
  type TripForm,
} from "./FactoryLoadingDispatchTripEditor";

export function useFactoryLoadingDispatchState() {
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
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");
  const [newTrip, setNewTrip] = useState<TripForm>(blankForm);
  const [editTrip, setEditTrip] = useState<TripForm>(blankForm);

  const { data: user } = useQuery<{
    currentCompanyId?: number | null;
    currentRole?: string | null;
    role?: string | null;
  }>({
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

  const role = (user?.currentRole ?? user?.role ?? "").toLowerCase();
  const canViewFinancialDashboard = ["admin", "owner", "developer"].includes(role);
  const canDeleteDispatch = ["admin", "owner", "developer"].includes(role);
  const canEdit = !["View Only", "Create Only"].includes(user?.currentRole ?? user?.role ?? "");
  const canCreate = canEdit && activeOrderStatuses.has(orderQuery.data?.status ?? "");

  const trips = useMemo(() => tripsQuery.data?.dispatches ?? [], [tripsQuery.data?.dispatches]);
  const loadedQty = orderQuery.data?.bales?.length ?? 0;
  const loadedWeight = (orderQuery.data?.bales ?? []).reduce((sum, bale) => sum + numberValue(bale.weight), 0);
  const verifiedQty = trips.reduce((sum, trip) => sum + numberValue(trip.scannedBales), 0);
  const verifiedWeight = trips.reduce((sum, trip) => sum + numberValue(trip.scannedWeightKg), 0);
  const remainingQty = Math.max(0, loadedQty - verifiedQty);
  const openTrips = trips.filter((trip) => trip.status === "OPEN").length;
  const completion = loadedQty > 0 ? Math.min(100, Math.round((verifiedQty / loadedQty) * 100)) : 0;

  const visibleTrips = useMemo(
    () =>
      trips.filter((trip) => filter === "all" || (filter === "open" ? trip.status === "OPEN" : trip.status !== "OPEN")),
    [trips, filter]
  );
  const selectedTrip = selectedQuery.data ?? trips.find((trip) => Number(trip.id) === dispatchId) ?? null;

  const refresh = async () => {
    await Promise.all([tripsQuery.refetch(), orderQuery.refetch(), ...(dispatchId ? [selectedQuery.refetch()] : [])]);
  };

  const createMutation = useMutation({
    mutationFn: async (form: TripForm) => {
      const response = await apiRequest("POST", listUrl, {
        tripNumber: Number(form.tripNumber),
        notes: form.notes,
      });
      return response.json() as Promise<DispatchTrip>;
    },
    onSuccess: (trip) => {
      setCreateOpen(false);
      setNewTrip(blankForm);
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(listUrl, companyId) });
      toast({
        title: "Dispatch created",
        description: "Trip #" + trip.dispatchNumber + " is now open for verification.",
      });
      navigate(tripPath(orderId, trip.id));
    },
    onError: (error) =>
      toast({ title: "Could not create dispatch", description: getError(error), variant: "destructive" }),
  });

  const editMutation = useMutation({
    mutationFn: async (form: TripForm) => {
      if (!selectedUrl) throw new Error("Choose a dispatch to edit");
      const response = await apiRequest("PATCH", selectedUrl, {
        tripNumber: Number(form.tripNumber),
        notes: form.notes,
      });
      return response.json() as Promise<DispatchTrip>;
    },
    onSuccess: () => {
      setEditOpen(false);
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(listUrl, companyId) });
      if (selectedUrl) void queryClient.invalidateQueries({ queryKey: companyQueryKey(selectedUrl, companyId) });
      toast({ title: "Dispatch details saved" });
    },
    onError: (error) =>
      toast({ title: "Could not save changes", description: getError(error), variant: "destructive" }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (reason: string) => {
      if (!selectedUrl || !selectedTrip || selectedTrip.status !== "OPEN") {
        throw new Error("Only an open dispatch can be deleted");
      }
      const response = await apiRequest("POST", selectedUrl + "/cancel", { reason });
      return response.json() as Promise<{ success: boolean; removedScans: number }>;
    },
    onSuccess: (result) => {
      setDeleteOpen(false);
      setDeleteReason("");
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(listUrl, companyId) });
      if (selectedUrl) void queryClient.invalidateQueries({ queryKey: companyQueryKey(selectedUrl, companyId) });
      void queryClient.invalidateQueries({ queryKey: companyQueryKey(listUrl + "/comparison", companyId) });
      toast({
        title: "Dispatch deleted",
        description: result.removedScans + " verification scans released. Audit history is preserved.",
      });
      navigate(tripPath(orderId));
    },
    onError: (error) =>
      toast({ title: "Could not delete dispatch", description: getError(error), variant: "destructive" }),
  });

  const backToLoading = () => navigate("/factory/sales/loading/new?orderId=" + orderId);
  return {
    backToLoading,
    canCreate,
    canDeleteDispatch,
    canEdit,
    canViewFinancialDashboard,
    companyId,
    completion,
    createMutation,
    createOpen,
    deleteMutation,
    deleteOpen,
    deleteReason,
    dispatchId,
    editMutation,
    editOpen,
    editTrip,
    filter,
    formatDisplayDateTime,
    listUrl,
    loadedQty,
    loadedWeight,
    navigate,
    newTrip,
    openTrips,
    orderId,
    orderQuery,
    refresh,
    remainingQty,
    selectedQuery,
    selectedTrip,
    selectedUrl,
    setCreateOpen,
    setDeleteOpen,
    setDeleteReason,
    setEditOpen,
    setEditTrip,
    setFilter,
    setNewTrip,
    trips,
    tripsQuery,
    user,
    validDispatch,
    validOrder,
    verifiedQty,
    verifiedWeight,
    visibleTrips,
  };
}

export function FactoryLoadingDispatchSection({
  canCreate,
  filter,
  formatDisplayDateTime,
  navigate,
  openTrips,
  orderId,
  setCreateOpen,
  setFilter,
  trips,
  tripsQuery,
  visibleTrips,
}: Pick<
  ReturnType<typeof useFactoryLoadingDispatchState>,
  | "canCreate"
  | "filter"
  | "formatDisplayDateTime"
  | "navigate"
  | "openTrips"
  | "orderId"
  | "setCreateOpen"
  | "setFilter"
  | "trips"
  | "tripsQuery"
  | "visibleTrips"
>) {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-base font-bold">Truck trips</h2>
          <p className="text-xs text-muted-foreground">Each trip has its own record, operator and status.</p>
        </div>
        <TabsList className="w-max" aria-label="Dispatch status filter">
          <PillTabButton selected={filter === "all"} onClick={() => setFilter("all")}>
            All ({trips.length})
          </PillTabButton>
          <PillTabButton selected={filter === "open"} onClick={() => setFilter("open")}>
            Open ({openTrips})
          </PillTabButton>
          <PillTabButton selected={filter === "closed"} onClick={() => setFilter("closed")}>
            Finished ({trips.length - openTrips})
          </PillTabButton>
        </TabsList>
      </div>
      {tripsQuery.isPending && (
        <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading dispatch records…
        </div>
      )}
      {!tripsQuery.isPending && tripsQuery.isSuccess && visibleTrips.length === 0 && (
        <div className="flex flex-col items-center gap-3 rounded-2xl border border-dashed border-blue-200 bg-white/80 p-10 text-center dark:border-blue-500/25 dark:bg-[hsl(var(--factory-hue)_53%_13%)]">
          <Truck className="h-9 w-9 text-blue-500" />
          <p className="font-semibold">
            {trips.length === 0 ? "No dispatch trips yet" : "No dispatches match this filter"}
          </p>
          <p className="max-w-sm text-sm text-muted-foreground">
            {trips.length === 0
              ? "Create a dispatch for the first truck. Every additional trip will be tracked separately."
              : "Try another status filter to see the other trips."}
          </p>
          {canCreate && trips.length === 0 && (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Create first dispatch
            </Button>
          )}
        </div>
      )}
      {visibleTrips.length > 0 && (
        <div className="overflow-x-auto rounded-xl border border-border bg-card">
          <table className="w-full min-w-[620px] text-left text-sm" data-testid="dispatch-trips-table">
            <thead className="border-b border-border bg-muted/40 text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">
                  Trip
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Created
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Scanned bales
                </th>
                <th scope="col" className="px-4 py-3 font-medium">
                  Status
                </th>
                <th scope="col" className="px-4 py-3 text-right font-medium">
                  Action
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {visibleTrips.map((trip) => (
                <tr key={trip.id} className="transition-colors hover:bg-muted/30">
                  <td className="px-4 py-3">
                    <strong className="font-semibold">Trip #{String(trip.dispatchNumber).padStart(3, "0")}</strong>
                    <p className="max-w-[240px] truncate text-xs text-muted-foreground">
                      {trip.truckPlate || trip.notes || "No truck details"}
                    </p>
                  </td>
                  <td className="px-4 py-3">
                    {formatDisplayDateTime(trip.createdAt)}
                    <p className="text-xs text-muted-foreground">{trip.createdByUsername || "Unknown operator"}</p>
                  </td>
                  <td className="px-4 py-3 font-mono">
                    {printNumber(numberValue(trip.scannedBales))}
                    <span className="ml-2 font-sans text-xs text-muted-foreground">
                      ({printNumber(numberValue(trip.scannedWeightKg), 2)} kg)
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <TripStatusBadge status={trip.status} />
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => navigate(tripPath(orderId, trip.id))}
                      data-testid={"dispatch-trip-" + trip.id}
                      aria-label={"Open trip " + trip.dispatchNumber}
                    >
                      Open <ArrowRight className="ml-1.5 h-4 w-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

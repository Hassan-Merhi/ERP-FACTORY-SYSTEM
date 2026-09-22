import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowRight, Loader2, RefreshCw, Ship } from "lucide-react";
import { CONTAINER_LIFECYCLE, type PlanShipmentSummary } from "@shared/containerShipment";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { readActiveCompanyScope } from "@/lib/progressivePagination";

interface ShipmentResponse {
  planId: number;
  planName: string;
  checkedAt: string;
  summary: PlanShipmentSummary;
}

interface Props {
  planId: number;
  onPlanChanged: () => void;
}

const SHIPMENT_FIELDS = [
  { key: "containerNumber", label: "Container no." },
  { key: "carrier", label: "Carrier" },
  { key: "bookingNumber", label: "Booking no." },
  { key: "vesselName", label: "Vessel" },
  { key: "destination", label: "Destination" },
  { key: "etd", label: "ETD (YYYY-MM-DD)" },
  { key: "eta", label: "ETA (YYYY-MM-DD)" },
] as const;

type ShipmentFieldKey = (typeof SHIPMENT_FIELDS)[number]["key"];

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.message || "Request failed");
  return body as T;
}

/**
 * Phase 6 shipment board: where every container stands in
 * PLANNED → LOADING → LOADED → SHIPPED → ARRIVED → DELIVERED, what its next
 * step needs, and the carrier details that gate it.
 */
export function ContainerPlannerShipments({ planId, onPlanChanged }: Props) {
  const { toast } = useToast();
  const companyScope = readActiveCompanyScope();
  const queryKey = ["/api/factory/v5/container-plans/shipments", companyScope, planId] as const;

  const [activeContainerId, setActiveContainerId] = useState<number | null>(null);
  const [draft, setDraft] = useState<Partial<Record<ShipmentFieldKey, string>>>({});
  const [draftContainerId, setDraftContainerId] = useState<number | null>(null);

  const shipmentQuery = useQuery<ShipmentResponse>({
    queryKey,
    queryFn: () => getJson(`/api/factory/v5/container-plans/${planId}/shipments`),
    staleTime: 10_000,
    refetchOnWindowFocus: false,
  });

  const summary = shipmentQuery.data?.summary ?? null;
  const containers = summary?.containers ?? [];
  const selectedContainerId = activeContainerId ?? containers[0]?.containerId ?? null;
  const selectedContainer = containers.find((entry) => entry.containerId === selectedContainerId) ?? null;

  // The draft form follows the selected container until the user edits it.
  if (selectedContainer && draftContainerId !== selectedContainer.containerId) {
    setDraftContainerId(selectedContainer.containerId);
    setDraft({
      containerNumber: selectedContainer.containerNumber ?? "",
      carrier: selectedContainer.carrier ?? "",
      bookingNumber: selectedContainer.bookingNumber ?? "",
      vesselName: selectedContainer.vesselName ?? "",
      destination: selectedContainer.destination ?? "",
      etd: selectedContainer.etd ?? "",
      eta: selectedContainer.eta ?? "",
    });
  }

  const statusMutation = useMutation({
    mutationFn: async (payload: { containerId: number; toStatus: string }) => {
      const response = await apiRequest(
        "POST",
        `/api/factory/v5/container-plans/${planId}/containers/${payload.containerId}/shipment/status`,
        { toStatus: payload.toStatus }
      );
      return (await response.json()) as { toStatus: string };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey });
      onPlanChanged();
      toast({ title: `Container marked ${data.toStatus}` });
    },
    onError: (error: Error) =>
      toast({ title: "Could not change status", description: error.message, variant: "destructive" }),
  });

  const detailsMutation = useMutation({
    mutationFn: async (payload: { containerId: number; fields: Partial<Record<ShipmentFieldKey, string>> }) => {
      const response = await apiRequest(
        "PATCH",
        `/api/factory/v5/container-plans/${planId}/containers/${payload.containerId}/shipment`,
        payload.fields
      );
      return (await response.json()) as { success: boolean };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast({ title: "Shipment details saved" });
    },
    onError: (error: Error) =>
      toast({ title: "Could not save details", description: error.message, variant: "destructive" }),
  });

  if (shipmentQuery.isLoading) {
    return (
      <div className="rounded-lg border bg-muted/10 p-4" data-testid="container-plan-shipments-loading">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading shipment tracking…
        </div>
      </div>
    );
  }

  if (shipmentQuery.isError || !summary) {
    return (
      <div
        className="rounded-lg border border-destructive/30 bg-destructive/5 p-4"
        data-testid="container-plan-shipments-error"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm font-medium text-destructive">
            {(shipmentQuery.error as Error)?.message || "Could not load shipment tracking."}
          </p>
          <Button size="sm" variant="outline" onClick={() => shipmentQuery.refetch()}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Retry
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border bg-background p-3" data-testid="container-plan-shipments">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Ship className="h-4 w-4 text-muted-foreground" />
          <div>
            <p className="text-sm font-semibold">Shipment tracking</p>
            <p className="text-xs text-muted-foreground">
              {CONTAINER_LIFECYCLE.map((status) => `${status} ${summary.byStatus[status]}`).join(" · ")}
            </p>
          </div>
        </div>
        <Badge variant="secondary">
          {summary.shippedContainers} of {summary.containerCount} shipped
        </Badge>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-6">
        {containers.map((container) => (
          <Card
            key={container.containerId}
            className={`cursor-pointer transition ${
              container.containerId === selectedContainerId ? "border-foreground/40 bg-muted/40" : ""
            }`}
            onClick={() => setActiveContainerId(container.containerId)}
            data-testid={`card-container-shipment-${container.containerId}`}
          >
            <CardContent className="p-3">
              <div className="truncate text-xs font-semibold">{container.containerName}</div>
              <Badge variant="outline" className="mt-1 text-[11px]">
                {container.lifecycleStatus}
              </Badge>
              <div className="mt-1 truncate text-[11px] text-muted-foreground">
                {container.containerNumber || "No container number"}
                {container.destination ? ` · ${container.destination}` : ""}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {selectedContainer && (
        <div className="mt-4 rounded-lg border p-3" data-testid="container-shipment-workspace">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="text-sm font-semibold">
              {selectedContainer.containerName} · {selectedContainer.lifecycleStatus}
            </p>
            {selectedContainer.nextStatus && (
              <Button
                size="sm"
                disabled={statusMutation.isPending || Boolean(selectedContainer.nextStatusBlockedReason)}
                onClick={() =>
                  statusMutation.mutate({
                    containerId: selectedContainer.containerId,
                    toStatus: selectedContainer.nextStatus!,
                  })
                }
                title={selectedContainer.nextStatusBlockedReason ?? undefined}
                data-testid="button-advance-shipment"
              >
                <ArrowRight className="mr-2 h-4 w-4" />
                Mark {selectedContainer.nextStatus}
              </Button>
            )}
          </div>

          {selectedContainer.nextStatusBlockedReason && (
            <p className="mt-2 text-xs text-amber-600" data-testid="text-shipment-blocker">
              {selectedContainer.nextStatusBlockedReason}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-end gap-2">
            {SHIPMENT_FIELDS.map((field) => (
              <div key={field.key}>
                <label className="text-[11px] text-muted-foreground" htmlFor={`shipment-${field.key}`}>
                  {field.label}
                </label>
                <Input
                  id={`shipment-${field.key}`}
                  value={draft[field.key] ?? ""}
                  onChange={(event) => setDraft((current) => ({ ...current, [field.key]: event.target.value }))}
                  className="h-9 w-40"
                  data-testid={`input-shipment-${field.key}`}
                />
              </div>
            ))}
            <Button
              size="sm"
              variant="outline"
              disabled={detailsMutation.isPending}
              onClick={() => detailsMutation.mutate({ containerId: selectedContainer.containerId, fields: draft })}
              data-testid="button-save-shipment-details"
            >
              Save details
            </Button>
          </div>

          <p className="mt-3 text-[11px] text-muted-foreground">
            {selectedContainer.assignedQty} of {selectedContainer.plannedQty} bales assigned ·{" "}
            {selectedContainer.allocatedQty} allocated to customers · {selectedContainer.documentCount} documents
          </p>
        </div>
      )}
    </div>
  );
}

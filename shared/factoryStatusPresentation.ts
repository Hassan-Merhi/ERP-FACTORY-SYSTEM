/**
 * Presentation contracts only. These are NOT business transition rules.
 * Order allocation and truck dispatch are different state machines.
 */
export const FACTORY_ALLOCATION_STATUS_LABELS = {
  DRAFT: "Draft",
  LOADING: "Loading",
  PENDING_VERIFICATION: "Verified", // legacy display alias: preserve existing V5 UI output
  VERIFIED: "Verified",
  FINALIZED: "Finalized",
  CANCELLED: "Cancelled",
} as const;
export type FactoryAllocationStatus = keyof typeof FACTORY_ALLOCATION_STATUS_LABELS;

export const FACTORY_DISPATCH_TRIP_STATUS_LABELS = {
  OPEN: "Open",
  CLOSED: "Closed",
  CANCELLED: "Cancelled",
} as const;
export type FactoryDispatchTripStatus = keyof typeof FACTORY_DISPATCH_TRIP_STATUS_LABELS;

export const FACTORY_CONTAINER_STATUS_LABELS = {
  PENDING: "Pending",
  IN_TRANSIT: "In Transit",
  ARRIVED: "Arrived",
  OFFLOADED: "Offloaded",
  PARTIALLY_RECEIVED: "Partially Offloaded",
  RECEIVED: "Received",
  AVAILABLE: "Available",
  CLOSED: "Closed",
  COMPLETED: "Completed",
} as const;
export type FactoryContainerStatus = keyof typeof FACTORY_CONTAINER_STATUS_LABELS;

export function factoryStatusLabel(
  workflow: "allocation" | "dispatch" | "container",
  status: string,
): string {
  const labels: Readonly<Record<string, string>> =
    workflow === "allocation" ? FACTORY_ALLOCATION_STATUS_LABELS :
    workflow === "dispatch" ? FACTORY_DISPATCH_TRIP_STATUS_LABELS :
    FACTORY_CONTAINER_STATUS_LABELS;
  return labels[status] ?? status;
}

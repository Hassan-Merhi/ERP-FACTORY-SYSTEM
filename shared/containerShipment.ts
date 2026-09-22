/**
 * Container Planner Phase 6 - Container Shipment Tracking (pure logic).
 *
 * A planned container becomes a shipment that moves through a fixed lifecycle:
 *
 *   PLANNED -> LOADING -> LOADED -> SHIPPED -> ARRIVED -> DELIVERED
 *
 * Every gate between those states lives here: what a container must already
 * have before it may advance, which corrections are allowed, and which shipment
 * fields are required at which point.
 */

export const CONTAINER_LIFECYCLE = ["PLANNED", "LOADING", "LOADED", "SHIPPED", "ARRIVED", "DELIVERED"] as const;

export type ContainerLifecycleStatus = (typeof CONTAINER_LIFECYCLE)[number];

export const CONTAINER_DOCUMENT_TYPES = [
  "BILL_OF_LADING",
  "PACKING_LIST",
  "COMMERCIAL_INVOICE",
  "CERTIFICATE_OF_ORIGIN",
  "CUSTOMS_DECLARATION",
  "INSURANCE",
  "OTHER",
] as const;

export type ContainerDocumentType = (typeof CONTAINER_DOCUMENT_TYPES)[number];

export interface ContainerShipmentFields {
  containerNumber: string | null;
  carrier: string | null;
  bookingNumber: string | null;
  vesselName: string | null;
  destination: string | null;
  etd: string | null;
  eta: string | null;
}

export interface ContainerShipmentState extends ContainerShipmentFields {
  lifecycleStatus: ContainerLifecycleStatus;
  plannedQty: number;
  assignedQty: number;
  allocatedQty: number;
}

export interface TransitionCheck {
  allowed: boolean;
  code?:
    | "UNKNOWN_STATUS"
    | "SAME_STATUS"
    | "NOT_ADJACENT"
    | "TERMINAL_STATUS"
    | "NOTHING_PLANNED"
    | "BALES_NOT_ASSIGNED"
    | "SHIPMENT_DETAILS_MISSING";
  message?: string;
  /** Fields the transition still needs, when the blocker is missing details. */
  missingFields?: string[];
}

export function isContainerLifecycleStatus(value: unknown): value is ContainerLifecycleStatus {
  return typeof value === "string" && (CONTAINER_LIFECYCLE as readonly string[]).includes(value);
}

export function isContainerDocumentType(value: unknown): value is ContainerDocumentType {
  return typeof value === "string" && (CONTAINER_DOCUMENT_TYPES as readonly string[]).includes(value);
}

export function lifecycleIndex(status: ContainerLifecycleStatus): number {
  return CONTAINER_LIFECYCLE.indexOf(status);
}

/**
 * A container that has left PLANNED is physically committed, so the planning
 * phases must stop editing its quantities.
 */
export function isShipmentCommitted(status: ContainerLifecycleStatus): boolean {
  return lifecycleIndex(status) > lifecycleIndex("PLANNED");
}

/** Normalizes a shipment reference (container number, booking number, …). */
export function normalizeShipmentReference(value: unknown, maxLength = 60): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed === "" ? null : trimmed.slice(0, maxLength);
}

/** Accepts an ISO date (YYYY-MM-DD) for ETD/ETA, rejecting anything else. */
export function normalizeShipmentDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const parsed = new Date(`${trimmed}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  return trimmed;
}

const FORWARD_REQUIREMENTS: Partial<Record<ContainerLifecycleStatus, Array<keyof ContainerShipmentFields>>> = {
  SHIPPED: ["containerNumber", "carrier"],
};

/**
 * Decides whether one container may move from its current lifecycle status to
 * the requested one.
 *
 * Movement is one step at a time in either direction: forward when the work is
 * genuinely done, backward so a mis-click can be corrected. DELIVERED is
 * terminal because reversing a delivery is a commercial event, not a typo.
 */
export function checkLifecycleTransition(
  state: ContainerShipmentState,
  toStatus: ContainerLifecycleStatus
): TransitionCheck {
  if (!isContainerLifecycleStatus(toStatus)) {
    return { allowed: false, code: "UNKNOWN_STATUS", message: "Unknown container status." };
  }

  const fromIndex = lifecycleIndex(state.lifecycleStatus);
  const toIndex = lifecycleIndex(toStatus);

  if (fromIndex === toIndex) {
    return { allowed: false, code: "SAME_STATUS", message: `This container is already ${toStatus}.` };
  }
  if (state.lifecycleStatus === "DELIVERED") {
    return {
      allowed: false,
      code: "TERMINAL_STATUS",
      message: "A delivered container cannot be moved back. Record a return instead.",
    };
  }
  if (Math.abs(toIndex - fromIndex) !== 1) {
    return {
      allowed: false,
      code: "NOT_ADJACENT",
      message: `A container moves one step at a time: ${CONTAINER_LIFECYCLE.join(" → ")}.`,
    };
  }

  // Backward corrections carry no readiness requirements.
  if (toIndex < fromIndex) return { allowed: true };

  if (toStatus === "LOADING" && state.plannedQty <= 0) {
    return {
      allowed: false,
      code: "NOTHING_PLANNED",
      message: "This container has no planned bales to load.",
    };
  }

  if (toStatus === "LOADED" && state.assignedQty < state.plannedQty) {
    return {
      allowed: false,
      code: "BALES_NOT_ASSIGNED",
      message: `${state.plannedQty - state.assignedQty} planned bales still have no physical bale assigned.`,
    };
  }

  const required = FORWARD_REQUIREMENTS[toStatus] ?? [];
  const missingFields = required.filter((field) => !state[field]);
  if (missingFields.length > 0) {
    return {
      allowed: false,
      code: "SHIPMENT_DETAILS_MISSING",
      message: `Record the ${missingFields.join(" and ")} before marking this container ${toStatus}.`,
      missingFields,
    };
  }

  return { allowed: true };
}

export interface ShipmentProgressContainer extends ContainerShipmentState {
  containerId: number;
  containerName: string;
  position: number;
  isCommitted: boolean;
  nextStatus: ContainerLifecycleStatus | null;
  nextStatusBlockedReason: string | null;
  documentCount: number;
}

export interface PlanShipmentSummary {
  containerCount: number;
  byStatus: Record<ContainerLifecycleStatus, number>;
  shippedContainers: number;
  deliveredContainers: number;
  containers: ShipmentProgressContainer[];
}

/**
 * Builds the shipment board: where every container stands and, for each, the
 * single next step plus what is blocking it.
 */
export function buildPlanShipmentSummary(
  containers: Array<
    ContainerShipmentState & {
      containerId: number;
      containerName: string;
      position: number;
      documentCount: number;
    }
  >
): PlanShipmentSummary {
  const byStatus = CONTAINER_LIFECYCLE.reduce(
    (accumulator, status) => {
      accumulator[status] = 0;
      return accumulator;
    },
    {} as Record<ContainerLifecycleStatus, number>
  );

  const progress: ShipmentProgressContainer[] = containers
    .map((container) => {
      byStatus[container.lifecycleStatus] += 1;
      const nextIndex = lifecycleIndex(container.lifecycleStatus) + 1;
      const nextStatus = nextIndex < CONTAINER_LIFECYCLE.length ? CONTAINER_LIFECYCLE[nextIndex] : null;
      const check = nextStatus ? checkLifecycleTransition(container, nextStatus) : null;

      return {
        ...container,
        isCommitted: isShipmentCommitted(container.lifecycleStatus),
        nextStatus,
        nextStatusBlockedReason: check && !check.allowed ? (check.message ?? null) : null,
      };
    })
    .sort((a, b) => a.position - b.position || a.containerId - b.containerId);

  return {
    containerCount: progress.length,
    byStatus,
    shippedContainers: progress.filter(
      (container) => lifecycleIndex(container.lifecycleStatus) >= lifecycleIndex("SHIPPED")
    ).length,
    deliveredContainers: byStatus.DELIVERED,
    containers: progress,
  };
}

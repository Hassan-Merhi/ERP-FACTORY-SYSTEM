import { describe, expect, it } from "vitest";

import {
  buildPlanShipmentSummary,
  CONTAINER_LIFECYCLE,
  checkLifecycleTransition,
  isContainerDocumentType,
  isContainerLifecycleStatus,
  isShipmentCommitted,
  normalizeShipmentDate,
  normalizeShipmentReference,
  type ContainerShipmentState,
} from "@shared/containerShipment";

function state(overrides: Partial<ContainerShipmentState> = {}): ContainerShipmentState {
  return {
    lifecycleStatus: "PLANNED",
    containerNumber: null,
    carrier: null,
    bookingNumber: null,
    vesselName: null,
    destination: null,
    etd: null,
    eta: null,
    plannedQty: 600,
    assignedQty: 600,
    allocatedQty: 600,
    ...overrides,
  };
}

describe("lifecycle basics", () => {
  it("exposes the fixed shipment lifecycle", () => {
    expect(CONTAINER_LIFECYCLE).toEqual(["PLANNED", "LOADING", "LOADED", "SHIPPED", "ARRIVED", "DELIVERED"]);
    expect(isContainerLifecycleStatus("SHIPPED")).toBe(true);
    expect(isContainerLifecycleStatus("IN_TRANSIT")).toBe(false);
    expect(isContainerDocumentType("BILL_OF_LADING")).toBe(true);
    expect(isContainerDocumentType("RANDOM")).toBe(false);
  });

  it("treats anything past PLANNED as physically committed", () => {
    expect(isShipmentCommitted("PLANNED")).toBe(false);
    expect(isShipmentCommitted("LOADING")).toBe(true);
    expect(isShipmentCommitted("DELIVERED")).toBe(true);
  });
});

describe("checkLifecycleTransition", () => {
  it("allows one forward step when the container is ready", () => {
    expect(checkLifecycleTransition(state(), "LOADING").allowed).toBe(true);
    expect(checkLifecycleTransition(state({ lifecycleStatus: "LOADING" }), "LOADED").allowed).toBe(true);
  });

  it("refuses skipping a step", () => {
    const check = checkLifecycleTransition(state(), "SHIPPED");
    expect(check.allowed).toBe(false);
    expect(check.code).toBe("NOT_ADJACENT");
  });

  it("refuses loading a container with nothing planned", () => {
    const check = checkLifecycleTransition(state({ plannedQty: 0, assignedQty: 0 }), "LOADING");
    expect(check.code).toBe("NOTHING_PLANNED");
  });

  it("refuses LOADED until every planned bale has a physical bale", () => {
    const check = checkLifecycleTransition(
      state({ lifecycleStatus: "LOADING", plannedQty: 600, assignedQty: 580 }),
      "LOADED"
    );
    expect(check.code).toBe("BALES_NOT_ASSIGNED");
    expect(check.message).toContain("20");
  });

  it("refuses SHIPPED until the container number and carrier are recorded", () => {
    const missing = checkLifecycleTransition(state({ lifecycleStatus: "LOADED" }), "SHIPPED");
    expect(missing.code).toBe("SHIPMENT_DETAILS_MISSING");
    expect(missing.missingFields).toEqual(["containerNumber", "carrier"]);

    const ready = checkLifecycleTransition(
      state({ lifecycleStatus: "LOADED", containerNumber: "MSKU1234567", carrier: "Maersk" }),
      "SHIPPED"
    );
    expect(ready.allowed).toBe(true);
  });

  it("allows a one-step correction backwards without readiness checks", () => {
    const check = checkLifecycleTransition(
      state({ lifecycleStatus: "LOADED", assignedQty: 0, plannedQty: 600 }),
      "LOADING"
    );
    expect(check.allowed).toBe(true);
  });

  it("treats DELIVERED as terminal and rejects a no-op move", () => {
    expect(checkLifecycleTransition(state({ lifecycleStatus: "DELIVERED" }), "ARRIVED").code).toBe("TERMINAL_STATUS");
    expect(checkLifecycleTransition(state({ lifecycleStatus: "LOADING" }), "LOADING").code).toBe("SAME_STATUS");
  });
});

describe("normalizers", () => {
  it("collapses whitespace and rejects empty references", () => {
    expect(normalizeShipmentReference("  MSKU   1234567 ")).toBe("MSKU 1234567");
    expect(normalizeShipmentReference("   ")).toBeNull();
    expect(normalizeShipmentReference(42)).toBeNull();
  });

  it("accepts only ISO calendar dates", () => {
    expect(normalizeShipmentDate("2026-10-01")).toBe("2026-10-01");
    expect(normalizeShipmentDate("2026-10-01T09:00:00Z")).toBe("2026-10-01");
    expect(normalizeShipmentDate("01/10/2026")).toBeNull();
    expect(normalizeShipmentDate("2026-13-45")).toBeNull();
  });
});

describe("buildPlanShipmentSummary", () => {
  it("counts each status and names the next step and its blocker", () => {
    const summary = buildPlanShipmentSummary([
      {
        ...state({ lifecycleStatus: "LOADING", plannedQty: 600, assignedQty: 100 }),
        containerId: 1,
        containerName: "Container 1",
        position: 0,
        documentCount: 0,
      },
      {
        ...state({ lifecycleStatus: "SHIPPED", containerNumber: "MSKU1234567", carrier: "Maersk" }),
        containerId: 2,
        containerName: "Container 2",
        position: 1,
        documentCount: 3,
      },
      {
        ...state({ lifecycleStatus: "DELIVERED" }),
        containerId: 3,
        containerName: "Container 3",
        position: 2,
        documentCount: 4,
      },
    ]);

    expect(summary.containerCount).toBe(3);
    expect(summary.byStatus.LOADING).toBe(1);
    expect(summary.byStatus.PLANNED).toBe(0);
    expect(summary.shippedContainers).toBe(2);
    expect(summary.deliveredContainers).toBe(1);

    expect(summary.containers[0].nextStatus).toBe("LOADED");
    expect(summary.containers[0].nextStatusBlockedReason).toContain("500");
    expect(summary.containers[1].nextStatus).toBe("ARRIVED");
    expect(summary.containers[1].nextStatusBlockedReason).toBeNull();
    expect(summary.containers[2].nextStatus).toBeNull();
    expect(summary.containers.every((container) => container.isCommitted)).toBe(true);
  });
});

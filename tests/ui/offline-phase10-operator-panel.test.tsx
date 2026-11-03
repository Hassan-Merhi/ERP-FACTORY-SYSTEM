import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { FactoryEdgeOperatorPanel } from "@/components/FactoryEdgeOperatorPanel";
import { parseEdgeOperatorStatus } from "@/lib/offline/edgeOperatorStatus";

const report = (overrides: Record<string, unknown> = {}) => ({
  siteId: "11111111-2222-4333-8444-555555555555",
  generatedAt: "2026-10-31T06:00:00.000Z",
  relayPaused: false,
  relayControl: { paused: false, operatorName: null, reason: null, recordedAt: null },
  streams: [
    { stream: "voucher", installed: true, captured: 4, pending: 1, notStaged: 1, applied: 3 },
    {
      stream: "pressing",
      installed: true,
      captured: 2,
      pending: 0,
      stagedNotApplied: 0,
      applied: 1,
      rejectedByOperator: 1,
    },
    { stream: "stock", installed: false, captured: 0, pending: 0 },
  ],
  pendingTotal: 1,
  handoverReady: false,
  ...overrides,
});

function mockFetch(status: number, body: unknown) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("parseEdgeOperatorStatus", () => {
  it("accepts the LAN report and defaults absent per-stream counters to zero", () => {
    const parsed = parseEdgeOperatorStatus(report());
    expect(
      parsed?.streams.map((s) => [s.stream, s.pending, s.stagedNotApplied, s.applied, s.rejectedByOperator])
    ).toEqual([
      ["voucher", 1, 0, 3, 0],
      ["pressing", 0, 0, 1, 1],
      ["stock", 0, 0, 0, 0],
    ]);
  });

  it("never reports handover ready while anything is pending", () => {
    expect(parseEdgeOperatorStatus(report({ handoverReady: true, pendingTotal: 2 }))?.handoverReady).toBe(false);
    expect(parseEdgeOperatorStatus(report({ handoverReady: true, pendingTotal: 0 }))?.handoverReady).toBe(true);
  });

  it("rejects malformed reports instead of rendering partial state", () => {
    expect(parseEdgeOperatorStatus(null)).toBeNull();
    expect(parseEdgeOperatorStatus(report({ pendingTotal: -1 }))).toBeNull();
    expect(parseEdgeOperatorStatus(report({ pendingTotal: 1.5 }))).toBeNull();
    expect(
      parseEdgeOperatorStatus(report({ streams: [{ stream: "voucher", installed: true, captured: "4", pending: 0 }] }))
    ).toBeNull();
    expect(parseEdgeOperatorStatus(report({ handoverReady: "yes" }))).toBeNull();
  });

  it("surfaces who paused delivery and why", () => {
    const parsed = parseEdgeOperatorStatus(
      report({
        relayPaused: true,
        relayControl: { paused: true, operatorName: "Shift lead", reason: "ISP maintenance", recordedAt: null },
      })
    );
    expect(parsed).toMatchObject({ relayPaused: true, pausedBy: "Shift lead", pausedReason: "ISP maintenance" });
  });
});

describe("FactoryEdgeOperatorPanel", () => {
  it("shows pending work, relay state and blocks handover", async () => {
    const fetchSpy = mockFetch(200, report());
    render(<FactoryEdgeOperatorPanel />);
    expect(await screen.findByTestId("factory-edge-operator-panel")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledWith("/api/edge/operator/status", expect.objectContaining({ cache: "no-store" }));
    expect(screen.getByTestId("factory-edge-pending-total").textContent).toBe("1");
    expect(screen.getByTestId("factory-edge-handover-state").textContent).toBe("Not ready for handover");
    expect(screen.getByTestId("factory-edge-relay-state").textContent).toContain("Delivery to cloud is running");
    expect(screen.getByTestId("factory-edge-stream-stock").textContent).toContain("Not installed on this server");
  });

  it("reports handover ready only when nothing is pending", async () => {
    mockFetch(200, report({ pendingTotal: 0, handoverReady: true, streams: [] }));
    render(<FactoryEdgeOperatorPanel />);
    expect((await screen.findByTestId("factory-edge-handover-state")).textContent).toBe("Safe to hand back to cloud");
  });

  it.each([
    [403, { code: "EDGE_OPERATOR_ROLE_REQUIRED" }],
    [404, { message: "Not found" }],
    [200, { unexpected: true }],
  ])("renders nothing for HTTP %s or an unrecognized body", async (status, body) => {
    const fetchSpy = mockFetch(status, body);
    const { container } = render(<FactoryEdgeOperatorPanel />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
  });
});

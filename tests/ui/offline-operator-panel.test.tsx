import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FactoryEdgeConflictsPanel } from "@/components/FactoryEdgeConflictsPanel";
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

/** Answers by URL; records every call. */
function routeFetch(routes: Record<string, (init?: RequestInit) => { status: number; body: unknown }>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
    const handler = routes[path] ?? (() => ({ status: 200, body: { csrfToken: "test-token" } }));
    const { status, body } = handler(init);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
}

async function confirmWith(reason: string, password: string) {
  fireEvent.change(await screen.findByTestId("input-edge-operator-reason"), { target: { value: reason } });
  fireEvent.change(screen.getByTestId("input-edge-operator-password"), { target: { value: password } });
  fireEvent.click(screen.getByTestId("button-edge-operator-confirm"));
}

describe("FactoryEdgeOperatorPanel pause / resume button", () => {
  it("pauses delivery only after a reason and the password, then shows who paused it", async () => {
    let paused = false;
    const fetchSpy = routeFetch({
      "/api/edge/operator/status": () => ({
        status: 200,
        body: paused
          ? report({
              relayPaused: true,
              relayControl: {
                paused: true,
                operatorName: "Shift lead",
                reason: "cloud restore today",
                recordedAt: null,
              },
            })
          : report(),
      }),
      "/api/edge/operator/sync-control": () => {
        paused = true;
        return { status: 200, body: { paused: true } };
      },
    });
    render(<FactoryEdgeOperatorPanel />);
    fireEvent.click(await screen.findByTestId("button-edge-relay-toggle"));
    fireEvent.change(await screen.findByTestId("input-edge-operator-reason"), { target: { value: "short" } });
    fireEvent.change(screen.getByTestId("input-edge-operator-password"), { target: { value: "secret" } });
    expect((screen.getByTestId("button-edge-operator-confirm") as HTMLButtonElement).disabled).toBe(true);
    await confirmWith("cloud restore today", "secret");
    await waitFor(() =>
      expect(screen.getByTestId("factory-edge-relay-state").textContent).toContain("Delivery to cloud is paused")
    );
    const post = fetchSpy.mock.calls.find(([url]) => String(url).includes("/api/edge/operator/sync-control"));
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      action: "pause",
      reason: "cloud restore today",
      password: "secret",
    });
    expect(screen.getByTestId("button-edge-relay-toggle").textContent).toBe("Resume delivery");
  });

  it("keeps the dialog open with the refusal code when the password is wrong", async () => {
    routeFetch({
      "/api/edge/operator/status": () => ({ status: 200, body: report() }),
      "/api/edge/operator/sync-control": () => ({ status: 401, body: { code: "EDGE_OPERATOR_PASSWORD_INVALID" } }),
    });
    render(<FactoryEdgeOperatorPanel />);
    fireEvent.click(await screen.findByTestId("button-edge-relay-toggle"));
    await confirmWith("cloud restore today", "wrong");
    expect((await screen.findByTestId("text-edge-operator-error")).textContent).toContain(
      "EDGE_OPERATOR_PASSWORD_INVALID"
    );
  });
});

describe("FactoryEdgeConflictsPanel", () => {
  const held = {
    siteId: "11111111-2222-4333-8444-555555555555",
    conflicts: [
      {
        stream: "stock",
        sequence: "4",
        operationId: "x",
        kind: "stock.quick-adjust.v1",
        code: "PHASE9_STOCK_WOULD_GO_NEGATIVE",
        detail: {},
        detectedAt: "2026-11-05T08:00:00.000Z",
        canApprove: true,
      },
      {
        stream: "pos",
        sequence: "9",
        operationId: "y",
        kind: "pos.sale.v1",
        code: "PHASE9_POS_SALE_REFUSED",
        detail: {},
        detectedAt: "2026-11-05T08:01:00.000Z",
        canApprove: false,
      },
    ],
  };

  it("offers Approve only where the rules allow it, and records a decision with reason and password", async () => {
    let decided = false;
    const fetchSpy = routeFetch({
      "/api/edge/operator/conflicts": () => ({
        status: 200,
        body: decided ? { ...held, conflicts: held.conflicts.slice(1) } : held,
      }),
      "/api/edge/operator/conflicts/decide": () => {
        decided = true;
        return { status: 200, body: { stream: "stock", sequence: "4", decision: "approve-override" } };
      },
    });
    render(<FactoryEdgeConflictsPanel />);
    expect(await screen.findByTestId("button-edge-approve-stock-4")).toBeTruthy();
    expect(screen.queryByTestId("button-edge-approve-pos-9")).toBeNull();
    expect(screen.getByTestId("button-edge-reject-pos-9")).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-edge-approve-stock-4"));
    await confirmWith("cloud recount confirmed", "secret");
    await waitFor(() => expect(screen.queryByTestId("row-edge-conflict-stock-4")).toBeNull());
    const post = fetchSpy.mock.calls.find(([url]) => String(url).includes("/conflicts/decide"));
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({
      stream: "stock",
      sequence: "4",
      decision: "approve-override",
      reason: "cloud recount confirmed",
      password: "secret",
    });
  });

  it("renders nothing off the operator console", async () => {
    const fetchSpy = routeFetch({
      "/api/edge/operator/conflicts": () => ({ status: 404, body: { code: "EDGE_OPERATOR_CONSOLE_DISABLED" } }),
    });
    const { container } = render(<FactoryEdgeConflictsPanel />);
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await Promise.resolve();
    expect(container.innerHTML).toBe("");
  });
});

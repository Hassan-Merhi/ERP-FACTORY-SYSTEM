/**
 * useAccountDisplayOrder lets an Admin rearrange the chart-of-accounts sidebar:
 * swap two siblings, or drag an account into a group / above another account.
 * The new order is applied optimistically, saved with PUT, and rolled back if
 * the save fails. Only Admin and Developer roles may arrange.
 */
import React from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import { useAccountDisplayOrder, type DisplayNode } from "@/hooks/useAccountDisplayOrder";
import { installFakeApi, respond, type FakeApi } from "./fakeApi";

const harness = vi.hoisted(() => ({ mode: "erp", toast: vi.fn() }));

vi.mock("@/contexts/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: { id: 4 } }) }));
vi.mock("@/contexts/AppModeContext", () => ({ useAppMode: () => harness.mode }));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));

const node = (key: string, type: DisplayNode["type"], parentKey: string | null, order: number): DisplayNode => ({
  key,
  type,
  name: key,
  parentKey,
  order,
});

const LAYOUT: DisplayNode[] = [
  node("g:assets", "group", null, 0),
  node("g:income", "group", null, 1),
  node("l:cash", "ledger", "g:assets", 0),
  node("l:bank", "ledger", "g:assets", 1),
  node("l:stock", "ledger", "g:assets", 2),
  node("l:sales", "ledger", "g:income", 0),
];

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

function orderOf(nodes: DisplayNode[] | undefined, parentKey: string | null): string[] {
  return (nodes ?? [])
    .filter((n) => n.parentKey === parentKey)
    .sort((a, b) => a.order - b.order)
    .map((n) => n.key);
}

let api: FakeApi;

function serve(role: string, url = "/api/accounts/display-layout") {
  api = installFakeApi();
  let stored = LAYOUT;
  api.get(url, () => ({ nodes: stored }));
  api.put(url, ({ body }) => {
    stored = (body as { nodes: DisplayNode[] }).nodes;
    return { nodes: stored };
  });
  queryClient.setQueryData(["/api/auth/me"], { role });
}

async function renderArranger() {
  const hook = renderHook(() => useAccountDisplayOrder(), { wrapper });
  await waitFor(() => expect(hook.result.current.layout?.nodes).toHaveLength(LAYOUT.length));
  return hook;
}

beforeEach(() => {
  harness.mode = "erp";
  harness.toast.mockReset();
  queryClient.clear();
});

describe("useAccountDisplayOrder", () => {
  it("lets Admins and Developers arrange, and nobody else", async () => {
    for (const [role, allowed] of [
      ["Admin", true],
      ["Developer", true],
      ["Accountant", false],
    ] as const) {
      queryClient.clear();
      serve(role);
      const { result, unmount } = await renderArranger();
      expect(result.current.canArrange).toBe(allowed);
      unmount();
    }
  });

  it("reads the Factory layout in Factory mode", async () => {
    harness.mode = "factory";
    serve("Admin", "/api/factory/account-display-layout");

    await renderArranger();

    expect(api.callsTo("GET", "/api/factory/account-display-layout")).toHaveLength(1);
  });

  it("swaps two sibling accounts and saves the result", async () => {
    serve("Admin");
    const { result } = await renderArranger();

    act(() => result.current.swap("l:cash", "l:stock"));

    await waitFor(() => expect(api.callsTo("PUT", "/api/accounts/display-layout")).toHaveLength(1));
    const saved = (api.callsTo("PUT", "/api/accounts/display-layout")[0].body as { nodes: DisplayNode[] }).nodes;
    expect(orderOf(saved, "g:assets")).toEqual(["l:stock", "l:bank", "l:cash"]);
  });

  it.each([
    ["accounts in different groups", "l:cash", "l:sales"],
    ["an account with a group", "l:cash", "g:assets"],
    ["an account with itself", "l:cash", "l:cash"],
    ["an unknown account", "l:cash", "l:missing"],
  ])("refuses to swap %s", async (_label, key, target) => {
    serve("Admin");
    const { result } = await renderArranger();

    act(() => result.current.swap(key, target));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.callsTo("PUT", "/api/accounts/display-layout")).toHaveLength(0);
  });

  it("does not arrange for a role without permission", async () => {
    serve("Accountant");
    const { result } = await renderArranger();

    act(() => result.current.swap("l:cash", "l:bank"));
    act(() => result.current.move("l:cash", "g:income"));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.callsTo("PUT", "/api/accounts/display-layout")).toHaveLength(0);
  });

  it("moves an account dropped on a group to the end of that group and closes the gap it left", async () => {
    serve("Admin");
    const { result } = await renderArranger();

    act(() => result.current.move("l:cash", "g:income"));

    await waitFor(() => expect(orderOf(result.current.layout?.nodes, "g:income")).toEqual(["l:sales", "l:cash"]));
    const nodes = result.current.layout!.nodes;
    expect(orderOf(nodes, "g:assets")).toEqual(["l:bank", "l:stock"]);
    expect(
      nodes
        .filter((n) => n.parentKey === "g:assets")
        .map((n) => n.order)
        .sort()
    ).toEqual([0, 1]);
  });

  it("places an account dropped on another account directly above it", async () => {
    serve("Admin");
    const { result } = await renderArranger();

    act(() => result.current.move("l:stock", "l:cash"));

    await waitFor(() =>
      expect(orderOf(result.current.layout?.nodes, "g:assets")).toEqual(["l:stock", "l:cash", "l:bank"])
    );
  });

  it("moves an account into another group above the account it was dropped on", async () => {
    serve("Admin");
    const { result } = await renderArranger();

    act(() => result.current.move("l:bank", "l:sales"));

    await waitFor(() => expect(orderOf(result.current.layout?.nodes, "g:income")).toEqual(["l:bank", "l:sales"]));
    expect(orderOf(result.current.layout?.nodes, "g:assets")).toEqual(["l:cash", "l:stock"]);
  });

  it("reorders top-level groups but never nests a group or drops it on an account", async () => {
    serve("Admin");
    const { result } = await renderArranger();

    act(() => result.current.move("g:assets", "l:sales"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.callsTo("PUT", "/api/accounts/display-layout")).toHaveLength(0);

    act(() => result.current.move("g:income", "g:assets"));
    await waitFor(() => expect(orderOf(result.current.layout?.nodes, null)).toEqual(["g:income", "g:assets"]));
  });

  it("rolls back and explains when the save fails", async () => {
    serve("Admin");
    api.put("/api/accounts/display-layout", respond(500, { message: "Database unavailable" }));
    const { result } = await renderArranger();
    // Hold the refetch that follows the failure, so only the rollback can restore the order.
    api.get("/api/accounts/display-layout", () => new Promise(() => {}));

    act(() => result.current.swap("l:cash", "l:bank"));

    await waitFor(() => expect(harness.toast).toHaveBeenCalled());
    expect(harness.toast.mock.calls[0][0]).toMatchObject({
      title: "Account order was not saved",
      variant: "destructive",
    });
    await waitFor(() =>
      expect(orderOf(result.current.layout?.nodes, "g:assets")).toEqual(["l:cash", "l:bank", "l:stock"])
    );
  });

  it("cannot arrange when the layout failed to load", async () => {
    api = installFakeApi();
    api.get("/api/accounts/display-layout", respond(503, { message: "down" }));
    queryClient.setQueryData(["/api/auth/me"], { role: "Admin" });
    const { result } = renderHook(() => useAccountDisplayOrder(), { wrapper });

    await waitFor(() => expect(api.callsTo("GET", "/api/accounts/display-layout")).toHaveLength(1));
    await waitFor(() => expect(result.current.canArrange).toBe(false));
    expect(result.current.layout).toBeUndefined();
  });
});

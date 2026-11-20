import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  fetchSessionCompany: vi.fn(),
}));

vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...actual, apiRequest: harness.apiRequest };
});

vi.mock("@/hooks/use-ws-invalidation", () => ({ refreshRealtimeSessionScope: vi.fn() }));

vi.mock("@/contracts/sessionQueryContracts", () => ({
  fetchSessionCompany: harness.fetchSessionCompany,
  userCompaniesQueryOptions: () => ({
    queryKey: ["/api/user/companies"],
    queryFn: async () =>
      [1, 2, 3].map((id) => ({
        companyId: id,
        companyCode: `C${id}`,
        companyName: `Company ${id}`,
        companyActive: true,
        role: "Admin",
        companyType: "erp",
      })),
    staleTime: Infinity,
  }),
}));

import { COMPANY_SESSION_CHANNEL, COMPANY_SESSION_STORAGE_PULSE } from "@/lib/companySessionSync";
import { assertCompanyReadSnapshot, captureCompanyReadSnapshot } from "@/lib/companyCacheScope";

class FakeBroadcastChannel {
  static instances = new Set<FakeBroadcastChannel>();
  readonly listeners = new Set<(event: MessageEvent<unknown>) => void>();

  constructor(readonly name: string) {
    FakeBroadcastChannel.instances.add(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent<unknown>) => void) {
    if (type === "message") this.listeners.add(listener);
  }

  postMessage(data: unknown) {
    for (const other of FakeBroadcastChannel.instances) {
      if (other === this || other.name !== this.name) continue;
      for (const listener of other.listeners) listener({ data } as MessageEvent<unknown>);
    }
  }

  close() {
    FakeBroadcastChannel.instances.delete(this);
    this.listeners.clear();
  }
}

import { queryClient } from "@/lib/queryClient";
import { CompanyProvider, useCompany } from "@/contexts/CompanyContext";

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <CompanyProvider>{children}</CompanyProvider>
    </QueryClientProvider>
  );
}

let sessionCompanyId = 1;

/** Another tab committed a switch: the session moved, then it wrote localStorage. */
function otherTabSwitchedTo(companyId: number, eventValue = String(companyId)) {
  sessionCompanyId = companyId;
  localStorage.setItem("selectedCompanyId", eventValue);
  window.dispatchEvent(new StorageEvent("storage", { key: "selectedCompanyId", newValue: eventValue }));
}

async function renderOnCompanyOne() {
  const hook = renderHook(() => useCompany(), { wrapper });
  await waitFor(() => expect(hook.result.current.selectedCompany?.id).toBe(1));
  harness.fetchSessionCompany.mockClear();
  return hook;
}

/** Only a real hidden -> visible page return should trigger reconciliation. */
async function returnFromAnotherBrowserTab() {
  const visibility = vi.spyOn(document, "visibilityState", "get");
  try {
    await act(async () => {
      visibility.mockReturnValue("hidden");
      document.dispatchEvent(new Event("visibilitychange"));
      visibility.mockReturnValue("visible");
      document.dispatchEvent(new Event("visibilitychange"));
    });
  } finally {
    visibility.mockRestore();
  }
}

describe("company selection across browser tabs", () => {
  beforeEach(() => {
    FakeBroadcastChannel.instances.clear();
    vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
    localStorage.clear();
    localStorage.setItem("selectedCompanyId", "1");
    sessionCompanyId = 1;
    harness.apiRequest.mockReset();
    harness.apiRequest.mockResolvedValue({ ok: true });
    harness.fetchSessionCompany.mockReset();
    harness.fetchSessionCompany.mockImplementation(async () => ({ companyId: sessionCompanyId }));
  });

  afterEach(() => {
    queryClient.clear();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    FakeBroadcastChannel.instances.clear();
  });

  it("adopts the session company after another tab switches, without writing the session", async () => {
    const { result } = await renderOnCompanyOne();

    await act(async () => {
      otherTabSwitchedTo(2);
    });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(2));
    expect(harness.apiRequest).not.toHaveBeenCalled();
    expect(localStorage.getItem("selectedCompanyId")).toBe("2");
  });

  it("follows the session, not a stale event, when switches arrive out of order", async () => {
    const { result } = await renderOnCompanyOne();

    await act(async () => {
      // The event names company 2, but the session has already moved on to 3.
      otherTabSwitchedTo(3, "2");
    });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(3));
    expect(harness.apiRequest).not.toHaveBeenCalled();
  });

  it("retries when the session company cannot be read", async () => {
    const { result } = await renderOnCompanyOne();
    harness.fetchSessionCompany.mockRejectedValueOnce(new Error("offline"));

    await act(async () => {
      otherTabSwitchedTo(2);
    });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(2), { timeout: 5000 });
    // One failed probe, then a successful probe and an in-queue confirmation.
    expect(harness.fetchSessionCompany).toHaveBeenCalledTimes(3);
    expect(harness.apiRequest).not.toHaveBeenCalled();
  });

  it("ignores unrelated events and refuses unassigned session companies", async () => {
    const { result } = await renderOnCompanyOne();

    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "language", newValue: "2" }));
      window.dispatchEvent(new StorageEvent("storage", { key: "selectedCompanyId", newValue: null }));
    });
    expect(harness.fetchSessionCompany).not.toHaveBeenCalled();

    // Even a hint that names the currently displayed company should trigger
    // verification, because a server switch may not have changed the key.
    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "selectedCompanyId", newValue: "1" }));
    });
    await waitFor(() => expect(harness.fetchSessionCompany).toHaveBeenCalled());

    await act(async () => {
      otherTabSwitchedTo(99);
    });
    // One same-company probe plus the initial and in-queue probes for 99.
    await waitFor(() => expect(harness.fetchSessionCompany).toHaveBeenCalledTimes(3));

    expect(result.current.selectedCompany?.id).toBe(1);
    expect(harness.apiRequest).not.toHaveBeenCalled();
  });
  it("reconciles a missed company event when a background tab returns to focus", async () => {
    const { result } = await renderOnCompanyOne();
    sessionCompanyId = 2;

    await returnFromAnotherBrowserTab();

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(2));
    expect(localStorage.getItem("selectedCompanyId")).toBe("2");
    expect(harness.apiRequest).not.toHaveBeenCalled();
  });

  it("does not interrupt active work for duplicate foreground focus and initial pageshow events", async () => {
    const { result } = await renderOnCompanyOne();

    await act(async () => {
      window.dispatchEvent(new Event("blur"));
      window.dispatchEvent(new Event("focus")); // foreground window focus is not a browser-tab return
      window.dispatchEvent(new Event("pageshow")); // not a BFCache restore
      document.dispatchEvent(new Event("visibilitychange")); // still visible
      window.dispatchEvent(new Event("focus"));
    });

    expect(harness.fetchSessionCompany).not.toHaveBeenCalled();
    expect(result.current.isCheckingCompanySession).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.selectedCompany?.id).toBe(1);
  });

  it("checks once per genuine browser-tab return without a blocking overlay for a quick response", async () => {
    const { result } = await renderOnCompanyOne();
    await returnFromAnotherBrowserTab();

    await waitFor(() => expect(harness.fetchSessionCompany).toHaveBeenCalledTimes(1));
    expect(result.current.selectedCompany?.id).toBe(1);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isCheckingCompanySession).toBe(false);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("pageshow")); // not BFCache
    });
    expect(harness.fetchSessionCompany).toHaveBeenCalledTimes(1);
    expect(result.current.isCheckingCompanySession).toBe(false);
  });

  it("follows a committed switch pulse even if the saved company ID did not change", async () => {
    const { result } = await renderOnCompanyOne();
    sessionCompanyId = 3;

    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: COMPANY_SESSION_STORAGE_PULSE,
          newValue: JSON.stringify({
            type: "company-committed",
            companyId: 1, // stale hint; the server has already moved to 3
            sourceId: "other-tab",
            nonce: "pulse-1",
          }),
        })
      );
    });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(3));
    expect(localStorage.getItem("selectedCompanyId")).toBe("3");
    expect(harness.apiRequest).not.toHaveBeenCalled();
  });

  it("adopts a broadcast company's authoritative session without a storage event", async () => {
    const { result } = await renderOnCompanyOne();
    sessionCompanyId = 2;
    const sender = new BroadcastChannel(COMPANY_SESSION_CHANNEL);

    await act(async () => {
      sender.postMessage({
        type: "company-committed",
        companyId: 3, // must not be trusted: the server actually chose 2
        sourceId: "other-tab",
        nonce: "broadcast-1",
      });
    });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(2));
    expect(localStorage.getItem("selectedCompanyId")).toBe("2");
    expect(harness.apiRequest).not.toHaveBeenCalled();
    sender.close();
  });

  it("immediately covers old records and switches only after server confirmation", async () => {
    const { result } = await renderOnCompanyOne();
    let resolveSession!: (value: { companyId: number }) => void;
    harness.fetchSessionCompany.mockImplementationOnce(
      () =>
        new Promise<{ companyId: number }>((resolve) => {
          resolveSession = resolve;
        })
    );

    await act(async () => {
      otherTabSwitchedTo(2);
    });
    expect(result.current.selectedCompany?.id).toBe(1);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isCheckingCompanySession).toBe(true);
    await waitFor(() => expect(harness.fetchSessionCompany).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveSession({ companyId: 2 });
    });
    await waitFor(() => {
      expect(result.current.selectedCompany?.id).toBe(2);
      expect(result.current.isLoading).toBe(false);
    });
  });

  it("keeps a resumed tab loading and unmasked while a slow same-company check runs", async () => {
    const { result } = await renderOnCompanyOne();
    let resolveSession!: (value: { companyId: number }) => void;
    harness.fetchSessionCompany.mockImplementationOnce(
      () =>
        new Promise<{ companyId: number }>((resolve) => {
          resolveSession = resolve;
        })
    );
    const before = captureCompanyReadSnapshot();

    await returnFromAnotherBrowserTab();
    await waitFor(() => expect(harness.fetchSessionCompany).toHaveBeenCalledTimes(1));
    // However long the probe takes, the page keeps reading and saving:
    // requests already on their way and new ones are both still admitted.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(result.current.isCheckingCompanySession).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(() => assertCompanyReadSnapshot(before)).not.toThrow();
    expect(captureCompanyReadSnapshot().transitioning).toBe(false);

    await act(async () => {
      resolveSession({ companyId: 1 });
    });
    expect(() => assertCompanyReadSnapshot(before)).not.toThrow();
    expect(result.current.selectedCompany?.id).toBe(1);
    expect(harness.apiRequest).not.toHaveBeenCalled();
  });

  it("leaves a resumed tab working when the session check cannot reach the server", async () => {
    const { result } = await renderOnCompanyOne();
    harness.fetchSessionCompany.mockRejectedValue(new Error("offline"));
    const before = captureCompanyReadSnapshot();

    await returnFromAnotherBrowserTab();
    await waitFor(() => expect(harness.fetchSessionCompany).toHaveBeenCalledTimes(1));

    expect(() => assertCompanyReadSnapshot(before)).not.toThrow();
    expect(result.current.isCheckingCompanySession).toBe(false);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.selectedCompany?.id).toBe(1);
  });

  it("fences a resumed tab at once when the saved selection shows a missed switch", async () => {
    const { result } = await renderOnCompanyOne();
    let resolveSession!: (value: { companyId: number }) => void;
    harness.fetchSessionCompany.mockImplementationOnce(
      () =>
        new Promise<{ companyId: number }>((resolve) => {
          resolveSession = resolve;
        })
    );
    // Another tab switched while this one was suspended; its event never arrived.
    sessionCompanyId = 2;
    localStorage.setItem("selectedCompanyId", "2");
    const before = captureCompanyReadSnapshot();

    await returnFromAnotherBrowserTab();
    expect(result.current.isCheckingCompanySession).toBe(true);
    expect(() => assertCompanyReadSnapshot(before)).toThrow();
    await waitFor(() => expect(harness.fetchSessionCompany).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveSession({ companyId: 2 });
    });
    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(2));
    expect(result.current.isCheckingCompanySession).toBe(false);
  });

  it("does not wait to mask records when another tab sends a company-switch hint", async () => {
    const { result } = await renderOnCompanyOne();
    let resolveSession!: (value: { companyId: number }) => void;
    harness.fetchSessionCompany.mockImplementationOnce(
      () =>
        new Promise<{ companyId: number }>((resolve) => {
          resolveSession = resolve;
        })
    );

    await act(async () => {
      otherTabSwitchedTo(2);
    });
    expect(result.current.isCheckingCompanySession).toBe(true);
    expect(result.current.selectedCompany?.id).toBe(1);
    await waitFor(() => expect(harness.fetchSessionCompany).toHaveBeenCalledTimes(1));

    await act(async () => {
      resolveSession({ companyId: 2 });
    });
    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(2));
    expect(result.current.isCheckingCompanySession).toBe(false);
  });

  it("does not reveal an unassigned session company", async () => {
    const { result } = await renderOnCompanyOne();

    await act(async () => {
      otherTabSwitchedTo(99);
    });
    await waitFor(() => expect(harness.fetchSessionCompany).toHaveBeenCalledTimes(2));
    expect(result.current.selectedCompany?.id).toBe(1);
    expect(result.current.isLoading).toBe(true);
  });

  it("publishes a committed local selection to other tabs", async () => {
    const { result } = await renderOnCompanyOne();
    const listener = new BroadcastChannel(COMPANY_SESSION_CHANNEL);
    const messages: unknown[] = [];
    listener.addEventListener("message", (event: MessageEvent<unknown>) => messages.push(event.data));

    harness.apiRequest.mockImplementation(async (_method: string, url: string, body: { companyId: number }) => {
      if (url === "/api/auth/set-company") sessionCompanyId = body.companyId;
      return { ok: true };
    });

    await act(async () => {
      expect(await result.current.selectCompany(result.current.companies[1])).toBe(true);
    });

    expect(result.current.selectedCompany?.id).toBe(2);
    expect(messages).toEqual([expect.objectContaining({ type: "company-committed", companyId: 2 })]);
    expect(localStorage.getItem(COMPANY_SESSION_STORAGE_PULSE)).toContain('"companyId":2');
    listener.close();
  });
});

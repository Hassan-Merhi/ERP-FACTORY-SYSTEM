/**
 * CompanyProvider decides which company a session works in. On load it adopts
 * the company the server session already points at, or switches the session
 * to the saved / first company; an explicit selectCompany() writes the session
 * first and only then moves the UI. Getting this wrong shows one company's
 * data while the server is scoped to another, so each path is pinned here by
 * what reaches the server and what the provider ends up selecting.
 * (Cross-tab following has its own suite: company-cross-tab-sync.test.tsx.)
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const harness = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  fetchSessionCompany: vi.fn(),
  refreshRealtimeSessionScope: vi.fn(),
  assignments: [] as Array<Record<string, unknown>>,
  listError: null as Error | null,
}));

vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...actual, apiRequest: harness.apiRequest };
});
vi.mock("@/hooks/use-ws-invalidation", () => ({ refreshRealtimeSessionScope: harness.refreshRealtimeSessionScope }));
vi.mock("@/contracts/sessionQueryContracts", () => ({
  fetchSessionCompany: harness.fetchSessionCompany,
  userCompaniesQueryOptions: () => ({
    queryKey: ["/api/user/companies"],
    queryFn: async () => {
      if (harness.listError) throw harness.listError;
      return harness.assignments;
    },
    retry: false,
    staleTime: Infinity,
  }),
}));

import { queryClient } from "@/lib/queryClient";
import { CompanyProvider, useCompany } from "@/contexts/CompanyContext";

function assignment(id: number, overrides: Record<string, unknown> = {}) {
  return {
    companyId: id,
    companyCode: `C${id}`,
    companyName: `Company ${id}`,
    companyActive: true,
    role: "Admin",
    companyType: "erp",
    ...overrides,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <CompanyProvider>{children}</CompanyProvider>
    </QueryClientProvider>
  );
}

const switchCalls = () => harness.apiRequest.mock.calls.filter(([, url]) => url === "/api/auth/set-company");
const prefetched = () =>
  queryClient
    .getQueryCache()
    .getAll()
    .map((query) => query.queryKey[0])
    .filter((key) => key === "/api/suppliers");

let sessionCompanyId: number | null = 1;

beforeEach(() => {
  localStorage.clear();
  harness.assignments = [assignment(1), assignment(2), assignment(3)];
  harness.listError = null;
  sessionCompanyId = 1;
  harness.apiRequest.mockReset();
  harness.apiRequest.mockResolvedValue({ ok: true });
  harness.fetchSessionCompany.mockReset();
  harness.fetchSessionCompany.mockImplementation(async () => ({ companyId: sessionCompanyId }));
  harness.refreshRealtimeSessionScope.mockReset();
});

afterEach(() => {
  queryClient.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("initial company selection", () => {
  it("adopts the saved company without writing the session when the session already points at it", async () => {
    localStorage.setItem("selectedCompanyId", "2");
    sessionCompanyId = 2;
    const { result } = renderHook(() => useCompany(), { wrapper });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(2));
    expect(switchCalls()).toHaveLength(0);
    expect(result.current.isLoading).toBe(false);
    expect(prefetched()).toHaveLength(1);
  });

  it("switches the session to the saved company when the session points elsewhere", async () => {
    localStorage.setItem("selectedCompanyId", "3");
    const { result } = renderHook(() => useCompany(), { wrapper });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(3));
    expect(switchCalls()).toEqual([["POST", "/api/auth/set-company", { companyId: 3 }]]);
    expect(harness.refreshRealtimeSessionScope).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("selectedCompanyId")).toBe("3");
  });

  it.each([
    ["no saved company", null],
    ["a saved id that is not a positive integer", "abc"],
    ["a saved company the user is no longer assigned to", "99"],
  ])("falls back to the first company for %s", async (_label, saved) => {
    if (saved) localStorage.setItem("selectedCompanyId", saved);
    sessionCompanyId = 2;
    const { result } = renderHook(() => useCompany(), { wrapper });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(1));
    expect(switchCalls()).toEqual([["POST", "/api/auth/set-company", { companyId: 1 }]]);
  });

  it("treats an unreadable session company as unknown and switches", async () => {
    harness.fetchSessionCompany.mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() => useCompany(), { wrapper });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(1));
    expect(switchCalls()).toHaveLength(1);
  });

  it("adopts the session's own company when the switch to the saved one is refused", async () => {
    localStorage.setItem("selectedCompanyId", "3");
    sessionCompanyId = 2;
    harness.apiRequest.mockResolvedValue({ ok: false });
    const { result } = renderHook(() => useCompany(), { wrapper });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(2));
    expect(switchCalls()).toHaveLength(1);
  });

  it("retries after two seconds when the switch is refused and the session company is not the user's", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    sessionCompanyId = 42;
    harness.apiRequest.mockResolvedValueOnce({ ok: false }).mockResolvedValue({ ok: true });
    const { result } = renderHook(() => useCompany(), { wrapper });

    await waitFor(() => expect(switchCalls()).toHaveLength(1));
    expect(result.current.selectedCompany).toBeNull();
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(error).toHaveBeenCalled());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(1));
    expect(switchCalls()).toHaveLength(2);
  });

  it("selects offline without contacting the server when the browser is offline", async () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    localStorage.setItem("selectedCompanyId", "2");
    const { result } = renderHook(() => useCompany(), { wrapper });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(2));
    expect(switchCalls()).toHaveLength(0);
    expect(harness.fetchSessionCompany).not.toHaveBeenCalled();
    expect(prefetched()).toHaveLength(0);
  });

  it("lists each assigned company once and maps its permissions", async () => {
    harness.assignments = [
      assignment(1, { role: "POS", assignedLocationId: 7, posViewOnly: true }),
      assignment(1, { role: "Admin" }),
      assignment(2),
    ];
    const { result } = renderHook(() => useCompany(), { wrapper });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(1));
    expect(result.current.companies.map((company) => company.id)).toEqual([1, 2]);
    expect(result.current.selectedCompany).toMatchObject({
      code: "C1",
      role: "POS",
      assignedLocationId: 7,
      posViewOnly: true,
    });
  });

  it("does not prefetch reference data for a POS cashier", async () => {
    harness.assignments = [assignment(1, { role: "POS" })];
    const { result } = renderHook(() => useCompany(), { wrapper });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(1));
    expect(prefetched()).toHaveLength(0);
  });

  it("reports a failed company list and selects nothing", async () => {
    harness.listError = new Error("companies unavailable");
    const { result } = renderHook(() => useCompany(), { wrapper });

    await waitFor(() => expect(result.current.error?.message).toBe("companies unavailable"));
    expect(result.current.selectedCompany).toBeNull();
  });
});

describe("selectCompany", () => {
  async function renderOnCompanyOne() {
    const hook = renderHook(() => useCompany(), { wrapper });
    await waitFor(() => expect(hook.result.current.selectedCompany?.id).toBe(1));
    harness.apiRequest.mockClear();
    harness.refreshRealtimeSessionScope.mockClear();
    return hook;
  }

  it("writes the session, then moves the UI, storage and realtime scope to the new company", async () => {
    const { result } = await renderOnCompanyOne();

    let ok = false;
    await act(async () => {
      ok = await result.current.selectCompany(result.current.companies[1]);
    });

    expect(ok).toBe(true);
    expect(switchCalls()).toEqual([["POST", "/api/auth/set-company", { companyId: 2 }]]);
    expect(result.current.selectedCompany?.id).toBe(2);
    expect(localStorage.getItem("selectedCompanyId")).toBe("2");
    expect(harness.refreshRealtimeSessionScope).toHaveBeenCalledTimes(1);
  });

  it("keeps the current company and reports failure when the server refuses the switch", async () => {
    const { result } = await renderOnCompanyOne();
    harness.apiRequest.mockResolvedValue({ ok: false });

    let ok = true;
    await act(async () => {
      ok = await result.current.selectCompany(result.current.companies[2]);
    });

    expect(ok).toBe(false);
    expect(result.current.selectedCompany?.id).toBe(1);
    expect(localStorage.getItem("selectedCompanyId")).toBe("1");
  });

  it("treats a network error on the switch as a refusal", async () => {
    const { result } = await renderOnCompanyOne();
    harness.apiRequest.mockRejectedValue(new TypeError("Failed to fetch"));

    let ok = true;
    await act(async () => {
      ok = await result.current.selectCompany(result.current.companies[1]);
    });

    expect(ok).toBe(false);
    expect(result.current.selectedCompany?.id).toBe(1);
  });

  it("does nothing when re-selecting the already synced company", async () => {
    const { result } = await renderOnCompanyOne();

    let ok = false;
    await act(async () => {
      ok = await result.current.selectCompany(result.current.companies[0]);
    });

    expect(ok).toBe(true);
    expect(switchCalls()).toHaveLength(0);
  });

  it("switches offline without contacting the server", async () => {
    const { result } = await renderOnCompanyOne();

    await act(async () => {
      await result.current.selectCompany(result.current.companies[2], { offline: true });
    });

    expect(result.current.selectedCompany?.id).toBe(3);
    expect(switchCalls()).toHaveLength(0);
  });

  it("applies rapid switches in order, ending on the last one", async () => {
    const { result } = await renderOnCompanyOne();
    const order: number[] = [];
    harness.apiRequest.mockImplementation(async (_method: string, _url: string, body: { companyId: number }) => {
      order.push(body.companyId);
      return { ok: true };
    });

    await act(async () => {
      await Promise.all([
        result.current.selectCompany(result.current.companies[1]),
        result.current.selectCompany(result.current.companies[2]),
      ]);
    });

    expect(order).toEqual([2, 3]);
    expect(result.current.selectedCompany?.id).toBe(3);
  });
});

describe("useCompany", () => {
  it("refuses to run outside a CompanyProvider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useCompany())).toThrow("useCompany must be used within a CompanyProvider");
  });
});

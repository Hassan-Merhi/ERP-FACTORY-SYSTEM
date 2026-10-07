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

describe("company selection across browser tabs", () => {
  beforeEach(() => {
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
    expect(harness.fetchSessionCompany).toHaveBeenCalledTimes(2);
    expect(harness.apiRequest).not.toHaveBeenCalled();
  });

  it("ignores other keys, the current company and companies the user is not assigned to", async () => {
    const { result } = await renderOnCompanyOne();

    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "language", newValue: "2" }));
      window.dispatchEvent(new StorageEvent("storage", { key: "selectedCompanyId", newValue: "1" }));
      window.dispatchEvent(new StorageEvent("storage", { key: "selectedCompanyId", newValue: null }));
    });
    expect(harness.fetchSessionCompany).not.toHaveBeenCalled();

    await act(async () => {
      otherTabSwitchedTo(99);
    });
    await waitFor(() => expect(harness.fetchSessionCompany).toHaveBeenCalled());

    expect(result.current.selectedCompany?.id).toBe(1);
    expect(harness.apiRequest).not.toHaveBeenCalled();
  });
});

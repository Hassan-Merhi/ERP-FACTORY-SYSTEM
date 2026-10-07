import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  apiRequest: vi.fn(),
  sessionCompanyId: 1 as number | null,
}));

vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return { ...actual, apiRequest: harness.apiRequest };
});

vi.mock("@/hooks/use-ws-invalidation", () => ({ refreshRealtimeSessionScope: vi.fn() }));

vi.mock("@/contracts/sessionQueryContracts", () => ({
  fetchSessionCompany: vi.fn(async () => ({ companyId: harness.sessionCompanyId })),
  userCompaniesQueryOptions: () => ({
    queryKey: ["/api/user/companies"],
    queryFn: async () =>
      [1, 2].map((id) => ({
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

function otherTabSelects(companyId: string | null) {
  window.dispatchEvent(new StorageEvent("storage", { key: "selectedCompanyId", newValue: companyId }));
}

describe("company selection across browser tabs", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem("selectedCompanyId", "1");
    harness.sessionCompanyId = 1;
    harness.apiRequest.mockReset();
    harness.apiRequest.mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("follows a company switch made in another tab of the same session", async () => {
    const { result } = renderHook(() => useCompany(), { wrapper });
    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(1));
    expect(harness.apiRequest).not.toHaveBeenCalled();

    await act(async () => {
      otherTabSelects("2");
    });

    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(2));
    expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/auth/set-company", { companyId: 2 });
  });

  it("ignores other keys, the current company and companies the user is not assigned to", async () => {
    const { result } = renderHook(() => useCompany(), { wrapper });
    await waitFor(() => expect(result.current.selectedCompany?.id).toBe(1));

    await act(async () => {
      window.dispatchEvent(new StorageEvent("storage", { key: "language", newValue: "2" }));
      otherTabSelects("1");
      otherTabSelects("99");
      otherTabSelects(null);
    });

    expect(result.current.selectedCompany?.id).toBe(1);
    expect(harness.apiRequest).not.toHaveBeenCalled();
  });
});

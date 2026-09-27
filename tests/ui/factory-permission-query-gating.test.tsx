/**
 * Factory protected query gating, observed through the requests a page makes.
 *
 * Each Factory surface below reads data that belongs to another page or tab.
 * When the current user cannot see that owning surface, the read must never be
 * sent; when they can, it must be. The pages are mounted with /api/factory/my-access
 * already resolved and every GET recorded, so the assertions are about network
 * behaviour rather than the wording of an `enabled:` expression.
 */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { FactoryMyAccess } from "@shared/apiTypes";
import { renderWithProviders } from "./helpers";
import { pageState, resetPageState, seededPayload } from "./pageMocks";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/AppModeContext", async () => (await import("./pageMocks")).appModeMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/CurrencyContext", async () => (await import("./pageMocks")).currencyMock);
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);
vi.mock("@/contexts/ConnectivityContext", async () => (await import("./pageMocks")).connectivityMock);
vi.mock("@/contexts/LocationContext", async () => (await import("./pageMocks")).locationContextMock);
vi.mock("@/contexts/CursorNavContext", async () => (await import("./pageMocks")).cursorNavMock);

const MY_ACCESS_KEY = ["/api/factory/my-access"] as const;

function access(overrides: Partial<FactoryMyAccess> = {}): FactoryMyAccess {
  return {
    fullAccess: false,
    pageKeys: ["factory/payroll-hub", "factory/stock-entry"],
    hasErpAccess: true,
    hasFactoryAccess: true,
    hiddenCostFields: [],
    hideAllCosts: false,
    companyId: 1,
    companyName: "Factory",
    ...overrides,
  };
}

let requested: string[] = [];

/** Record every request URL and answer it from `routes` or the generic seeded payload. */
function recordFetch(routes: Record<string, () => unknown> = {}) {
  requested = [];
  (global as any).fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    requested.push(url);
    const match = Object.keys(routes).find((fragment) => url.includes(fragment));
    const body = match ? routes[match]() : seededPayload();
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      blob: async () => new Blob([]),
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: new Headers({ "content-type": "application/json" }),
      clone() {
        return this;
      },
    };
  });
}

const wasRequested = (fragment: string) => requested.some((url) => url.includes(fragment));

/** Wait until the page has demonstrably issued its unguarded reads, then settle. */
async function settleAfter(fragment: string) {
  await waitFor(() => expect(wasRequested(fragment)).toBe(true));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

/** For hooks with no unconditional read to wait on: let every enabled query fire. */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 200));
}

beforeEach(() => {
  resetPageState();
  pageState.companyType = "factory";
  pageState.appMode = "factory";
});

describe("Factory Overview payroll reads", () => {
  async function mountHook(myAccess: FactoryMyAccess) {
    const { useDailyProductionReport } = await import("@/pages/factory/dailyproductionreport/useDailyProductionReport");
    const client = new QueryClient({
      defaultOptions: {
        queries: {
          retry: false,
          staleTime: Infinity,
          queryFn: async ({ queryKey }) => (await fetch(String(queryKey[0]))).json(),
        },
      },
    });
    client.setQueryData(["/api/auth/me"], { id: "test-user", role: "Developer" });
    client.setQueryData(MY_ACCESS_KEY, myAccess);
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    return renderHook(() => useDailyProductionReport(), { wrapper });
  }

  it("does not read the attendance report or salary summary when their Payroll tabs are hidden", async () => {
    recordFetch();
    await mountHook(access({ hiddenCostFields: ["hide_tab_workers_report", "hide_tab_workers_payroll"] }));
    await settle();

    expect(wasRequested("/api/factory/workers/attendance-report")).toBe(false);
    expect(wasRequested("/api/factory/monthly-salary-summary")).toBe(false);
  });

  it("does not read either payroll surface without the Payroll & Benefits page", async () => {
    recordFetch();
    await mountHook(access({ pageKeys: ["factory/stock-entry"] }));
    await settle();

    expect(wasRequested("/api/factory/workers/attendance-report")).toBe(false);
    expect(wasRequested("/api/factory/monthly-salary-summary")).toBe(false);
  });

  it("reads both payroll surfaces when their owning tabs are visible", async () => {
    recordFetch();
    await mountHook(access());

    await waitFor(() => {
      expect(wasRequested("/api/factory/workers/attendance-report")).toBe(true);
      expect(wasRequested("/api/factory/monthly-salary-summary")).toBe(true);
    });
  });
});

describe("Factory Stock Entry production-session read", () => {
  async function mount(myAccess: FactoryMyAccess) {
    const { default: BaleStockEntry } = await import("@/pages/factory/BaleStockEntry");
    renderWithProviders(<BaleStockEntry />, { seedQueries: [[MY_ACCESS_KEY, myAccess]] });
  }

  it("does not read the production session when Production Targets is hidden", async () => {
    recordFetch();
    await mount(access({ hiddenCostFields: ["hide_tab_stockentry_production_targets"] }));
    await settleAfter("/api/factory/settings");

    expect(wasRequested("/api/factory/stock-entry/production-session")).toBe(false);
  });

  it("reads the production session when Production Targets is visible", async () => {
    recordFetch();
    await mount(access());

    await waitFor(() => expect(wasRequested("/api/factory/stock-entry/production-session")).toBe(true));
  });
});

describe("Factory Stock Entry History support reads", () => {
  async function mount(myAccess: FactoryMyAccess) {
    const { default: StockEntryHistory } = await import("@/pages/StockEntryHistory");
    renderWithProviders(<StockEntryHistory />, { seedQueries: [[MY_ACCESS_KEY, myAccess]] });
  }

  const historyRoutes = {
    "/api/factory/bales/stock-entry-history": () => ({ items: [], total: 0, page: 1, pageSize: 50 }),
  };

  it("does not read the worker picker or production targets when their owning tabs are hidden", async () => {
    recordFetch(historyRoutes);
    await mount(
      access({ hiddenCostFields: ["hide_tab_payrollhub_workers", "hide_tab_stockentry_production_targets"] })
    );
    await settleAfter("/api/factory/bales/stock-entry-history");

    expect(wasRequested("/api/factory/workers?profile=picker")).toBe(false);
    expect(wasRequested("/api/factory/staff-tracking")).toBe(false);
  });

  it("reads the worker picker and production targets when their owning tabs are visible", async () => {
    recordFetch(historyRoutes);
    await mount(access());

    await waitFor(() => {
      expect(wasRequested("/api/factory/workers?profile=picker")).toBe(true);
      expect(wasRequested("/api/factory/staff-tracking")).toBe(true);
    });
  });
});

describe("Container Verification loaded-items read", () => {
  async function mount(containerBody: unknown) {
    recordFetch({
      "/api/containers/5/loaded-items": () => [],
      "/api/containers/5": () => containerBody,
    });
    pageState.params = { containerId: "5" };
    const { default: ContainerVerification } = await import("@/pages/ContainerVerification");
    renderWithProviders(<ContainerVerification />);
  }

  it("does not read loaded items until the owned container record resolves", async () => {
    await mount({});
    await settleAfter("/api/containers/5");

    expect(wasRequested("/api/containers/5/loaded-items")).toBe(false);
  });

  it("reads loaded items once the container record is available", async () => {
    await mount({ container: { id: 5, containerNumber: "CONT-5" } });

    await waitFor(() => expect(wasRequested("/api/containers/5/loaded-items")).toBe(true));
  });
});

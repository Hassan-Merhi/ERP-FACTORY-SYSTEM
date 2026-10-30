/**
 * Small hooks and clients that each guard one behaviour:
 *
 * - salesReportBandwidthClient: summary and export fetches reject bad
 *   answers, export bypasses caches, and writes invalidate every report.
 * - useButtonClickFeedback: the last clicked button flashes, one at a time.
 * - LocationProvider: the selected location resets when the company changes.
 * - useZmwVoucherRate: the voucher-date USD/ZMW rate, only when it is usable.
 * - useIsMobile: follows the mobile media query, or the width without one.
 * - useAdminOverride: admins act at once; others confirm, then skip the
 *   dialog for five minutes.
 */
import React, { useRef } from "react";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { queryClient } from "@/lib/queryClient";
import {
  fetchSalesReportRows,
  fetchSalesReportSummary,
  invalidateSalesReportQueries,
} from "@/lib/salesReportBandwidthClient";
import { useButtonClickFeedback } from "@/hooks/use-button-click-feedback";
import { LocationProvider, useLocation } from "@/contexts/LocationContext";
import { useZmwVoucherRate } from "@/hooks/useZmwVoucherRate";
import { useIsMobile } from "@/hooks/use-mobile";
import { useAdminOverride } from "@/hooks/use-admin-override";
import { installFakeApi, respond, type FakeApi } from "./fakeApi";

const state = vi.hoisted(() => ({
  company: { id: 4 } as { id: number } | null,
  displayCurrency: "ZMW",
}));

vi.mock("@/contexts/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: state.company }) }));
vi.mock("@/contexts/CurrencyContext", () => ({
  useCurrencyContext: () => ({ displayCurrency: state.displayCurrency }),
}));
vi.mock("@/components/AdminOverrideDialog", () => ({
  AdminOverrideDialog: ({
    open,
    actionLabel,
    onSuccess,
    onCancel,
  }: {
    open: boolean;
    actionLabel?: string;
    onSuccess: () => void;
    onCancel: () => void;
  }) =>
    open ? (
      <div role="dialog">
        <span>{actionLabel}</span>
        <button onClick={onSuccess}>Verify</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
    ) : null,
}));

let api: FakeApi;
beforeEach(() => {
  api = installFakeApi();
  state.company = { id: 4 };
  state.displayCurrency = "ZMW";
});

function freshClient() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe("sales report client", () => {
  it("returns a valid summary and rejects failures and malformed answers", async () => {
    const summary = { groups: [], totals: { itemCount: 0 }, companies: [] };
    api.get("/api/sales-report/summary", summary);
    await expect(fetchSalesReportSummary("/api/sales-report/summary")).resolves.toEqual(summary);

    api.get("/api/sales-report/summary", respond(500, {}));
    await expect(fetchSalesReportSummary("/api/sales-report/summary")).rejects.toThrow("failed: 500");

    for (const bad of [null, { groups: {}, totals: {} }, { groups: [] }]) {
      api.get("/api/sales-report/summary", () => bad as object);
      await expect(fetchSalesReportSummary("/api/sales-report/summary")).rejects.toThrow("Invalid");
    }
  });

  it("exports fresh rows, bypassing caches, and rejects bad answers", async () => {
    api.get("/api/sales-report", [{ id: 1 }]);
    await expect(fetchSalesReportRows("/api/sales-report?from=a")).resolves.toEqual([{ id: 1 }]);
    expect(api.callsTo("GET", "/api/sales-report")[0].url).toContain("__refresh=1");

    api.get("/api/sales-report", { rows: [] });
    await expect(fetchSalesReportRows("/api/sales-report")).rejects.toThrow("Invalid");
    api.get("/api/sales-report", respond(403, {}));
    await expect(fetchSalesReportRows("/api/sales-report")).rejects.toThrow("failed: 403");
  });

  it("invalidates every sales report query and nothing else", () => {
    queryClient.clear();
    for (const key of [["/api/sales-report?x=1"], ["/api/dashboard/sales-report/summary"], ["/api/bales"], [7]]) {
      queryClient.setQueryData(key, []);
    }

    invalidateSalesReportQueries();

    const invalidated = queryClient
      .getQueryCache()
      .getAll()
      .filter((query) => query.state.isInvalidated)
      .map((query) => query.queryKey[0]);
    expect(invalidated).toEqual(["/api/sales-report?x=1", "/api/dashboard/sales-report/summary"]);
    queryClient.clear();
  });
});

describe("useButtonClickFeedback", () => {
  function Panel() {
    const ref = useRef<HTMLDivElement>(null);
    useButtonClickFeedback(ref);
    return (
      <div ref={ref}>
        <button>One</button>
        <div role="button">
          <span>Two</span>
        </div>
        <button data-no-flash>Quiet</button>
        <button disabled>Off</button>
        <p>Text</p>
      </div>
    );
  }

  it("flashes the last clicked control only, skipping opted-out and disabled ones", () => {
    const { unmount } = render(<Panel />);
    const flashing = () => Array.from(document.querySelectorAll(".btn-click-flash")).map((el) => el.textContent);

    screen.getByText("One").click();
    expect(flashing()).toEqual(["One"]);
    screen.getByText("Two").click();
    expect(flashing()).toEqual(["Two"]);
    screen.getByText("Quiet").click();
    screen.getByText("Off").click();
    screen.getByText("Text").click();
    expect(flashing()).toEqual(["Two"]);

    const one = screen.getByText("One");
    unmount();
    one.click();
    expect(one.classList.contains("btn-click-flash")).toBe(false);
  });

  it("does nothing without a container", () => {
    function Bare() {
      const ref = useRef<HTMLDivElement>(null);
      useButtonClickFeedback(ref);
      return null;
    }
    expect(() => render(<Bare />)).not.toThrow();
  });
});

describe("LocationProvider", () => {
  it("clears the selected location when the company changes", () => {
    const { result, rerender } = renderHook(() => useLocation(), {
      wrapper: ({ children }) => <LocationProvider>{children}</LocationProvider>,
    });
    const location = { id: 1, code: "L1", name: "Main", city: null, state: null, country: null };

    act(() => result.current.setSelectedLocation(location));
    rerender();
    expect(result.current.selectedLocation).toEqual(location);

    state.company = { id: 5 };
    rerender();
    expect(result.current.selectedLocation).toBeNull();
  });

  it("refuses to run outside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => renderHook(() => useLocation())).toThrow(/within a LocationProvider/);
    vi.restoreAllMocks();
  });
});

describe("useZmwVoucherRate", () => {
  it("returns the approved rate for the voucher date", async () => {
    api.get("/api/exchange-rates/latest", { rate: "27.5" });
    const { result } = renderHook(() => useZmwVoucherRate("2026-10-01"), { wrapper: freshClient().wrapper });

    await waitFor(() => expect(result.current.rate).toBe(27.5));
    expect(result.current.unavailable).toBe(false);
    const url = new URL(api.callsTo("GET", "/api/exchange-rates/latest")[0].url, "http://x");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      companyId: "4",
      fromCurrency: "USD",
      toCurrency: "ZMW",
      asOf: "2026-10-01",
    });
  });

  it.each([
    ["a refused lookup", () => respond(404, {})],
    ["no rate", () => null],
    ["a zero rate", () => ({ rate: "0" })],
  ])("reports %s as unusable", async (_label, body) => {
    api.get("/api/exchange-rates/latest", body as () => object);
    const { result } = renderHook(() => useZmwVoucherRate("2026-10-01"), { wrapper: freshClient().wrapper });

    await waitFor(() => expect(api.callsTo("GET", "/api/exchange-rates/latest")).toHaveLength(1));
    await waitFor(() => expect(result.current.isFetching).toBe(false));
    expect(result.current.rate).toBeNull();
  });

  it("marks a missing or refused rate unavailable", async () => {
    api.get("/api/exchange-rates/latest", respond(404, {}));
    const { result } = renderHook(() => useZmwVoucherRate("2026-10-01"), { wrapper: freshClient().wrapper });

    await waitFor(() => expect(result.current.unavailable).toBe(true));
  });

  it("does not look up a rate outside ZMW display, without a company or without a date", async () => {
    state.displayCurrency = "USD";
    const usd = renderHook(() => useZmwVoucherRate("2026-10-01"), { wrapper: freshClient().wrapper });
    expect(usd.result.current).toMatchObject({ isZmw: false, rate: null, unavailable: false });

    state.displayCurrency = "ZMW";
    state.company = null;
    renderHook(() => useZmwVoucherRate("2026-10-01"), { wrapper: freshClient().wrapper });
    state.company = { id: 4 };
    renderHook(() => useZmwVoucherRate(null), { wrapper: freshClient().wrapper });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(api.callsTo("GET", "/api/exchange-rates/latest")).toHaveLength(0);
  });
});

describe("useIsMobile", () => {
  const realMatchMedia = window.matchMedia;
  afterEach(() => {
    window.matchMedia = realMatchMedia;
  });

  function fakeQuery(matches: boolean, legacy = false) {
    const listeners = new Set<(event: { matches: boolean }) => void>();
    const mql = {
      matches,
      addListener: vi.fn((fn) => listeners.add(fn)),
      removeListener: vi.fn((fn) => listeners.delete(fn)),
      ...(legacy
        ? {}
        : {
            addEventListener: vi.fn((_type, fn) => listeners.add(fn)),
            removeEventListener: vi.fn((_type, fn) => listeners.delete(fn)),
          }),
    };
    window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
    return { mql, emit: (value: boolean) => listeners.forEach((fn) => fn({ matches: value })), listeners };
  }

  it.each([false, true])("follows the media query (legacy listeners: %s)", (legacy) => {
    const media = fakeQuery(true, legacy);
    const { result, unmount } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);

    act(() => media.emit(false));
    expect(result.current).toBe(false);

    unmount();
    expect(media.listeners.size).toBe(0);
    expect(legacy ? media.mql.removeListener : media.mql.removeEventListener).toHaveBeenCalled();
  });

  it("falls back to the window width without matchMedia", () => {
    window.matchMedia = undefined as never;
    const width = window.innerWidth;
    window.innerWidth = 500;
    const { result, unmount } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);

    window.innerWidth = 1200;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    expect(result.current).toBe(false);

    unmount();
    window.innerWidth = 300;
    window.dispatchEvent(new Event("resize"));
    expect(result.current).toBe(false);
    window.innerWidth = width;
  });
});

describe("useAdminOverride", () => {
  function Actions({ action }: { action: () => void }) {
    const { wrapAdminAction, AdminDialog } = useAdminOverride();
    return (
      <>
        <button onClick={() => wrapAdminAction(action, "Delete bale")}>Delete</button>
        {AdminDialog}
      </>
    );
  }

  function renderAs(role: string, action: () => void) {
    const { client, wrapper } = freshClient();
    client.setQueryData(["/api/auth/me"], { role });
    return render(<Actions action={action} />, { wrapper });
  }

  it("runs an admin's action at once", () => {
    const action = vi.fn();
    renderAs("Owner", action);

    act(() => screen.getByText("Delete").click());

    expect(action).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks anyone else to confirm, runs nothing on cancel, then trusts a verified user for five minutes", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const action = vi.fn();
    renderAs("Clerk", action);

    act(() => screen.getByText("Delete").click());
    expect(screen.getByRole("dialog")).toHaveTextContent("Delete bale");
    act(() => screen.getByText("Cancel").click());
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(action).not.toHaveBeenCalled();

    act(() => screen.getByText("Delete").click());
    act(() => screen.getByText("Verify").click());
    expect(action).toHaveBeenCalledTimes(1);

    act(() => screen.getByText("Delete").click());
    expect(action).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("dialog")).toBeNull();

    vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
    act(() => screen.getByText("Delete").click());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(action).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

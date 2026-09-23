/**
 * Shared deterministic context mocks for page-mount tests.
 *
 * `renders.test.tsx` and `renders-uncovered-pages.test.tsx` each inline the
 * same block. New page suites reuse this module instead:
 *
 *   vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
 *   vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
 *
 * `pageState` is mutable so a suite can switch company type, app mode or
 * location between cases without re-declaring the mocks.
 */
import React from "react";

export const pageState = {
  companyType: "erp" as string,
  appMode: "erp" as string,
  location: "/",
  params: {} as Record<string, string>,
  search: "",
  selectedLocation: null as null | { id: number; name: string; [key: string]: unknown },
  navigate: vi.fn(),
};

export function resetPageState() {
  pageState.companyType = "erp";
  pageState.appMode = "erp";
  pageState.location = "/";
  pageState.params = {};
  pageState.search = "";
  pageState.selectedLocation = null;
  pageState.navigate = vi.fn();
}

export const wouterMock = {
  useLocation: () => [pageState.location, (to: string) => pageState.navigate(to)],
  useRoute: () => [Object.keys(pageState.params).length > 0, pageState.params],
  useSearch: () => pageState.search,
  useParams: () => pageState.params,
  useSearchParams: () => [new URLSearchParams(pageState.search), vi.fn()],
  Link: ({ children, href, ...p }: any) => (
    <a href={href} {...p}>
      {children}
    </a>
  ),
  Route: ({ component: C, children }: any) => (C ? <C /> : typeof children === "function" ? children({}) : children),
  Switch: ({ children }: any) => <>{children}</>,
  Redirect: () => null,
  Router: ({ children }: any) => <>{children}</>,
};

export const appModeMock = {
  useAppMode: () => pageState.appMode,
  useModePrefix: () => (pageState.appMode === "factory" ? "/factory" : ""),
  AppModeProvider: ({ children }: any) => <>{children}</>,
  getModePrefix: (mode?: string) => (mode === "factory" ? "/factory" : ""),
};

export const companyMock = {
  useCompany: () => ({
    selectedCompany: {
      id: 1,
      name: "Test Co",
      code: "TC",
      active: true,
      companyType: pageState.companyType,
      baseCurrency: "USD",
    },
    companies: [],
    isLoading: false,
    selectCompany: vi.fn(),
  }),
  CompanyProvider: ({ children }: any) => <>{children}</>,
};

const money = (v: any) => `$${Number(v ?? 0).toFixed(2)}`;

export const currencyMock = {
  useCurrencyContext: () => ({
    selectedCurrency: "USD",
    exchangeRate: 1,
    isLoadingRate: false,
    isLoadingCompany: false,
    baseCurrency: "USD",
    displayCurrency: "USD",
    isMultiCurrency: false,
    formatAmount: money,
    formatAmountRaw: money,
    formatCashAmount: money,
    formatHistoricalBaseAmount: money,
    convertToDisplay: (v: number) => v,
    convertToUSD: (v: number) => v,
    setCurrency: vi.fn(),
    toggleCurrency: vi.fn(),
  }),
  CurrencyProvider: ({ children }: any) => <>{children}</>,
};

export const dateFormatMock = {
  useDateFormat: () => ({
    dateFormat: "MM/DD/YYYY",
    setDateFormat: vi.fn(),
    formatDisplayDate: (d: any) => String(d ?? ""),
    formatShortDate: (d: any) => String(d ?? ""),
    formatDisplayTime: (d: any) => String(d ?? ""),
    formatDisplayDateTime: (d: any) => String(d ?? ""),
    isLoading: false,
    isPending: false,
  }),
  DateFormatProvider: ({ children }: any) => <>{children}</>,
};

export const connectivityMock = {
  useConnectivity: () => ({
    status: "online",
    isOnline: true,
    isSyncing: false,
    lastSyncedAt: null,
    pendingCount: 0,
    failedCount: 0,
    conflictCount: 0,
    triggerSync: vi.fn(),
    refreshCounts: vi.fn(),
  }),
  ConnectivityProvider: ({ children }: any) => <>{children}</>,
};

export const locationContextMock = {
  useLocation: () => ({ selectedLocation: pageState.selectedLocation, setSelectedLocation: vi.fn() }),
  LocationProvider: ({ children }: any) => <>{children}</>,
};

export const cursorNavMock = {
  useCursorNav: () => ({ register: vi.fn(), unregister: vi.fn(), config: {} }),
  CursorNavProvider: ({ children }: any) => <>{children}</>,
};

/**
 * Route-aware fetch stub. `routes` maps a URL prefix to the JSON body returned
 * for it; the longest matching prefix wins and anything else gets `[]`. This
 * lets a page render populated rows (the positive path) instead of only its
 * empty state.
 */
export function stubFetchRoutes(routes: Record<string, unknown> = {}) {
  const prefixes = Object.keys(routes).sort((a, b) => b.length - a.length);
  const fetchMock = vi.fn(async (input: any) => {
    const url = String(typeof input === "string" ? input : (input?.url ?? input));
    const match = prefixes.find((p) => url.startsWith(p));
    const body = match ? routes[match] : [];
    return {
      ok: true,
      status: 200,
      json: async () => body,
      text: async () => JSON.stringify(body),
      blob: async () => new Blob([JSON.stringify(body)]),
      headers: new Headers({ "content-type": "application/json" }),
      clone() {
        return this;
      },
    } as any;
  });
  (global as any).fetch = fetchMock;
  return fetchMock;
}

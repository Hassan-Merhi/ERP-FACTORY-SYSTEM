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

/**
 * Generic seeded rows for "positive path" page mounts: every GET answers three
 * records carrying the field names list pages commonly read. The array also
 * carries the paginated envelope fields, so pages that read `data.items`
 * and pages that read the array directly both get rows.
 */
export function seededRecord(i: number) {
  return {
    id: i,
    name: `Name ${i}`,
    code: `C${i}`,
    companyId: 1,
    locationId: 1,
    stockItemId: i,
    customerId: i,
    supplierId: i,
    workerId: i,
    containerId: i,
    accountId: i,
    voucherId: i,
    quantity: 10 * i,
    qty: 10 * i,
    amount: 100 * i,
    total: 100 * i,
    balance: 50 * i,
    rate: 5,
    price: 5,
    status: "active",
    date: "2026-09-01",
    createdAt: "2026-09-01T10:00:00Z",
    voucherDate: "2026-09-01",
    description: `Desc ${i}`,
    notes: "",
    active: true,
    type: "Sales",
    voucherType: "Sales",
    accountType: "Asset",
    locationName: "Main",
    itemName: `Item ${i}`,
    stockItemName: `Item ${i}`,
    customerName: `Cust ${i}`,
    supplierName: `Supp ${i}`,
    containerNumber: `CONT${i}`,
    username: `user${i}`,
    role: "Admin",
    weight: 100,
    kg: 100,
  };
}

/** Three records as an array that also answers the paginated envelope fields. */
export function seededPayload() {
  const records = [seededRecord(1), seededRecord(2), seededRecord(3)];
  return Object.assign(records, {
    items: records,
    rows: records,
    data: records,
    results: records,
    total: 3,
    totalCount: 3,
    page: 1,
    pageSize: 50,
    totalPages: 1,
    hasMore: false,
  });
}

export function stubSeededFetch() {
  (global as any).fetch = vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => seededPayload(),
    text: async () => "",
    blob: async () => new Blob([]),
    arrayBuffer: async () => new ArrayBuffer(0),
    headers: new Headers({ "content-type": "application/json" }),
    clone() {
      return this;
    },
  }));
}

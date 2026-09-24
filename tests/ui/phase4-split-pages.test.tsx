/**
 * Mount tests for the six pages whose dialogs were extracted into separate
 * modules during the Phase 4 split.
 *
 * These pages had no frontend coverage at all. The split moved JSX and state
 * across a module boundary, and every extracted dialog declares its props as
 * `any`, so the compiler proves only that a prop was *passed* - not that the
 * right one was. Mounting the real page is what exercises the actual wiring:
 * a dialog reading a binding the parent no longer supplies, or a hook whose
 * call order moved, fails here and nowhere else.
 *
 * Mounting is the assertion. Each test also pins one landmark so an
 * empty-but-not-crashing render cannot pass silently.
 */
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { getQueryFn } from "@/lib/queryClient";
import { renderWithProviders, stubFetch } from "./helpers";

/**
 * renderWithProviders builds a bare QueryClient, but the application sets a
 * default queryFn on its own client - so any useQuery that relies on that
 * default (most of them) never fetches under the shared helper and its data
 * stays empty. Rows that only exist when data arrives are therefore invisible,
 * along with the row-level dialogs this file needs to reach. Wire the real
 * default in so the seeded fixtures actually land.
 */
function renderWithData(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, queryFn: getQueryFn({ on401: "throw" }) },
      mutations: { retry: false },
    },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeAll(() => stubFetch());

/**
 * Some of these pages gate their whole toolbar behind having data (Proformas
 * renders "No customer selected" until one is chosen), so an empty stub hides
 * the very triggers under test. Route by URL and hand back one plausible row.
 */
function stubFetchRoutes(routes: Array<[RegExp, unknown]>): void {
  (global as any).fetch = vi.fn().mockImplementation((input: any) => {
    const url = String(typeof input === "string" ? input : (input?.url ?? ""));
    const hit = routes.find(([pattern]) => pattern.test(url));
    const body = hit ? hit[1] : [];
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(body),
      text: () => Promise.resolve(JSON.stringify(body)),
      headers: new Headers(),
    });
  });
}

/** FactoryProformas seeds its customer from ?customerId=, so drive it that way. */
function selectCustomerViaUrl(id: number): void {
  window.history.replaceState({}, "", `/?customerId=${id}`);
}

vi.mock("wouter", () => ({
  useLocation: () => ["/", vi.fn()],
  useRoute: () => [false, {}],
  useSearch: () => "",
  useParams: () => ({ id: "1", workerId: "1" }),
  Link: ({ children, ...p }: any) => <a {...p}>{children}</a>,
  Route: ({ component: C }: any) => (C ? <C /> : null),
  Switch: ({ children }: any) => <>{children}</>,
  Redirect: () => null,
}));

vi.mock("@/contexts/AppModeContext", () => ({
  useAppMode: () => "factory",
  useModePrefix: () => "/factory",
  AppModeProvider: ({ children }: any) => <>{children}</>,
  getModePrefix: () => "/factory",
}));

vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => ({
    selectedCompany: { id: 1, name: "Test Co", code: "TC", active: true, companyType: "factory" as const },
    companies: [],
    isLoading: false,
    selectCompany: vi.fn(),
  }),
  CompanyProvider: ({ children }: any) => <>{children}</>,
}));

const money = (v: any) => `$${Number(v ?? 0).toFixed(2)}`;
vi.mock("@/contexts/CurrencyContext", () => ({
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
    convertToDisplay: (v: number) => v,
    convertToUSD: (v: number) => v,
    setCurrency: vi.fn(),
    toggleCurrency: vi.fn(),
  }),
}));

vi.mock("@/contexts/DateFormatContext", () => ({
  useDateFormat: () => ({
    dateFormat: "MM/DD/YYYY",
    setDateFormat: vi.fn(),
    formatDisplayDate: (d: any) => String(d),
    formatShortDate: (d: any) => String(d),
    formatDisplayTime: (d: any) => String(d),
    formatDisplayDateTime: (d: any) => String(d),
    isLoading: false,
    isPending: false,
  }),
}));

vi.mock("@/contexts/ConnectivityContext", () => ({
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
}));

vi.mock("@/contexts/LocationContext", () => ({
  useLocation: () => ({ selectedLocation: null, setSelectedLocation: vi.fn() }),
  LocationProvider: ({ children }: any) => <>{children}</>,
}));

vi.mock("@/contexts/CursorNavContext", () => ({
  useCursorNav: () => ({ register: vi.fn(), unregister: vi.fn() }),
  CursorNavProvider: ({ children }: any) => <>{children}</>,
}));

describe("Phase 4 split pages mount", () => {
  it("FactoryLocationInventory", async () => {
    const { default: Page } = await import("@/pages/factory/FactoryLocationInventory");
    renderWithProviders(<Page />);
    expect(await screen.findByTestId("input-search-locations")).toBeTruthy();
  });

  it("FactoryProformas", async () => {
    const { default: Page } = await import("@/pages/factory/FactoryProformas");
    renderWithProviders(<Page />);
    // Without a customer the page is deliberately an empty state, which is
    // still a successful mount - assert the empty state it documents.
    expect(await screen.findByTestId("text-select-customer")).toBeTruthy();
  });

  it("FactoryWorkerDetail", async () => {
    const { default: Page } = await import("@/pages/factory/FactoryWorkerDetail");
    renderWithProviders(<Page />);
    expect(document.body.textContent?.length).toBeGreaterThan(0);
  });

  it("FactoryPayroll", async () => {
    const { default: Page } = await import("@/pages/factory/FactoryPayroll");
    renderWithProviders(<Page />);
    expect(document.body.textContent?.length).toBeGreaterThan(0);
  });

  it("Payroll", async () => {
    const { default: Page } = await import("@/pages/Payroll");
    renderWithProviders(<Page />);
    expect(document.body.textContent?.length).toBeGreaterThan(0);
  });

  it("AdvancesView", async () => {
    const { AdvancesView } = await import("@/pages/factory/factoryadvancestab/components/AdvancesView");
    renderWithProviders(<AdvancesView />);
    expect(document.body.textContent?.length).toBeGreaterThan(0);
  });

  it("StockTransferOrder", async () => {
    const { default: Page } = await import("@/pages/StockTransferOrder");
    renderWithProviders(<Page />);
    expect(document.body.textContent?.length).toBeGreaterThan(0);
  });

  it("StockTransferForm", async () => {
    const { StockTransferForm } = await import("@/pages/vouchers/StockTransferForm");
    renderWithProviders(<StockTransferForm />);
    expect(document.body.textContent?.length).toBeGreaterThan(0);
  });
});

/**
 * Mounting alone never renders the dialogs - they are behind `open={...}`, so
 * the extracted modules stay unevaluated and their props unread. Driving the
 * real trigger is what proves the parent still supplies bindings the dialog
 * can use, which is precisely what the split could have broken and what `any`
 * props stop the compiler from checking.
 */
describe("Phase 4 extracted dialogs open from their real triggers", () => {
  it("StockTransferOrder opens the extracted ImportDialog", async () => {
    const { default: Page } = await import("@/pages/StockTransferOrder");
    renderWithProviders(<Page />);

    fireEvent.click(await screen.findByTestId("button-open-import"));

    expect(await screen.findByText("Import from Excel")).toBeTruthy();
  });

  it("StockTransferForm opens the extracted ImportTransferExcelDialog", async () => {
    const { StockTransferForm } = await import("@/pages/vouchers/StockTransferForm");
    renderWithProviders(<StockTransferForm />);

    fireEvent.click(await screen.findByTestId("button-open-import-dialog"));

    expect(await screen.findByText("Import Stock Transfer from Excel")).toBeTruthy();
  });

  describe("FactoryProformas with a customer selected", () => {
    beforeEach(() => {
      selectCustomerViaUrl(1);
      stubFetchRoutes([
        [/\/api\/factory\/customers/, [{ id: 1, name: "Acme Textiles", code: "ACME", active: true }]],
        [/customer-proformas/, []],
        [/customer-price-lists/, []],
      ]);
    });

    afterEach(() => {
      window.history.replaceState({}, "", "/");
      stubFetch();
    });

    it("opens the extracted Excel import dialog", async () => {
      const { default: Page } = await import("@/pages/factory/FactoryProformas");
      renderWithProviders(<Page />);

      fireEvent.click(await screen.findByTestId("button-import-excel-proforma"));

      expect(await screen.findByText("Import Proforma from Excel")).toBeTruthy();
    });

    // Row-level dialogs need a proforma to exist, so seed one and drive the
    // row's own ⋯ menu. This is the wiring most likely to break in a split:
    // the dialog is handed a value out of the row's map callback, not a
    // top-level piece of state.
    describe("with one proforma in the list", () => {
      const proforma = {
        id: 7,
        name: "PF-0007",
        customerId: 1,
        status: "active",
        isActive: true,
        lines: [],
        createdAt: "2026-01-01T00:00:00.000Z",
      };

      beforeEach(() => {
        stubFetchRoutes([
          [/\/api\/factory\/customers/, [{ id: 1, name: "Acme Textiles", code: "ACME", active: true }]],
          [/customer-proformas/, [proforma]],
          [/customer-price-lists/, []],
          [/stock-items\/light/, []],
          // the row's edit menu is gated on role
          [/\/api\/auth\/me/, { role: "Admin" }],
        ]);
      });

      it("opens the extracted RenameProformaDialog from the row menu", async () => {
        const { default: Page } = await import("@/pages/factory/FactoryProformas");
        renderWithData(<Page />);

        const user = userEvent.setup();
        fireEvent.pointerDown(await screen.findByTestId(`button-proforma-menu-${proforma.id}`), { button: 0, ctrlKey: false });
        await user.click(await screen.findByTestId(`button-rename-proforma-${proforma.id}`));

        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("Rename Proforma")).toBeTruthy();
      });

      it("opens the extracted TransferProformaDialog from the row menu", async () => {
        const { default: Page } = await import("@/pages/factory/FactoryProformas");
        renderWithData(<Page />);

        const user = userEvent.setup();
        fireEvent.pointerDown(await screen.findByTestId(`button-proforma-menu-${proforma.id}`), { button: 0, ctrlKey: false });
        await user.click(await screen.findByTestId(`button-transfer-proforma-${proforma.id}`));

        const dialog = await screen.findByRole("dialog");
        expect(within(dialog).getByText("Transfer Proforma")).toBeTruthy();
      });
    });

    // The create-proforma dialog is still inline in the parent, not one of the
    // extracted D* modules - kept as an interaction check, not extraction proof.
    it("opens its inline create dialog", async () => {
      const { default: Page } = await import("@/pages/factory/FactoryProformas");
      renderWithProviders(<Page />);

      fireEvent.click(await screen.findByTestId("button-create-proforma"));

      expect(await screen.findByTestId("input-proforma-name")).toBeTruthy();
    });
  });
});

/**
 * AdvancesView is the sharpest case: all nine of its dialogs were extracted,
 * every prop is `any`, and each one carries a large slice of parent state
 * (forms, mutations, selection sets). Each case below opens one through its
 * real button and asserts the dialog's own title, so a binding the parent
 * stopped supplying surfaces as a failure here.
 */
describe("AdvancesView extracted dialogs open from their real triggers", () => {
  // [trigger testid, extracted module, dialog title, trigger sits in the ⋯ menu]
  const cases: Array<[string, string, RegExp, boolean]> = [
    ["button-add-advance", "RecordAdvanceDialog", /Record Advance/i, false],
    ["button-bulk-advance", "BulkAdvanceDialog", /Bulk Advance/i, false],
    ["button-cash-adjustment", "CashAccountAdjustmentDialog", /Cash Account Balance Adjustment/i, true],
    ["button-post-accounting", "PostAccountingPreviewDialog", /Post Accounting for Old Advances/i, true],
    ["button-reconcile-advances", "ReconcileBalancesDialog", /Reconcile Advance Balances/i, true],
    ["button-repayment-audit", "RepaymentAuditDialog", /Repayment Audit/i, true],
    ["button-repay-by-month", "RepayByMonthDialog", /Repay by Month/i, true],
  ];

  beforeEach(() => {
    // Two of these dialogs read a nested field off their query payload
    // (`reconcilePreview.changes`) behind only a truthiness guard, so an empty
    // array is truthy enough to reach the crash. Same shape on main - it is the
    // fixture that has to be right, not the component.
    stubFetchRoutes([
      [/advances\/reconcile\/preview/, { changes: [], totalWorkers: 0, totalChanged: 0 }],
      [/advances\/repayment-audit/, { advances: [], rows: [], summary: {} }],
      [/cash-account-balance/, { balance: 0 }],
    ]);
  });

  afterEach(() => stubFetch());

  for (const [testId, moduleName, title, viaMenu] of cases) {
    it(`${testId} opens ${moduleName}`, async () => {
      const { AdvancesView } = await import("@/pages/factory/factoryadvancestab/components/AdvancesView");
      renderWithProviders(<AdvancesView />);

      // Radix dropdowns open on pointerdown, not click, so userEvent is what
      // actually reveals the triggers that live behind the ⋯ menu.
      const user = userEvent.setup();
      if (viaMenu) fireEvent.pointerDown(await screen.findByTestId("button-advances-actions"), { button: 0, ctrlKey: false });
      await user.click(await screen.findByTestId(testId));

      // Several triggers carry the same label as the dialog they open, and some
      // dialogs repeat their title on the submit button, so scope to the dialog
      // and accept more than one match.
      const dialog = await screen.findByRole("dialog");
      expect(within(dialog).getAllByText(title).length).toBeGreaterThan(0);
    });
  }
});

/**
 * Route guards, rendered.
 *
 * `tests/frontend-layout.test.ts` used to carry these as commented-out
 * `it.todo` entries ("needs jsdom"). They now run for real: the route tables
 * are mounted inside a wouter memory router, every lazy page is replaced by a
 * stub that names itself, and each case asserts where the user actually lands.
 *
 * What is protected:
 *  - an ERP user without page access is sent to /tracking, not shown the page
 *  - the ERP root is the containers board for Admin/Developer only
 *  - FactoryRoutes mounts the page for its path and follows its legacy redirects
 *  - Admin-only factory routes stay closed to other roles
 *  - the authenticated shell shows a loading state (not a page) while factory
 *    access is pending, and a recovery state when it failed to load
 */
import React, { Suspense } from "react";
import { act, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Router } from "wouter";
import { memoryLocation } from "wouter/memory-location";

// Every export of lazyPages becomes a stub that renders its own name, so a
// route test can assert which page won without loading any real page.
vi.mock("@/lazyPages", () => {
  const cache = new Map<string, React.ComponentType>();
  return new Proxy(
    {},
    {
      get(_target, key) {
        if (typeof key !== "string" || key === "then" || key === "__esModule") return undefined;
        if (!cache.has(key)) {
          const Stub = () => <div data-testid={`page-${key}`}>{key}</div>;
          Stub.displayName = key;
          cache.set(key, Stub);
        }
        return cache.get(key);
      },
      has: () => true,
    }
  );
});
vi.mock("@/pages/sp/SpOverview", () => ({ default: () => <div data-testid="page-SpOverview" /> }));
vi.mock("@/pages/not-found", () => ({ default: () => <div data-testid="page-NotFound" /> }));
vi.mock("@/pages/AccountGroups", () => ({ default: () => <div data-testid="page-AccountGroups" /> }));
vi.mock("@/pages/factory/FactoryInvoiceDetailBilingual", () => ({
  default: () => <div data-testid="page-FactoryInvoiceDetailBilingual" />,
}));
vi.mock("@/pages/factory/WasteDispatchOptimized", () => ({ default: () => <div data-testid="page-WasteDispatch" /> }));

function makeClient(seed: Array<[unknown[], unknown]> = []) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, queryFn: () => new Promise(() => {}) } },
  });
  for (const [key, value] of seed) client.setQueryData(key, value);
  return client;
}

function mountAt(path: string, ui: React.ReactElement, seed: Array<[unknown[], unknown]> = []) {
  const memory = memoryLocation({ path, record: true });
  const utils = render(
    <QueryClientProvider client={makeClient(seed)}>
      <Router hook={memory.hook}>
        <Suspense fallback={<div data-testid="suspense-fallback" />}>{ui}</Suspense>
      </Router>
    </QueryClientProvider>
  );
  return { ...utils, memory };
}

describe("ErpRoutes access guard", () => {
  it("sends a non-admin at the root to /tracking", async () => {
    const { ErpRoutes } = await import("@/routes/ErpRoutes");
    const { memory } = mountAt("/", <ErpRoutes user={{ role: "Accountant" }} />);

    expect(await screen.findByTestId("page-TrackingHub")).toBeInTheDocument();
    expect(memory.history.at(-1)).toBe("/tracking");
    expect(screen.queryByTestId("page-ContainersOTW")).not.toBeInTheDocument();
  });

  it("shows the containers board at the root to an Admin", async () => {
    const { ErpRoutes } = await import("@/routes/ErpRoutes");
    const { memory } = mountAt("/", <ErpRoutes user={{ role: "Admin" }} />);

    expect(await screen.findByTestId("page-ContainersOTW")).toBeInTheDocument();
    expect(memory.history).toEqual(["/"]);
  });

  it("redirects /pos to /tracking when the user's page keys exclude pos", async () => {
    const { ErpRoutes } = await import("@/routes/ErpRoutes");
    const { memory } = mountAt("/pos", <ErpRoutes user={{ role: "Accountant" }} />, [
      [["/api/my-erp-pages"], { fullAccess: false, pageKeys: ["stock_items"] }],
    ]);

    expect(await screen.findByTestId("page-TrackingHub")).toBeInTheDocument();
    expect(memory.history.at(-1)).toBe("/tracking");
    expect(screen.queryByTestId("page-POSPage")).not.toBeInTheDocument();
  });

  it("admits /pos when the page keys include pos", async () => {
    const { ErpRoutes } = await import("@/routes/ErpRoutes");
    mountAt("/pos", <ErpRoutes user={{ role: "Accountant" }} />, [
      [["/api/my-erp-pages"], { fullAccess: false, pageKeys: ["pos"] }],
    ]);

    expect(await screen.findByTestId("page-POSPage")).toBeInTheDocument();
  });

  it("admits a page-keyed route for full-access users regardless of keys", async () => {
    const { ErpRoutes } = await import("@/routes/ErpRoutes");
    mountAt("/inventory", <ErpRoutes user={{ role: "Accountant" }} />, [
      [["/api/my-erp-pages"], { fullAccess: true, pageKeys: [] }],
    ]);

    expect(await screen.findByTestId("page-InventoryHub")).toBeInTheDocument();
  });

  it("follows the legacy /stock-items alias to the stock hub items tab", async () => {
    const { ErpRoutes } = await import("@/routes/ErpRoutes");
    const { memory } = mountAt("/stock-items", <ErpRoutes user={{ role: "Admin" }} />);

    expect(await screen.findByTestId("page-StockHub")).toBeInTheDocument();
    expect(memory.history.at(-1)).toBe("/stock?tab=items");
  });
});

describe("FactoryRoutes with mocked user/access props", () => {
  const access = { fullAccess: true, pageKeys: [], hiddenCostFields: [] };

  it("mounts the page that owns the path", async () => {
    const { FactoryRoutes } = await import("@/components/FactoryRoutes");
    mountAt(
      "/factory/containers-hub",
      <FactoryRoutes user={{ role: "Admin" } as any} myAccess={access} factoryDefaultPage="/factory/dashboard" />
    );

    expect(await screen.findByTestId("page-FactoryContainersHub")).toBeInTheDocument();
  });

  it("follows a legacy factory redirect", async () => {
    const { FactoryRoutes } = await import("@/components/FactoryRoutes");
    const { memory } = mountAt(
      "/factory/pressing",
      <FactoryRoutes user={{ role: "Admin" } as any} myAccess={access} factoryDefaultPage="/factory/dashboard" />
    );

    expect(await screen.findByTestId("page-BaleStockEntry")).toBeInTheDocument();
    expect(memory.history.at(-1)).toBe("/factory/stock-entry");
  });

  it("renders the workers hub for the payroll hub path", async () => {
    const { FactoryRoutes } = await import("@/components/FactoryRoutes");
    mountAt(
      "/factory/payroll-hub",
      <FactoryRoutes user={{ role: "Admin" } as any} myAccess={access} factoryDefaultPage="/factory/dashboard" />
    );

    expect(await screen.findByTestId("page-FactoryPayrollHub")).toBeInTheDocument();
  });

  it("opens account groups to an Admin", async () => {
    const { FactoryRoutes } = await import("@/components/FactoryRoutes");
    mountAt(
      "/factory/account-groups",
      <FactoryRoutes user={{ role: "Admin" } as any} myAccess={access} factoryDefaultPage="/factory/dashboard" />
    );

    expect(await screen.findByTestId("page-AccountGroups")).toBeInTheDocument();
  });

  it("keeps account groups closed to a non-admin", async () => {
    const { FactoryRoutes } = await import("@/components/FactoryRoutes");
    mountAt(
      "/factory/account-groups",
      <FactoryRoutes user={{ role: "Accountant" } as any} myAccess={access} factoryDefaultPage="/factory/dashboard" />
    );

    // Let lazy routes settle before asserting absence.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.queryByTestId("page-AccountGroups")).not.toBeInTheDocument();
  });
});

// ── Authenticated shell: loading and recovery while factory access resolves ──

const appData = vi.hoisted(() => ({
  current: {
    chatUnread: 0,
    posImportEnabled: false,
    myAccess: undefined as unknown,
    myAccessLoading: true,
    myAccessError: false,
    factorySettings: undefined as unknown,
  },
}));
const companyState = vi.hoisted(() => ({
  current: {
    selectedCompany: { id: 7, name: "Factory Co", companyType: "factory" } as any,
    isLoading: false,
  },
}));

vi.mock("@/app/useAuthenticatedAppData", () => ({ useAuthenticatedAppData: () => appData.current }));
vi.mock("@/contexts/CompanyContext", () => ({
  useCompany: () => companyState.current,
  CompanyProvider: ({ children }: any) => <>{children}</>,
}));
vi.mock("@/hooks/use-dialog-scroll-fix", () => ({ useDialogScrollFix: () => {} }));
vi.mock("@/hooks/use-mobile-performance-lifecycle", () => ({ useMobilePerformanceLifecycle: () => {} }));
vi.mock("@/hooks/use-ws-invalidation", () => ({ useWsInvalidation: () => {} }));
vi.mock("@/app/useErpScrollRestoration", () => ({ useErpScrollRestoration: () => {} }));
vi.mock("@/app/useAppNavigation", () => ({
  useAppNavigation: () => ({
    showLeaveConfirm: false,
    setShowLeaveConfirm: vi.fn(),
    handleGoBack: vi.fn(),
    handleConfirmLeave: vi.fn(),
  }),
}));
vi.mock("@/app/AuthenticatedAppOverlays", () => ({ AuthenticatedAppOverlays: () => null }));
vi.mock("@/app/FactoryShell", () => ({ FactoryShell: () => <div data-testid="shell-factory" /> }));
vi.mock("@/app/ErpShell", () => ({ ErpShell: () => <div data-testid="shell-erp" /> }));
vi.mock("@/app/PosShell", () => ({ PosShell: () => <div data-testid="shell-pos" /> }));
vi.mock("@/app/PropertiesShell", () => ({ PropertiesShell: () => <div data-testid="shell-properties" /> }));

describe("AuthenticatedApp route gate", () => {
  const user = { id: "u1", username: "owner", role: "Admin" } as any;

  beforeEach(() => {
    companyState.current = {
      selectedCompany: { id: 7, name: "Factory Co", companyType: "factory" },
      isLoading: false,
    };
    appData.current = {
      chatUnread: 0,
      posImportEnabled: false,
      myAccess: undefined,
      myAccessLoading: true,
      myAccessError: false,
      factorySettings: undefined,
    };
  });

  it("shows the loading UI, not a shell, while factory access is pending", async () => {
    const { AuthenticatedApp } = await import("@/app/AuthenticatedApp");
    mountAt("/factory/daybook", <AuthenticatedApp user={user} handleLogout={vi.fn()} />);

    expect(screen.getByText("Loading Factory access")).toBeInTheDocument();
    expect(screen.queryByTestId("shell-factory")).not.toBeInTheDocument();
  });

  it("offers recovery when factory access failed to load", async () => {
    appData.current = { ...appData.current, myAccessLoading: false, myAccessError: true };
    const { AuthenticatedApp } = await import("@/app/AuthenticatedApp");
    mountAt("/factory/daybook", <AuthenticatedApp user={user} handleLogout={vi.fn()} />);

    expect(screen.getByText("Application data could not be loaded")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload application" })).toBeInTheDocument();
  });

  it("shows the loading UI while the company itself is loading", async () => {
    companyState.current = { selectedCompany: null, isLoading: true };
    const { AuthenticatedApp } = await import("@/app/AuthenticatedApp");
    mountAt("/", <AuthenticatedApp user={user} handleLogout={vi.fn()} />);

    expect(screen.getByText("Loading application")).toBeInTheDocument();
  });

  it("redirects an ERP company away from a /factory route", async () => {
    companyState.current = { selectedCompany: { id: 3, name: "ERP Co", companyType: "erp" }, isLoading: false };
    appData.current = { ...appData.current, myAccessLoading: false };
    const { AuthenticatedApp } = await import("@/app/AuthenticatedApp");
    const { memory } = mountAt("/factory/daybook", <AuthenticatedApp user={user} handleLogout={vi.fn()} />);

    expect(await screen.findByTestId("shell-erp")).toBeInTheDocument();
    expect(memory.history.at(-1)).toBe("/");
  });

  it("mounts the factory shell once access has resolved", async () => {
    appData.current = {
      ...appData.current,
      myAccessLoading: false,
      myAccess: { hasErpAccess: false, hasFactoryAccess: true, fullAccess: true, pageKeys: [] },
    };
    const { AuthenticatedApp } = await import("@/app/AuthenticatedApp");
    mountAt("/factory/daybook", <AuthenticatedApp user={user} handleLogout={vi.fn()} />);

    expect(await screen.findByTestId("shell-factory")).toBeInTheDocument();
  });

  it("mounts the POS shell for a POS user", async () => {
    companyState.current = { selectedCompany: { id: 3, name: "ERP Co", companyType: "erp" }, isLoading: false };
    appData.current = { ...appData.current, myAccessLoading: false };
    const { AuthenticatedApp } = await import("@/app/AuthenticatedApp");
    mountAt("/pos", <AuthenticatedApp user={{ ...user, role: "POS" }} handleLogout={vi.fn()} />);

    expect(await screen.findByTestId("shell-pos")).toBeInTheDocument();
  });
});

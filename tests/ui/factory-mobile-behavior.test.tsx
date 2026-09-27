import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { renderWithProviders, stubFetch } from "./helpers";

/**
 * Factory mobile audit: rendered phone behaviour in Factory Mode. The full viewport matrix
 * runs in scripts/verify-factory-mobile-browser.mjs against a real build.
 */

const harness = vi.hoisted(() => ({ phone: true, mode: "factory" as "factory" | "properties" }));

beforeEach(() => {
  harness.phone = true;
  harness.mode = "factory";
  stubFetch();
});

afterEach(cleanup);

vi.mock("@/hooks/use-erp-phone-layout", () => ({ useErpPhoneLayout: () => harness.phone }));

vi.mock("@/contexts/AppModeContext", () => ({
  useAppMode: () => harness.mode,
  useModePrefix: () => "/factory",
  AppModeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  getModePrefix: () => "/factory",
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/factory/contacts", vi.fn()],
  useRoute: () => [false, {}],
  useSearch: () => "",
  useParams: () => ({}),
  Link: ({ children, ...props }: { children: React.ReactNode }) => <a {...props}>{children}</a>,
}));

vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const contacts = [
  {
    id: 7,
    name: "Amina Haddad",
    role: "Supplier agent",
    notes: "Calls after 5pm",
    numbers: [{ label: "Mobile", number: "+961 70 000 000" }],
  },
];

const alerts = [
  {
    id: 3,
    severity: "critical",
    title: "Container overdue",
    message: "MSCU1234567 is 4 days late",
    entity: "container",
    createdAt: "2026-09-20T08:00:00.000Z",
    read: false,
  },
];

function cellFor(text: string): HTMLElement {
  const cell = screen.getByText(text).closest("td");
  if (!cell) throw new Error(`${text} is not inside a table cell`);
  return cell;
}

describe("Factory phone card tables", () => {
  it("restacks Contacts as cards with the name as title and touch-visible row actions", async () => {
    const { default: FactoryContacts } = await import("@/pages/factory/FactoryContacts");
    renderWithProviders(<FactoryContacts />, { seedQueries: [[["/api/factory/contacts"], contacts]] });

    const table = await screen.findByTestId("factory-contacts-table");
    expect(table).toHaveAttribute("data-mobile-cards", "true");
    expect(cellFor("Amina Haddad")).toHaveAttribute("data-mobile-cell", "title");
    expect(cellFor("Supplier agent")).toHaveAttribute("data-label", "Role");
    expect(screen.getByTestId("button-edit-contact-7").closest("td")).toHaveAttribute("data-mobile-cell", "actions");
    expect(screen.getByRole("button", { name: "Delete Amina Haddad" })).toBeInTheDocument();
  });

  it("heads Alert cards with the alert title and keeps severity as a labelled field", async () => {
    const { default: FactoryAlerts } = await import("@/pages/factory/FactoryAlerts");
    renderWithProviders(<FactoryAlerts />, { seedQueries: [[["/api/factory/alerts"], alerts]] });

    const table = await screen.findByTestId("factory-alerts-table");
    expect(table).toHaveAttribute("data-mobile-cards", "true");
    expect(screen.getByTestId("text-alert-title-3")).toHaveAttribute("data-mobile-cell", "title");
    const severity = screen.getByTestId("badge-severity-critical").closest("td");
    expect(severity).toHaveAttribute("data-mobile-cell", "field");
    expect(severity).toHaveAttribute("data-label", "Severity");
    expect(screen.getByTestId("button-mark-read-3").closest("td")).toHaveAttribute("data-mobile-cell", "actions");
  });

  it("keeps the desktop table on tablet and desktop widths", async () => {
    harness.phone = false;
    const { default: FactoryContacts } = await import("@/pages/factory/FactoryContacts");
    renderWithProviders(<FactoryContacts />, { seedQueries: [[["/api/factory/contacts"], contacts]] });

    const table = await screen.findByTestId("factory-contacts-table");
    expect(table).not.toHaveAttribute("data-mobile-cards");
  });
});

describe("Factory phone interactions", () => {
  it("opens the Production Comparison worker breakdown on tap, not only on hover", async () => {
    const { WorkerSummaryHover } = await import("@/pages/factory/productioncomparison/components/WorkerSummaryHover");
    render(
      <WorkerSummaryHover
        workers={[{ name: "Karim", total: 5, aQty: 3, bQty: 2 }]}
        labelA="This month"
        labelB="Last month"
      />
    );

    const trigger = screen.getByRole("button", { name: /1 worker/ });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(await screen.findByText("Karim")).toBeInTheDocument();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });

  it("scrolls a sideways tab strip so the active tab is visible", () => {
    const rects: Record<string, Partial<DOMRect>> = {
      list: { left: 0, right: 300 },
      far: { left: 420, right: 520 },
    };
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement
    ) {
      const key = this.getAttribute("role") === "tablist" ? "list" : this.dataset.testid === "tab-far" ? "far" : "";
      return {
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
        ...(rects[key] ?? {}),
      } as DOMRect;
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", { configurable: true, get: () => 600 });
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 300 });

    try {
      render(
        <Tabs defaultValue="far">
          <TabsList>
            <TabsTrigger value="near">Profile</TabsTrigger>
            <TabsTrigger value="far" data-testid="tab-far">
              Documents
            </TabsTrigger>
          </TabsList>
        </Tabs>
      );
      expect(screen.getByRole("tablist").scrollLeft).toBe(228);
    } finally {
      spy.mockRestore();
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).scrollWidth;
      delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
    }
  });
});

describe("Factory notes entry point", () => {
  afterEach(() => {
    delete document.documentElement.dataset.userNotes;
  });

  it("opens My Notes from the account menu, since phones hide the floating button", async () => {
    const { UserMenu } = await import("@/components/UserMenu");
    document.documentElement.dataset.userNotes = "available";
    const opened = vi.fn();
    window.addEventListener("user-notes:open", opened);
    try {
      renderWithProviders(
        <UserMenu accentColor="#f60" user={{ username: "Rania", role: "Admin" }} onLogout={vi.fn()} />
      );
      const trigger = screen.getByTestId("button-user-menu");
      fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
      fireEvent.click(await screen.findByTestId("button-user-menu-notes"));
      expect(opened).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("user-notes:open", opened);
    }
  });

  it("does not offer notes in the menu when the user has notes disabled", async () => {
    const { UserMenu } = await import("@/components/UserMenu");
    renderWithProviders(<UserMenu accentColor="#f60" user={{ username: "Rania", role: "Admin" }} onLogout={vi.fn()} />);
    fireEvent.pointerDown(screen.getByTestId("button-user-menu"), { button: 0, pointerType: "mouse" });
    await screen.findByTestId("button-logout");
    expect(screen.queryByTestId("button-user-menu-notes")).not.toBeInTheDocument();
  });
});

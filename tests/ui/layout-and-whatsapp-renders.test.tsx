/**
 * The render cases `frontend-layout.test.ts` and `frontend-whatsapp.test.ts`
 * left as commented-out `it.todo` ("needs jsdom"). The frontend suite has run
 * under jsdom for a long time; these now mount the real components.
 *
 * Layout: Vouchers, POS at a phone width, FactoryContainersHub and
 * UsersPermissionsHub. (Dashboard, Accounts, InventoryHub, StockHub,
 * SalesReport, Settings and FactoryWorkersHub were already covered by
 * `renders.test.tsx`; the route-guard cases live in
 * `route-guards-render.test.tsx`.)
 *
 * WhatsApp: the journal form's real `JournalFormDialogs`, driven by the same
 * `resolveWhatsAppPrompt` the save mutation uses, instead of a look-alike
 * harness.
 */
import React, { useState } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { resolveWhatsAppPrompt, type WhatsAppPromptState } from "@/lib/whatsapp-prompt";
import { renderWithProviders } from "./helpers";
import { pageState, resetPageState, stubFetchRoutes } from "./pageMocks";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/AppModeContext", async () => (await import("./pageMocks")).appModeMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);
vi.mock("@/contexts/CurrencyContext", async () => (await import("./pageMocks")).currencyMock);
vi.mock("@/contexts/DateFormatContext", async () => (await import("./pageMocks")).dateFormatMock);
vi.mock("@/contexts/ConnectivityContext", async () => (await import("./pageMocks")).connectivityMock);
vi.mock("@/contexts/LocationContext", async () => (await import("./pageMocks")).locationContextMock);
vi.mock("@/contexts/CursorNavContext", async () => (await import("./pageMocks")).cursorNavMock);

beforeEach(() => {
  resetPageState();
  stubFetchRoutes();
});

describe("layout shells", () => {
  it("Vouchers renders the voucher type navigation and the payment form", async () => {
    const { default: Vouchers } = await import("@/pages/Vouchers");
    renderWithProviders(
      <TooltipProvider>
        <Vouchers />
      </TooltipProvider>
    );

    expect(await screen.findByTestId("tab-payment")).toBeInTheDocument();
    expect(screen.getByTestId("tab-receipt")).toBeInTheDocument();
    expect(screen.getByTestId("tab-journal")).toBeInTheDocument();
  });

  describe("POS at a phone viewport", () => {
    const originalWidth = window.innerWidth;
    const originalMatchMedia = window.matchMedia;

    beforeEach(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: 375 });
      window.matchMedia = ((query: string) => ({
        matches: /max-width/.test(query),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })) as any;
    });

    afterEach(() => {
      Object.defineProperty(window, "innerWidth", { configurable: true, value: originalWidth });
      window.matchMedia = originalMatchMedia;
    });

    it("mounts the mobile sale layout without removing the desktop sale grid", async () => {
      pageState.selectedLocation = { id: 3, name: "Main Store", companyId: 1 };
      const { default: POS } = await import("@/pages/pos/POS");
      const { container } = renderWithProviders(<POS />);

      // Mobile flow is present and usable.
      expect(await screen.findByTestId("input-mobile-product-search")).toBeInTheDocument();
      const mobile = container.querySelector('[data-pos-mobile-page="true"]');
      expect(mobile).not.toBeNull();
      expect(mobile!.className).toContain("lg:hidden");

      // The desktop grid stays mounted and is only hidden by CSS, so resizing to a
      // desktop width never loses the rows a cashier typed.
      const notes = screen.getByTestId("input-notes");
      const desktop = notes.closest(".hidden.lg\\:flex");
      expect(desktop, "desktop layout must stay in the DOM behind a responsive class").not.toBeNull();
    });
  });

  it("FactoryContainersHub renders the container list shell", async () => {
    pageState.companyType = "factory";
    pageState.appMode = "factory";
    const { default: FactoryContainersHub } = await import("@/pages/factory/FactoryContainersHub");
    renderWithProviders(<FactoryContainersHub />);

    expect(await screen.findByTestId("button-add-factory-container")).toBeInTheDocument();
    expect(screen.getByTestId("button-view-list")).toBeInTheDocument();
  });

  it("UsersPermissionsHub renders its heading and the users section", async () => {
    const { UsersPermissionsHub } = await import("@/pages/settings/UsersPermissionsHub");
    renderWithProviders(<UsersPermissionsHub userRole="Admin" appMode="erp" />);

    expect(screen.getByRole("heading", { name: /Users & Permissions/ })).toBeInTheDocument();
    expect(await screen.findByText("Manage users and role assignments.")).toBeInTheDocument();
  });
});

// ── WhatsApp prompt, through the real journal-form dialogs ─────────────────

vi.mock("@/components/vouchers/CreateAccountModal", () => ({ CreateAccountModal: () => null }));

function DialogsHarness({
  initial,
  mutate,
  isPending = false,
}: {
  initial: WhatsAppPromptState;
  mutate: (p: NonNullable<WhatsAppPromptState>) => void;
  isPending?: boolean;
}) {
  const [waPendingPrompt, setWaPendingPrompt] = useState<WhatsAppPromptState>(initial);
  const [JournalFormDialogs, setComponent] = useState<any>(null);
  React.useEffect(() => {
    import("@/pages/vouchers/journalform/JournalFormDialogs").then((m) => setComponent(() => m.JournalFormDialogs));
  }, []);
  if (!JournalFormDialogs) return null;
  const model = {
    showCreateAccountModal: false,
    setShowCreateAccountModal: vi.fn(),
    setCreateAccountContext: vi.fn(),
    selectedCompany: { id: 1 },
    handleAccountCreated: vi.fn(),
    modeApiRequest: vi.fn(),
    waPendingPrompt,
    setWaPendingPrompt,
    sendWaStatementMutation: { isPending, mutate },
  };
  return (
    <>
      <button data-testid="simulate-save" onClick={() => setWaPendingPrompt(resolveWhatsAppPrompt(saveResponse))} />
      <JournalFormDialogs model={model} />
    </>
  );
}

let saveResponse: unknown = null;
const promptResponse = {
  voucher: { id: 9 },
  whatsapp: { prompt: true, accountId: 55, month: "June 2026" },
};

describe("journal form WhatsApp prompt", () => {
  beforeEach(() => {
    saveResponse = null;
  });

  it("opens with the month when the save response asks for a prompt", async () => {
    render(<DialogsHarness initial={resolveWhatsAppPrompt(promptResponse)} mutate={vi.fn()} />);

    const dialog = await screen.findByTestId("dialog-whatsapp-prompt");
    expect(dialog).toHaveTextContent("June 2026");
  });

  it("stays closed when the save response has prompt=false", async () => {
    render(
      <DialogsHarness
        initial={resolveWhatsAppPrompt({ voucher: { id: 8 }, whatsapp: { prompt: false } })}
        mutate={vi.fn()}
      />
    );
    await act(async () => {});
    expect(screen.queryByTestId("dialog-whatsapp-prompt")).not.toBeInTheDocument();
  });

  it("closes on Skip without sending", async () => {
    const mutate = vi.fn();
    render(<DialogsHarness initial={resolveWhatsAppPrompt(promptResponse)} mutate={mutate} />);

    fireEvent.click(await screen.findByTestId("button-whatsapp-skip"));
    expect(screen.queryByTestId("dialog-whatsapp-prompt")).not.toBeInTheDocument();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("sends the pending account and month on Send Now", async () => {
    const mutate = vi.fn();
    render(<DialogsHarness initial={resolveWhatsAppPrompt(promptResponse)} mutate={mutate} />);

    fireEvent.click(await screen.findByTestId("button-whatsapp-send"));
    expect(mutate).toHaveBeenCalledWith({ accountId: 55, month: "June 2026" });
  });

  it("disables Send while the statement is being sent", async () => {
    render(<DialogsHarness initial={resolveWhatsAppPrompt(promptResponse)} mutate={vi.fn()} isPending />);

    const send = await screen.findByTestId("button-whatsapp-send");
    expect(send).toBeDisabled();
    expect(send).toHaveTextContent("Sending...");
  });

  it("does not re-open after dismissal when an edit re-save returns no prompt", async () => {
    render(<DialogsHarness initial={resolveWhatsAppPrompt(promptResponse)} mutate={vi.fn()} />);
    fireEvent.click(await screen.findByTestId("button-whatsapp-skip"));

    // The edit re-save's response carries no whatsapp block (the server only
    // prompts once per month), so the dialog must stay closed.
    saveResponse = { voucher: { id: 9 } };
    fireEvent.click(screen.getByTestId("simulate-save"));
    await act(async () => {});
    expect(screen.queryByTestId("dialog-whatsapp-prompt")).not.toBeInTheDocument();
  });
});

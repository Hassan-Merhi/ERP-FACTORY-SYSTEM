import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PageHeader } from "./PageHeader";

const mocks = vi.hoisted(() => ({
  mode: "erp" as "erp" | "factory",
  sharedBack: vi.fn(),
}));

vi.mock("@/contexts/CursorNavContext", () => ({
  useCursorNav: () => ({ config: null }),
}));

vi.mock("@/hooks/use-back-to-parent", () => ({
  useBackToParent: () => mocks.sharedBack,
}));

vi.mock("@/lib/parent-routes", () => ({
  getParentRoute: () => "/inventory",
}));

vi.mock("@/lib/erp-navigation-history", () => ({
  canGoBackToPreviousErpLocation: () => false,
}));

vi.mock("@/contexts/AppModeContext", () => ({
  useAppMode: () => mocks.mode,
}));

vi.mock("wouter", () => ({
  useLocation: () => ["/stock-items/1/history"],
}));

beforeEach(() => {
  mocks.mode = "erp";
  mocks.sharedBack.mockReset();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("PageHeader ERP mobile contract", () => {
  it("keeps contextual meta visible while explanatory subtitles are phone-hidden", () => {
    render(<PageHeader title="Stock Movement" subtitle="Explains the page" meta={<span>Item A · Main store</span>} />);

    expect(screen.getByTestId("text-page-meta").textContent).toBe("Item A · Main store");
    expect(screen.getByTestId("text-page-meta").className).not.toContain("hidden");
    expect(screen.getByTestId("text-page-subtitle").className).toContain("hidden");
    expect(screen.getByTestId("text-page-subtitle").className).toContain("sm:block");
    expect(screen.getByTestId("page-header").getAttribute("data-erp-mobile-header")).toBe("true");
  });

  it("uses a page-specific Back handler and preserves legacy Back test ids", () => {
    const onBack = vi.fn();
    render(<PageHeader title="Stock Flow Details" onBack={onBack} backButtonTestId="button-back-to-sales-report" />);

    const back = screen.getByTestId("button-back-to-sales-report");
    expect(back.getAttribute("aria-label")).toBe("Back");
    fireEvent.click(back);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(mocks.sharedBack).not.toHaveBeenCalled();
  });

  it("falls back to the shared history/parent Back handler", () => {
    render(<PageHeader title="Stock Item Monthly Summary" />);

    fireEvent.click(screen.getByTestId("button-back"));
    expect(mocks.sharedBack).toHaveBeenCalledTimes(1);
  });

  it("does not reserve an action row when every permission-gated action is hidden", () => {
    const canCreate = false;
    render(
      <PageHeader title="Accounts Overview">
        {canCreate && <button type="button">Create</button>}
        {null}
      </PageHeader>
    );

    expect(screen.queryByTestId("page-header-actions")).toBeNull();
  });

  it("renders visible actions in one labelled group", () => {
    render(
      <PageHeader title="Container Tracking">
        <button type="button">Export</button>
        <button type="button">Add</button>
      </PageHeader>
    );

    const actions = screen.getByTestId("page-header-actions");
    expect(actions.getAttribute("role")).toBe("group");
    expect(actions.getAttribute("aria-label")).toBe("Page actions");
    expect(actions.querySelectorAll("button")).toHaveLength(2);
  });

  it("keeps the established Factory header layout", () => {
    mocks.mode = "factory";
    render(<PageHeader title="Raw Stock" subtitle="Factory copy stays visible" />);

    const header = screen.getByTestId("page-header");
    expect(header.getAttribute("data-erp-mobile-header")).toBeNull();
    expect(header.className).toContain("mb-5");
    expect(screen.getByTestId("text-page-subtitle").className).not.toContain("hidden");
  });
});

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { Sidebar, SidebarContent, SidebarProvider, SidebarTrigger } from "./sidebar";

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }));
vi.mock("@/hooks/use-erp-phone-layout", () => ({ useErpPhoneLayout: () => true }));

afterEach(cleanup);

function renderDrawer() {
  render(
    <SidebarProvider>
      <SidebarTrigger data-testid="open-sidebar" />
      <Sidebar>
        <SidebarContent>
          <a href="/factory/daybook" onClick={(event) => event.preventDefault()} data-testid="nav-link">
            Daybook
          </a>
          <a href="https://example.com/help" target="_blank" rel="noreferrer" data-testid="external-link">
            Help
          </a>
          <button type="button" data-testid="section-toggle">
            Finance
          </button>
        </SidebarContent>
      </Sidebar>
    </SidebarProvider>
  );
  fireEvent.click(screen.getByTestId("open-sidebar"));
}

describe("mobile sidebar drawer", () => {
  it("clamps the drawer to the phone width", () => {
    renderDrawer();
    const drawer = document.querySelector('[data-sidebar="sidebar"][data-mobile="true"]') as HTMLElement;
    expect(drawer.style.getPropertyValue("--sidebar-width")).toBe("min(18rem, calc(100vw - 1rem))");
  });

  it("closes as soon as a destination is chosen, even the current page", () => {
    renderDrawer();
    expect(screen.getByTestId("nav-link")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("nav-link"));
    expect(screen.queryByTestId("nav-link")).not.toBeInTheDocument();
  });

  it("stays open for section toggles and links that open a new tab", () => {
    renderDrawer();
    fireEvent.click(screen.getByTestId("section-toggle"));
    expect(screen.getByTestId("nav-link")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("external-link"));
    expect(screen.getByTestId("nav-link")).toBeInTheDocument();
  });
});

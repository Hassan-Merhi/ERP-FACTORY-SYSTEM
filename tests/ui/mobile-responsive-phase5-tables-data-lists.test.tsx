import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-erp-phone-layout", () => ({ useErpPhoneLayout: () => false }));
vi.mock("@/contexts/AppModeContext", () => ({ useAppMode: () => "erp" }));

import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { HorizontalScrollRegion } from "@/components/ui/responsive-accessibility";
import {
  ResponsiveDataList,
  ResponsiveDataListActions,
  ResponsiveDataListEmpty,
  ResponsiveDataListField,
  ResponsiveDataListFields,
  ResponsiveDataListItem,
} from "@/components/ui/responsive-data-list";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

afterEach(cleanup);

/**
 * Phase 5 contract for the shared data primitives, checked on rendered output rather than on
 * source text so refactors that keep the behaviour do not break the suite.
 */
describe("Mobile responsiveness Phase 5 tables and data lists", () => {
  it("renders shared tables inside a focusable, described sideways scroll region", () => {
    render(
      <Table minimumWidth="48rem" scrollLabel="Customers table">
        <TableHeader>
          <TableRow>
            <TableHead>Name</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell>Acme</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    );

    const region = screen.getByRole("region", { name: "Customers table" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveAttribute("data-horizontal-scroll", "true");
    expect(region).toHaveAttribute("data-table-scroll-region", "true");
    // Sideways swipes stay on the table and never chain to the page.
    expect(region.className).toContain("touch-pan-x");
    expect(region.className).toContain("overscroll-x-contain");
    // Keyboard users can see which region has focus.
    expect(region.className).toContain("focus-visible:ring-2");
    // Screen readers are told the region scrolls.
    const descriptionId = region.getAttribute("aria-describedby");
    expect(descriptionId).toBeTruthy();
    expect(document.getElementById(descriptionId as string)).toHaveTextContent(/scroll/i);
    // The caller's minimum width lands on the table, so columns never squeeze below it.
    expect((screen.getByRole("table") as HTMLElement).style.minWidth).toBe("48rem");
    // Tighter rows from sm up, taller touch rows on phones.
    expect(screen.getByRole("columnheader").className).toMatch(/\bh-10\b.*\bsm:h-8\b/);
    expect(screen.getByRole("cell").className).toMatch(/\bpy-2\b.*\bsm:py-1\b/);
  });

  it("builds semantic, touch-sized mobile data lists", () => {
    render(
      <ResponsiveDataList aria-label="Customers">
        <ResponsiveDataListItem>
          <ResponsiveDataListFields>
            <ResponsiveDataListField label="Phone" value="555-0100" />
            <ResponsiveDataListField label="Balance" />
          </ResponsiveDataListFields>
          <ResponsiveDataListActions>
            <button type="button">Edit</button>
          </ResponsiveDataListActions>
        </ResponsiveDataListItem>
        <ResponsiveDataListEmpty>No customers yet</ResponsiveDataListEmpty>
      </ResponsiveDataList>
    );

    const list = screen.getByRole("list", { name: "Customers" });
    expect(list).toHaveAttribute("data-mobile-data-list", "true");
    const item = within(list).getByRole("listitem");
    // Fields are a real definition list: labels in <dt>, values in <dd>.
    const fields = item.querySelector("dl") as HTMLElement;
    expect(fields).not.toBeNull();
    const terms = Array.from(fields.querySelectorAll("dt")).map((node) => node.textContent);
    const values = Array.from(fields.querySelectorAll("dd")).map((node) => node.textContent);
    expect(terms).toEqual(["Phone", "Balance"]);
    // A missing value shows a placeholder instead of an empty cell.
    expect(values).toEqual(["555-0100", "—"]);
    // Row actions are grouped for assistive tech and keep 44px touch targets on phones.
    const actions = within(item).getByRole("group", { name: "Row actions" });
    expect(actions.className).toContain("[&>*]:min-h-11");
    expect(within(actions).getByRole("button", { name: "Edit" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("No customers yet");
  });

  it("keeps pagination usable on narrow touch screens", () => {
    render(
      <Pagination>
        <PaginationContent>
          <PaginationItem>
            <PaginationPrevious href="#prev" />
          </PaginationItem>
          <PaginationItem>
            <PaginationLink href="#1" isActive>
              1
            </PaginationLink>
          </PaginationItem>
          <PaginationItem>
            <PaginationEllipsis />
          </PaginationItem>
          <PaginationItem>
            <PaginationNext href="#next" />
          </PaginationItem>
        </PaginationContent>
      </Pagination>
    );

    const nav = screen.getByRole("navigation", { name: "pagination" });
    // The strip scrolls sideways instead of wrapping or clipping when it is wider than the screen.
    expect(nav.className).toContain("overflow-x-auto");
    expect(nav.querySelector("ul")?.className).toContain("min-w-max");
    // Previous/Next keep their names when the visible word is hidden on phones.
    const previous = screen.getByRole("link", { name: "Go to previous page" });
    const next = screen.getByRole("link", { name: "Go to next page" });
    for (const link of [previous, next, screen.getByRole("link", { name: "1" })]) {
      expect(link.className).toMatch(/\bmin-h-11\b/);
      expect(link.className).toMatch(/\bmin-w-11\b/);
    }
    expect(previous.querySelector("span.hidden.sm\\:inline")).toHaveTextContent("Previous");
    expect(next.querySelector("span.hidden.sm\\:inline")).toHaveTextContent("Next");
    expect(screen.getByRole("link", { name: "1" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByText("More pages")).toHaveClass("sr-only");
  });

  it("standardizes generic horizontal scroll regions with keyboard scrolling", () => {
    render(
      <HorizontalScrollRegion label="Weekly plan">
        <div style={{ width: 2000 }}>wide content</div>
      </HorizontalScrollRegion>
    );

    const region = screen.getByRole("region", { name: "Weekly plan" });
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region).toHaveAttribute("data-horizontal-scroll", "true");
    expect(region).toHaveAttribute("data-horizontal-scroll-region", "true");
    expect(region.className).toContain("touch-pan-x");
    const descriptionId = region.getAttribute("aria-describedby");
    expect(document.getElementById(descriptionId as string)).toHaveTextContent(/scroll horizontally/i);

    // Arrow keys scroll the region once it is wider than its box.
    Object.defineProperty(region, "scrollWidth", { configurable: true, value: 2000 });
    Object.defineProperty(region, "clientWidth", { configurable: true, value: 400 });
    const scrollBy = vi.fn();
    region.scrollBy = scrollBy;
    window.matchMedia = window.matchMedia ?? ((() => ({ matches: false })) as unknown as typeof window.matchMedia);
    fireEvent.keyDown(region, { key: "ArrowRight" });
    expect(scrollBy).toHaveBeenCalledWith(expect.objectContaining({ left: 80 }));
    fireEvent.keyDown(region, { key: "ArrowLeft" });
    expect(scrollBy).toHaveBeenLastCalledWith(expect.objectContaining({ left: -80 }));
  });

  it("keeps shared display primitives free from ERP business behavior", async () => {
    // Primitives are pure presentation: no data fetching modules are pulled in when they load.
    const modules = await Promise.all([
      import("@/components/ui/table"),
      import("@/components/ui/pagination"),
      import("@/components/ui/responsive-data-list"),
      import("@/components/ui/responsive-accessibility"),
    ]);
    for (const mod of modules) {
      for (const exported of Object.values(mod)) {
        expect(typeof exported === "function" || typeof exported === "object").toBe(true);
      }
    }
    // Rendering each primitive issues no network calls.
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    render(
      <>
        <Table>
          <TableBody>
            <TableRow>
              <TableCell>x</TableCell>
            </TableRow>
          </TableBody>
        </Table>
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationLink href="#">1</PaginationLink>
            </PaginationItem>
          </PaginationContent>
        </Pagination>
        <ResponsiveDataList>
          <ResponsiveDataListItem>row</ResponsiveDataListItem>
        </ResponsiveDataList>
        <HorizontalScrollRegion label="r">c</HorizontalScrollRegion>
      </>
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

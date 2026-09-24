import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErpMobileFilters } from "./erp-mobile-filters";
import { ERP_PHONE_LAYOUT_QUERY, useErpPhoneLayout } from "@/hooks/use-erp-phone-layout";

vi.mock("@/contexts/ApplicationLanguageContext", () => ({
  useApplicationLanguage: () => ({ t: (key: string) => key }),
}));

type Listener = () => void;

function mockMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  const mql = {
    matches: initial,
    media: ERP_PHONE_LAYOUT_QUERY,
    addEventListener: (_: string, fn: Listener) => listeners.add(fn),
    removeEventListener: (_: string, fn: Listener) => listeners.delete(fn),
  };
  const original = window.matchMedia;
  window.matchMedia = vi.fn(() => mql) as unknown as typeof window.matchMedia;
  return {
    set(value: boolean) {
      mql.matches = value;
      listeners.forEach((fn) => fn());
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

let media: ReturnType<typeof mockMatchMedia> | null = null;

afterEach(() => {
  cleanup();
  media?.restore();
  media = null;
});

describe("useErpPhoneLayout", () => {
  it("follows the phone media query", () => {
    media = mockMatchMedia(false);
    const { result } = renderHook(() => useErpPhoneLayout());
    expect(result.current).toBe(false);
    act(() => media!.set(true));
    expect(result.current).toBe(true);
  });
});

describe("ErpMobileFilters", () => {
  it("renders the page's own inline filters on tablet and desktop", () => {
    media = mockMatchMedia(false);
    render(
      <ErpMobileFilters label="Stock filters" quick={<input data-testid="quick" />}>
        {(layout) => <div data-testid="filters">{layout}</div>}
      </ErpMobileFilters>
    );

    expect(screen.getByTestId("filters")).toHaveTextContent("inline");
    expect(screen.queryByTestId("quick")).not.toBeInTheDocument();
    expect(screen.queryByTestId("erp-filters-open")).not.toBeInTheDocument();
  });

  it("collapses filters behind a counted trigger and a bottom sheet on phones", () => {
    media = mockMatchMedia(true);
    const onClear = vi.fn();
    render(
      <ErpMobileFilters
        label="Stock filters"
        primary={<div data-testid="period" />}
        quick={<input data-testid="quick" />}
        activeCount={2}
        onClear={onClear}
        data-testid="stock"
      >
        {(layout) => <div data-testid="filters">{layout}</div>}
      </ErpMobileFilters>
    );

    expect(screen.getByRole("search", { name: "Stock filters" })).toBeInTheDocument();
    expect(screen.getByTestId("period")).toBeInTheDocument();
    expect(screen.getByTestId("quick")).toBeInTheDocument();
    expect(screen.getByTestId("stock-active-count")).toHaveTextContent("2");
    expect(screen.queryByTestId("filters")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("stock-open"));
    expect(screen.getByTestId("stock-sheet")).toBeInTheDocument();
    expect(screen.getByTestId("filters")).toHaveTextContent("sheet");

    fireEvent.click(screen.getByTestId("stock-clear"));
    expect(onClear).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("stock-apply"));
    expect(screen.queryByTestId("stock-sheet")).not.toBeInTheDocument();
  });

  it("disables Clear when nothing is active and hides the count", () => {
    media = mockMatchMedia(true);
    render(
      <ErpMobileFilters label="Stock filters" onClear={vi.fn()} data-testid="stock">
        <div data-testid="filters" />
      </ErpMobileFilters>
    );

    expect(screen.queryByTestId("stock-active-count")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("stock-open"));
    expect(screen.getByTestId("stock-clear")).toBeDisabled();
  });
});

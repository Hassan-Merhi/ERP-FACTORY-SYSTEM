import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CountryActivityKPI } from "./CountryActivityKPI";

function renderKpi() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <CountryActivityKPI />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ companies: [] }), { status: 200 }))
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("CountryActivityKPI header", () => {
  it("keeps the expand toggle and the day navigator as sibling controls", () => {
    renderKpi();
    const toggle = screen.getByTestId("button-country-activity-expand");

    expect(toggle.tagName).toBe("BUTTON");
    expect(toggle.querySelector("button, a[href], [role=button]")).toBeNull();
    expect(toggle.contains(screen.getByTestId("button-activity-prev"))).toBe(false);
  });

  it("toggles on its own button, not from the day navigator", () => {
    renderKpi();
    const toggle = screen.getByTestId("button-country-activity-expand");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(screen.getByTestId("button-activity-prev"));
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});

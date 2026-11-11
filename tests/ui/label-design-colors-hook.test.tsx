import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { A4_DESIGN_OPTIONS } from "@/lib/labelHtml";
import { useLabelDesignColors } from "@/hooks/useLabelDesignColors";

/**
 * The label-design palette is company data: it is read only for the selected
 * company, cached under that company's key, and never fetched without one.
 */

const harness = vi.hoisted(() => ({ companyId: 1 as number | null }));

vi.mock("@/contexts/CompanyContext", () => ({
  useOptionalCompany: () => (harness.companyId === null ? null : { selectedCompany: { id: harness.companyId } }),
}));

const fetchMock = vi.fn();

function renderPalette() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useLabelDesignColors(), { wrapper }) };
}

function respondWith(body: unknown) {
  fetchMock.mockResolvedValue({ json: async () => body });
}

beforeEach(() => {
  harness.companyId = 1;
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useLabelDesignColors", () => {
  it("maps the selected company's palette and caches it under that company", async () => {
    respondWith([
      { id: 4, slug: "blue", label: "Blue", colorHex: "#00f", isDefault: true, hasCustom: false, lastModified: null },
      { id: 9, slug: "gold", label: "Gold", colorHex: "#fc0", isDefault: false, hasCustom: true, lastModified: 1700 },
    ]);
    const { result, client } = renderPalette();

    await waitFor(() => expect(result.current.colors.map((c) => c.value)).toEqual(["blue", "gold"]));
    expect(fetchMock).toHaveBeenCalledWith("/api/factory/label-design-colors", { credentials: "include" });
    expect(result.current.colors[0]).toMatchObject({
      id: 4,
      color: "#00f",
      previewUrl: "/labels/previews/hmd-blue-preview.webp",
    });
    expect(result.current.colors[1]).toMatchObject({ hasCustom: true, previewUrl: "/labels/hmd-gold.jpg?t=1700" });
    expect(client.getQueryData(["/api/factory/label-design-colors", 1])).toHaveLength(2);
    expect(client.getQueryData(["/api/factory/label-design-colors", 2])).toBeUndefined();
  });

  it("falls back to the built-in palette when the server does not return a list", async () => {
    respondWith({ message: "Forbidden" });
    const { result } = renderPalette();

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.colors.map((c) => c.value)).toEqual(A4_DESIGN_OPTIONS.map((o) => o.value));
    expect(result.current.colors.every((c) => c.isDefault && c.hasCustom === false)).toBe(true);
  });

  it("does not request a palette before a company is selected", () => {
    harness.companyId = null;
    const { result } = renderPalette();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.colors.map((c) => c.value)).toEqual(A4_DESIGN_OPTIONS.map((o) => o.value));
  });
});

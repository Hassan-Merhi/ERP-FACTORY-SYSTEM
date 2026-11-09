import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useErpServerPagination } from "./useErpServerPagination";

describe("ERP server pagination state", () => {
  it("uses server totals and never slices the returned rows", () => {
    const { result, rerender } = renderHook(
      (props: { companyId: number; totalPages: number; filterKey: string }) =>
        useErpServerPagination({ ...props, pageSize: 100 }),
      { initialProps: { companyId: 1, totalPages: 5, filterKey: "" } },
    );
    expect(result.current.page).toBe(1);
    act(() => result.current.onPageChange(4));
    expect(result.current.page).toBe(4);
    rerender({ companyId: 1, totalPages: 2, filterKey: "" });
    expect(result.current.page).toBe(2);
    rerender({ companyId: 2, totalPages: 2, filterKey: "" });
    expect(result.current.page).toBe(1);
  });

  it("resets on search, bounds page changes and handles empty results", () => {
    const { result, rerender } = renderHook(
      (filterKey: string) => useErpServerPagination({ companyId: 1, filterKey, totalPages: 3 }),
      { initialProps: "" },
    );
    act(() => result.current.onPageChange(99));
    expect(result.current.page).toBe(3);
    rerender("widget");
    expect(result.current.page).toBe(1);
    act(() => result.current.onPageChange(-5));
    expect(result.current.page).toBe(1);
    act(() => result.current.onPageChange(2));
    expect(result.current.page).toBe(2);
  });
});

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ErpListFilters } from "./ErpListFilters";

describe("ERP list filters", () => {
  it("delegates controlled search to the canonical search input", () => {
    const onSearchChange = vi.fn();
    render(
      <ErpListFilters
        search="part"
        onSearchChange={onSearchChange}
        searchPlaceholder="Search items"
        searchTestId="input-item-search"
        mobileFilters={false}
      />
    );

    const input = screen.getByTestId("input-item-search");
    expect(input).toHaveValue("part");
    expect(input).toHaveAttribute("type", "search");
    fireEvent.change(input, { target: { value: "parts" } });
    expect(onSearchChange).toHaveBeenCalledWith("parts");
  });
});

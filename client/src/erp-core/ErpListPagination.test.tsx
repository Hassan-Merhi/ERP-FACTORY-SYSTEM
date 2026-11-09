import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ErpListPagination } from "./ErpListPagination";

describe("ERP pagination", () => {
  it("uses accessible navigation and enforces page boundaries", () => {
    const onPageChange = vi.fn();
    render(<ErpListPagination page={1} totalPages={3} totalItems={250} pageSize={100} onPageChange={onPageChange} />);
    expect(screen.getByRole("navigation", { name: "Table pagination" })).toBeInTheDocument();
    expect(screen.getByText("Showing 1–100 of 250")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Previous page" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("omits unnecessary controls for single-page lists", () => {
    const { container } = render(<ErpListPagination page={1} totalPages={1} onPageChange={() => undefined} />);
    expect(container).toBeEmptyDOMElement();
  });
});

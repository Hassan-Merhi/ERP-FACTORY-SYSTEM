import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ErpListTable } from "./ErpListTable";

describe("ERP list table", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  function renderList() {
    return render(
      <ErpListTable pageKey="phase2-test" companyId={123} scrollLabel="Test inventory">
        <TableHeader>
          <TableRow><TableHead>Item</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          <TableRow><TableCell>Example</TableCell></TableRow>
        </TableBody>
      </ErpListTable>
    );
  }

  it("shares the existing sticky table structure and defaults to compact density", () => {
    renderList();
    const table = screen.getByRole("table");
    expect(table).toHaveAttribute("data-erp-list-table");
    expect(screen.getByRole("region", { name: "Test inventory" })).toHaveAttribute("data-table-density", "compact");
    expect(screen.getByRole("columnheader", { name: "Item" })).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "Example" })).toBeInTheDocument();
  });

  it("saves a user's preferred row density per company and page", () => {
    const { unmount } = renderList();
    fireEvent.change(screen.getByLabelText("Table row density"), { target: { value: "comfortable" } });
    expect(screen.getByRole("region", { name: "Test inventory" })).toHaveAttribute("data-table-density", "comfortable");
    unmount();
    renderList();
    expect(screen.getByLabelText("Table row density")).toHaveValue("comfortable");
  });
});

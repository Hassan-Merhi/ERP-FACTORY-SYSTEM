import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { labelMobileCardCells, mobileCardColumnLabels } from "./mobile-card-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "./table";

const phone = vi.hoisted(() => ({ value: true, mode: "erp" as "erp" | "factory" }));

vi.mock("@/hooks/use-erp-phone-layout", () => ({
  useErpPhoneLayout: () => phone.value,
}));

vi.mock("@/contexts/AppModeContext", () => ({
  useAppMode: () => phone.mode,
}));

afterEach(() => {
  cleanup();
  phone.value = true;
  phone.mode = "erp";
});

function buildTable(html: string) {
  const host = document.createElement("div");
  host.innerHTML = html;
  return host.querySelector("table") as HTMLTableElement;
}

describe("mobileCardColumnLabels", () => {
  it("combines grouped headers top to bottom", () => {
    const table = buildTable(`
      <table>
        <thead>
          <tr><th rowspan="2">Month</th><th colspan="2">Inwards</th><th colspan="2">Closing</th></tr>
          <tr><th>Qty</th><th>Value</th><th>Qty</th><th>Value</th></tr>
        </thead>
        <tbody></tbody>
      </table>`);

    expect(mobileCardColumnLabels(table)).toEqual([
      "Month",
      "Inwards · Qty",
      "Inwards · Value",
      "Closing · Qty",
      "Closing · Value",
    ]);
  });
});

describe("labelMobileCardCells", () => {
  it("labels fields and assigns card roles", () => {
    const table = buildTable(`
      <table>
        <thead><tr><th></th><th>Voucher</th><th>Amount</th><th></th><th></th></tr></thead>
        <tbody>
          <tr>
            <td><input type="checkbox" /></td>
            <td>JV-1</td>
            <td>$ 10</td>
            <td><svg></svg></td>
            <td><button>Edit</button></td>
          </tr>
          <tr><td colspan="5">No more rows</td></tr>
        </tbody>
      </table>`);

    labelMobileCardCells(table);
    const [select, title, amount, chevron, actions] = Array.from(table.tBodies[0].rows[0].cells);

    expect(select.dataset.mobileCell).toBe("select");
    expect(title.dataset.mobileCell).toBe("title");
    expect(amount.dataset.mobileCell).toBe("field");
    expect(amount.dataset.label).toBe("Amount");
    expect(chevron.dataset.mobileCell).toBe("hidden");
    expect(actions.dataset.mobileCell).toBe("actions");
    expect(table.tBodies[0].rows[1].cells[0].dataset.mobileCell).toBe("full");
  });

  it("skips ordinals and icon-only status cells when choosing the title", () => {
    const table = buildTable(`
      <table>
        <thead><tr><th>#</th><th>Verified</th><th>Reference</th><th>Weight</th></tr></thead>
        <tbody><tr><td>3</td><td><svg></svg></td><td>BL-0042</td><td>120 kg</td></tr></tbody>
      </table>`);

    labelMobileCardCells(table);
    const [ordinal, verified, reference, weight] = Array.from(table.tBodies[0].rows[0].cells);

    expect(ordinal.dataset.mobileCell).toBe("hidden");
    expect(verified.dataset.mobileCell).toBe("field");
    expect(verified.dataset.label).toBe("Verified");
    expect(reference.dataset.mobileCell).toBe("title");
    expect(weight.dataset.mobileCell).toBe("field");
  });

  it("keeps author-provided labels and roles across relabels", () => {
    const table = buildTable(`
      <table>
        <thead><tr><th>#</th><th>Name</th><th>Qty</th></tr></thead>
        <tbody><tr><td data-mobile-cell="hidden">1</td><td>Shirts</td><td data-label="Quantity">4</td></tr></tbody>
      </table>`);

    labelMobileCardCells(table);
    labelMobileCardCells(table);
    const [index, name, qty] = Array.from(table.tBodies[0].rows[0].cells);

    expect(index.dataset.mobileCell).toBe("hidden");
    expect(name.dataset.mobileCell).toBe("title");
    expect(qty.dataset.label).toBe("Quantity");
  });
});

function renderTable(mobileLayout?: "cards") {
  return render(
    <Table mobileLayout={mobileLayout} data-testid="table">
      <TableHeader>
        <TableRow>
          <TableHead>Item</TableHead>
          <TableHead>Qty</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        <TableRow>
          <TableCell>Shirts</TableCell>
          <TableCell>4</TableCell>
        </TableRow>
      </TableBody>
    </Table>
  );
}

describe("Table mobileLayout", () => {
  it("renders cards on ERP phones and labels cells from the header", () => {
    renderTable("cards");
    const table = screen.getByTestId("table");

    expect(table).toHaveAttribute("data-mobile-cards", "true");
    expect(screen.getByText("4")).toHaveAttribute("data-label", "Qty");
    expect(screen.getByText("Shirts")).toHaveAttribute("data-mobile-cell", "title");
  });

  it("keeps the table on tablet/desktop, outside ERP mode, and when not opted in", () => {
    phone.value = false;
    renderTable("cards");
    expect(screen.getByTestId("table")).not.toHaveAttribute("data-mobile-cards");
    cleanup();

    phone.value = true;
    phone.mode = "factory";
    renderTable("cards");
    expect(screen.getByTestId("table")).not.toHaveAttribute("data-mobile-cards");
    cleanup();

    phone.mode = "erp";
    renderTable();
    expect(screen.getByTestId("table")).not.toHaveAttribute("data-mobile-cards");
  });
});

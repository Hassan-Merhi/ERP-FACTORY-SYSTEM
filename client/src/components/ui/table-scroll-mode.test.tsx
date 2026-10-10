import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/use-erp-phone-layout", () => ({ useErpPhoneLayout: () => false }));
vi.mock("@/contexts/AppModeContext", () => ({ useAppMode: () => "erp" }));

import { Table, TableBody, TableCell, TableRow } from "./table";

function Rows() {
  return (
    <TableBody>
      <TableRow>
        <TableCell>one</TableCell>
      </TableRow>
    </TableBody>
  );
}

const region = () => screen.getByRole("region");

afterEach(cleanup);

describe("Table scroll mode", () => {
  it("lets the page scroll for tables inside the workspace", () => {
    render(
      <main id="main-content">
        <Table>
          <Rows />
        </Table>
      </main>
    );
    expect(region()).toHaveAttribute("data-scroll-mode", "page");
    expect(region().className).toContain("max-h-none");
    expect(region().className).not.toContain("max-h-[70vh]");
  });

  it("keeps its own capped region inside dialogs and sheets", () => {
    render(
      <main id="main-content">
        <div role="dialog">
          <Table>
            <Rows />
          </Table>
        </div>
      </main>
    );
    expect(region()).toHaveAttribute("data-scroll-mode", "capped");
    expect(region().className).toContain("max-h-[70vh]");
  });

  it("respects an explicit cap or overflow from the caller", () => {
    render(
      <main id="main-content">
        <Table wrapperClassName="max-h-[calc(100dvh-220px)]">
          <Rows />
        </Table>
      </main>
    );
    expect(region()).toHaveAttribute("data-scroll-mode", "capped");
    expect(region().className).toContain("max-h-[calc(100dvh-220px)]");
  });

  it("caps tables rendered outside any workspace", () => {
    render(
      <Table>
        <Rows />
      </Table>
    );
    expect(region()).toHaveAttribute("data-scroll-mode", "capped");
  });
});

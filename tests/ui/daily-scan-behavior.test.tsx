/**
 * Daily Scan: the factory floor's end-of-day check that every bale produced
 * that day was scanned. Covers the day summary, scanning a bale, and the Excel
 * export — which used to throw on every use because the dd/mm/yyyy sheet name
 * contains "/", a character Excel does not allow in sheet names.
 */
import React from "react";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type ExcelJS from "exceljs";
import { renderWithProviders } from "./helpers";

vi.mock("wouter", async () => (await import("./pageMocks")).wouterMock);
vi.mock("@/contexts/AppModeContext", async () => (await import("./pageMocks")).appModeMock);
vi.mock("@/contexts/CompanyContext", async () => (await import("./pageMocks")).companyMock);

const exported = vi.hoisted(() => ({ workbook: null as ExcelJS.Workbook | null, fileName: "" }));
vi.mock("@/lib/excelHelper", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/excelHelper")>()),
  writeFile: vi.fn(async (workbook: ExcelJS.Workbook, fileName: string) => {
    exported.workbook = workbook;
    exported.fileName = fileName;
  }),
}));

const api = vi.hoisted(() => ({ apiRequest: vi.fn() }));
vi.mock("@/lib/queryClient", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queryClient")>()),
  apiRequest: api.apiRequest,
}));

import DailyScan from "@/pages/factory/DailyScan";

function bale(i: number, scanned: boolean) {
  return {
    id: i,
    reference_number: `REF-${i}`,
    article_code: `ART-${i}`,
    product_name: `Product ${i}`,
    weight_kg: "50.5",
    status: "in_stock",
    date_bale_produced: "2026-09-23",
    worker_name: "Ali",
    scan_id: scanned ? 100 + i : null,
    scanned_at: scanned ? "2026-09-23T09:15:00Z" : null,
  };
}

beforeEach(() => {
  exported.workbook = null;
  api.apiRequest.mockReset();
  (global as any).fetch = vi.fn(async (url: string) => ({
    ok: true,
    status: 200,
    json: async () => (String(url).startsWith("/api/factory/daily-bale-scans") ? [bale(1, true), bale(2, false)] : []),
  }));
});

describe("Daily Scan", () => {
  it("summarises the day and exports a workbook with a valid sheet name", async () => {
    renderWithProviders(<DailyScan />);
    await screen.findByText("REF-2");

    fireEvent.click(screen.getByTestId("button-daily-scan-export"));
    await waitFor(() => expect(exported.workbook).not.toBeNull());

    const date = (screen.getByTestId("input-daily-scan-date") as HTMLInputElement).value;
    const [y, m, d] = date.split("-");
    const ws = exported.workbook!.worksheets[0];
    expect(ws.name).toBe(`${d}-${m}-${y}`);
    expect(exported.fileName).toBe(`daily-scan-${date}.xlsx`);

    const rows: unknown[][] = [];
    ws.eachRow((row) => rows.push((row.values as unknown[]).slice(1)));
    expect(rows[0][1]).toBe("Ref Code");
    // Scanned bales are listed first, then the missing ones, then the total.
    expect(rows.slice(1, 3).map((r) => [r[1], r[7]])).toEqual([
      ["REF-1", "Scanned"],
      ["REF-2", "Missing"],
    ]);
    expect(rows[3][4]).toBe(101);
    expect(rows[3][7]).toBe("1/2 scanned");
  });

  it("posts a scan for the typed reference", async () => {
    api.apiRequest.mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 555,
          reference_number: "REF-2",
          scanned_at: "2026-09-23T10:00:00Z",
          product_name: "Product 2",
        })
      )
    );
    renderWithProviders(<DailyScan />);
    await screen.findByText("REF-2");

    const input = screen.getByTestId("input-daily-scan-ref");
    fireEvent.change(input, { target: { value: "ref-2" } });
    fireEvent.click(screen.getByTestId("button-daily-scan-submit"));

    await waitFor(() => expect(api.apiRequest).toHaveBeenCalled());
    const [method, url, body] = api.apiRequest.mock.calls[0];
    expect(method).toBe("POST");
    expect(url).toContain("/api/factory/daily-bale-scans");
    expect(JSON.stringify(body)).toContain("REF-2");
  });

  it("moves between days", async () => {
    renderWithProviders(<DailyScan />);
    const dateInput = screen.getByTestId("input-daily-scan-date") as HTMLInputElement;
    const start = dateInput.value;

    fireEvent.click(screen.getByTestId("button-daily-scan-prev-day"));
    const previous = dateInput.value;
    expect(previous < start).toBe(true);
    fireEvent.click(screen.getByTestId("button-daily-scan-next-day"));
    expect(dateInput.value).toBe(start);
  });
});

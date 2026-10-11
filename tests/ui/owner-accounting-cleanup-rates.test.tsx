/**
 * Accounting clean-up, card 2 (and Settings → FX Rates): dated rate entry and
 * the rates-file import, which reads the prepared ECB table as it is, previews
 * each row as new / same as recorded / differs from recorded, and saves through
 * the audited import route.
 */
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "./helpers";

const harness = vi.hoisted(() => ({ apiRequestPrivileged: vi.fn(), apiRequest: vi.fn(), toast: vi.fn() }));

vi.mock("@/lib/queryClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/queryClient")>();
  return {
    ...actual,
    apiRequestPrivileged: harness.apiRequestPrivileged,
    apiRequest: harness.apiRequest,
    getAppDate: () => "2026-10-11",
  };
});
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: harness.toast }) }));

import { RateFileImportPanel, rateImportBody } from "@/pages/accounting-cleanup/RateFileImportPanel";
import { classifyRateRows, parseRateFile } from "@/pages/accounting-cleanup/rateFileImport";
import { FxRatesCard } from "@/pages/settings/FxRatesCard";

/** The exact header of the prepared ECB table (scratchpad prod-prep/ecb-rates.csv) and three of its rows. */
const ECB_CSV = [
  "date,currency,ecb_fixing_date,usd_per_eur,aud_per_eur,factory_rate,convention,lines,native_total,usd_total,usd_carried_today,usd_change_per_side,fixing_note",
  "2026-03-26,AUD,2026-03-26,1.1539,1.6693,0.691248,USD per 1 unit (factory_fx_rates.rate_to_usd),8,61717.50,42662.10,61717.50,-19055.40,",
  "2026-04-04,AUD,2026-04-02,1.1525,1.6771,0.687198,USD per 1 unit (factory_fx_rates.rate_to_usd),4,31650.00,21749.82,31650.00,-9900.18,no ECB fixing on 2026-04-04 (Saturday); last fixing on or before",
  "2026-03-26,EUR,2026-03-26,1.1539,1.6693,1.153900,USD per 1 unit (factory_fx_rates.rate_to_usd),52,134691.10,155420.06,134691.10,20728.96,",
  "",
].join("\n");

const owner = {
  seedQueries: [[["/api/auth/me"], { id: "u1", username: "owner", role: "Owner", currentRole: "Owner" }]] as const,
};

function upload(input: HTMLElement, content: string, name = "ecb-rates.csv") {
  const file = new File([content], name, { type: "text/csv" });
  fireEvent.change(input, { target: { files: [file] } });
}

beforeEach(() => {
  harness.apiRequestPrivileged.mockReset();
  harness.apiRequest.mockReset();
  harness.toast.mockReset();
});

afterEach(() => vi.clearAllMocks());

describe("rates file parsing", () => {
  it("reads the prepared ECB table: the factory rate per currency and date, its fixing as the source", () => {
    const parsed = parseRateFile(ECB_CSV, "factory", "2026-10-11");
    expect(parsed.format).toBe("ecb");
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toEqual([
      {
        line: 2,
        fromCurrency: "AUD",
        toCurrency: "USD",
        effectiveDate: "2026-03-26",
        rate: "0.691248",
        source: "ECB 2026-03-26",
      },
      {
        line: 3,
        fromCurrency: "AUD",
        toCurrency: "USD",
        effectiveDate: "2026-04-04",
        rate: "0.687198",
        source: "ECB 2026-04-02",
      },
      {
        line: 4,
        fromCurrency: "EUR",
        toCurrency: "USD",
        effectiveDate: "2026-03-26",
        rate: "1.1539",
        source: "ECB 2026-03-26",
      },
    ]);
  });

  it("reads the simple formats and refuses future dates, bad rows and duplicates", () => {
    const factory = parseRateFile(
      "currency,date,rate_to_usd,source\nEUR,2026-05-01,1.17,manual\nEUR,2026-11-01,1.2,\nUSD,2026-05-01,1,\nEUR,2026-05-01,1.18,\nAUD,2026-02-30,0.6,\nAUD,2026-05-02,-1,",
      "factory",
      "2026-10-11"
    );
    expect(factory.rows.map((row) => [row.fromCurrency, row.effectiveDate, row.rate])).toEqual([
      ["EUR", "2026-05-01", "1.17"],
    ]);
    expect(factory.errors.map((error) => [error.line, error.reason])).toEqual([
      [3, "future"],
      [4, "currency"],
      [5, "duplicate"],
      [6, "date"],
      [7, "rate"],
    ]);
    const company = parseRateFile(
      "from_currency,to_currency,date,rate\nUSD,XOF,2026-05-01,600",
      "company",
      "2026-10-11"
    );
    expect(company.rows[0]).toMatchObject({ fromCurrency: "USD", toCurrency: "XOF", rate: "600" });
    expect(
      parseRateFile("from_currency,to_currency,date,rate\nUSD,XOF,2026-05-01,600", "factory", "2026-10-11").errors
    ).toEqual([{ line: 1, reason: "columns" }]);
  });

  it("classifies each row against the rate in force on its date (the latest saved)", () => {
    const parsed = parseRateFile(ECB_CSV, "factory", "2026-10-11");
    const rows = classifyRateRows(parsed.rows, [
      { fromCurrency: "AUD", toCurrency: "USD", effectiveDate: "2026-03-26", rate: "0.69124800", id: 1 },
      { fromCurrency: "EUR", toCurrency: "USD", effectiveDate: "2026-03-26", rate: "1.10000000", id: 2 },
      { fromCurrency: "EUR", toCurrency: "USD", effectiveDate: "2026-03-26", rate: "1.15000000", id: 3 },
    ]);
    expect(rows.map((row) => [row.fromCurrency, row.effectiveDate, row.status, row.recorded])).toEqual([
      ["AUD", "2026-03-26", "identical", "0.691248"],
      ["AUD", "2026-04-04", "new", null],
      ["EUR", "2026-03-26", "conflict", "1.15"],
    ]);
    expect(rateImportBody("factory", rows, false).rows).toEqual([
      { currencyCode: "AUD", effectiveDate: "2026-04-04", rateToUsd: "0.687198" },
    ]);
    expect(rateImportBody("factory", rows, true)).toMatchObject({ replaceConflicts: true, rows: { length: 2 } });
  });
});

describe("rates file import panel", () => {
  it("previews new, same and differing rows and saves only the chosen ones", async () => {
    harness.apiRequestPrivileged.mockResolvedValue({ json: async () => ({ inserted: [{}, {}], identical: [{}] }) });
    const onSaved = vi.fn();
    renderWithProviders(
      <RateFileImportPanel
        kind="factory"
        recorded={[
          { fromCurrency: "AUD", toCurrency: "USD", effectiveDate: "2026-03-26", rate: "0.691248", id: 1 },
          { fromCurrency: "EUR", toCurrency: "USD", effectiveDate: "2026-03-26", rate: "1.15", id: 2 },
        ]}
        importUrl="/api/factory/fx-rates/batch"
        today="2026-10-11"
        onSaved={onSaved}
      />
    );
    upload(screen.getByTestId("input-rate-file-factory"), ECB_CSV);
    expect(await screen.findByTestId("count-rate-new-factory")).toHaveTextContent("New: 1");
    expect(screen.getByTestId("count-rate-identical-factory")).toHaveTextContent("Same as recorded: 1");
    expect(screen.getByTestId("count-rate-conflict-factory")).toHaveTextContent("Differs from recorded: 1");
    expect(screen.getByTestId("row-rate-import-EUR-2026-03-26")).toHaveTextContent("Differs from recorded");
    expect(screen.getByTestId("button-save-rate-file-factory")).toHaveTextContent("Save 1 rates");

    fireEvent.click(screen.getByTestId("checkbox-rate-replace-factory"));
    expect(screen.getByTestId("button-save-rate-file-factory")).toHaveTextContent("Save 2 rates");
    fireEvent.click(screen.getByTestId("button-save-rate-file-factory"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(harness.apiRequestPrivileged).toHaveBeenCalledWith("POST", "/api/factory/fx-rates/batch", {
      replaceConflicts: true,
      rows: [
        { currencyCode: "AUD", effectiveDate: "2026-04-04", rateToUsd: "0.687198" },
        { currencyCode: "EUR", effectiveDate: "2026-03-26", rateToUsd: "1.1539" },
      ],
    });
  });

  it("does not save a file with refused rows", async () => {
    renderWithProviders(
      <RateFileImportPanel
        kind="factory"
        recorded={[]}
        importUrl="/api/factory/fx-rates/batch"
        today="2026-10-11"
        onSaved={vi.fn()}
      />
    );
    upload(
      screen.getByTestId("input-rate-file-factory"),
      "currency,date,rate_to_usd\nEUR,2026-12-01,1.2\nEUR,2026-05-01,1.17"
    );
    expect(await screen.findByTestId("rate-import-errors-factory")).toHaveTextContent(
      "Line 2:Dated after today: refused"
    );
    expect(screen.getByTestId("button-save-rate-file-factory")).toBeDisabled();
  });
});

describe("Settings → FX Rates dated entry", () => {
  it("sends the effective date and refuses a date after today", async () => {
    (global as any).fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { id: 5, currencyCode: "EUR", rateToUsd: "1.15390000", effectiveDate: "2026-03-26", source: "manual" },
      ],
    }));
    harness.apiRequest.mockResolvedValue({ json: async () => ({}) });
    renderWithProviders(<FxRatesCard />, owner);
    expect(await screen.findByTestId("row-fxrate-EUR")).toHaveTextContent("2026-03-26");
    fireEvent.change(screen.getByTestId("input-fxrate-currency"), { target: { value: "aud" } });
    fireEvent.change(screen.getByTestId("input-fxrate-rate"), { target: { value: "0.6912" } });
    fireEvent.change(screen.getByTestId("input-fxrate-date"), { target: { value: "2026-12-01" } });
    fireEvent.click(screen.getByTestId("button-add-fxrate"));
    expect(harness.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "A rate cannot be dated after today" })
    );
    expect(harness.apiRequest).not.toHaveBeenCalled();

    fireEvent.change(screen.getByTestId("input-fxrate-date"), { target: { value: "2026-03-26" } });
    fireEvent.click(screen.getByTestId("button-add-fxrate"));
    await waitFor(() =>
      expect(harness.apiRequest).toHaveBeenCalledWith("POST", "/api/factory/fx-rates", {
        currencyCode: "AUD",
        rateToUsd: "0.6912",
        effectiveDate: "2026-03-26",
      })
    );
    expect(screen.getByTestId("rate-import-factory")).toBeInTheDocument();
  });
});

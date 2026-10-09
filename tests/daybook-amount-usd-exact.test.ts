/**
 * daybookAmountUsd, used by every writeDaybookEntry copy, converts amount ×
 * rate exactly and keeps the cents amount_usd (numeric(20, 2)) stores. The
 * float product was written whole, so Postgres rounded the float:
 * 1.13 × 1.5 = 1.695 was written as 1.6949999999999998 and stored as 1.69.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../server/db", () => ({ db: {} }));

import { daybookAmountUsd } from "../server/lib/money";
import { writeDaybookEntry } from "../server/routes/factory/_helpers";

describe("daybook USD amounts", () => {
  it("converts at the exact product, rounded half away from zero", () => {
    expect(daybookAmountUsd("EUR", 1.13, 1.5, undefined)).toBe("1.70");
    expect(daybookAmountUsd("XOF", -1.13, 1.5, undefined)).toBe("-1.70");
    expect(daybookAmountUsd("XOF", 822.25, 0.0017, undefined)).toBe("1.40");
  });

  it("keeps the caller's USD amount and USD entries as given", () => {
    expect(daybookAmountUsd("EUR", 100, 1.08, 99.99)).toBe("99.99");
    expect(daybookAmountUsd("USD", 12.345, 1, undefined)).toBe("12.345");
  });

  it("does not turn a non-finite amount into zero", () => {
    expect(daybookAmountUsd("EUR", Number.NaN, 1.08, undefined)).toBe("NaN");
  });

  it("writes the exact USD amount from writeDaybookEntry", async () => {
    const rows: Array<Record<string, unknown>> = [];
    const tx = {
      insert: () => ({
        values: (row: Record<string, unknown>) => {
          rows.push(row);
          return { returning: async () => [{ id: 1 }] };
        },
      }),
    };
    await writeDaybookEntry(tx as never, {
      companyId: 7,
      txDate: "2026-01-01",
      txType: "FREIGHT",
      description: "Freight",
      currencyCode: "EUR",
      amountCurrency: 1.13,
      fxRateToUsd: 1.5,
    });
    expect(rows[0]).toMatchObject({ amountCurrency: "1.13", fxRateToUsd: "1.5", amountUsd: "1.70" });
  });
});

/**
 * Kwacha intercompany transfers: the stable retry voucher number and the
 * shared historical USD base for a USD/ZMW subsidiary and its parent. The
 * approved-rate policy is stubbed.
 */
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const rate = vi.hoisted(() => vi.fn());
vi.mock("../server/services/accounting/zambiaVoucherRatePolicy", () => ({
  assertApprovedZmwVoucherRate: (...a: unknown[]) => rate(...a),
}));

import {
  resolveZambiaIntercompanyAmount,
  zambiaTransferVoucherNumber,
} from "../server/services/accounting/zambiaIntercompanyTransfer";
import { TransferRouteError } from "../server/routes/transfers/transferErrors";

const parent = { id: 1, active: true, parentCompanyId: null, baseCurrency: "USD", displayCurrency: "USD" };
const zambia = { id: 2, active: true, parentCompanyId: 1, baseCurrency: "usd", displayCurrency: "zmw" };
const base = { fromCompany: parent, toCompany: zambia, transferDate: "2026-10-20" };

async function routeError(params: Parameters<typeof resolveZambiaIntercompanyAmount>[0]) {
  const error = await resolveZambiaIntercompanyAmount(params).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(TransferRouteError);
  return [(error as TransferRouteError).message, (error as TransferRouteError).statusCode];
}

beforeEach(() => {
  rate.mockReset().mockResolvedValue("26.5");
});

describe("zambiaTransferVoucherNumber", () => {
  it("derives the same number for the same request and refuses unsafe ids", () => {
    const digest = createHash("sha256").update("req-1").digest("hex").slice(0, 24);
    expect(zambiaTransferVoucherNumber("ICT", "req-1")).toBe(`ICT-ZMW-${digest}`);
    expect(zambiaTransferVoucherNumber("ICT", "req-1")).toBe(zambiaTransferVoucherNumber("ICT", "req-1"));
    expect(zambiaTransferVoucherNumber("ICT", "req-2")).not.toBe(zambiaTransferVoucherNumber("ICT", "req-1"));
    for (const id of ["", "has space", "x".repeat(129)]) {
      expect(() => zambiaTransferVoucherNumber("ICT", id)).toThrow(
        "ZMW intercompany transfer requires a clientRequestId for safe retries"
      );
    }
  });
});

describe("resolveZambiaIntercompanyAmount", () => {
  it("passes USD amounts through unchanged", async () => {
    await expect(resolveZambiaIntercompanyAmount({ ...base, amount: "125.5", currency: null })).resolves.toEqual({
      currency: "USD",
      baseAmount: "125.5",
      nativeAmount: "125.5",
      historicalRate: null,
      zambiaCompanyId: null,
    });
    await expect(
      resolveZambiaIntercompanyAmount({ ...base, amount: 10, currency: " usd ", exchangeRate: "" })
    ).resolves.toMatchObject({
      baseAmount: "10",
    });
    expect(await routeError({ ...base, amount: 10, currency: "USD", exchangeRate: "1" })).toEqual([
      "USD intercompany transfers must not supply a foreign exchange rate",
      400,
    ]);
    expect(rate).not.toHaveBeenCalled();
  });

  it("converts Kwacha at the approved rate in either direction", async () => {
    const expected = {
      currency: "ZMW",
      nativeAmount: "2650.00",
      baseAmount: "100.000000",
      historicalRate: "26.5",
      zambiaCompanyId: 2,
    };
    await expect(
      resolveZambiaIntercompanyAmount({ ...base, amount: "2650", currency: "zmw", exchangeRate: "26.5" })
    ).resolves.toEqual(expected);
    expect(rate).toHaveBeenCalledWith(2, "2026-10-20", "ZMW", "26.5");
    await expect(
      resolveZambiaIntercompanyAmount({
        fromCompany: zambia,
        toCompany: parent,
        transferDate: "2026-10-20",
        amount: 2650,
        currency: "ZMW",
        exchangeRate: 26.5,
      })
    ).resolves.toEqual(expected);
  });

  it("validates currency and amount", async () => {
    expect(await routeError({ ...base, amount: 1, currency: "EUR" })).toEqual([
      "Unsupported intercompany transfer currency",
      400,
    ]);
    expect(await routeError({ ...base, amount: "abc", currency: "USD" })).toEqual(["Transfer amount is invalid", 400]);
    for (const amount of ["0", "-5", "Infinity"]) {
      expect(await routeError({ ...base, amount, currency: "USD" })).toEqual(["Transfer amount must be positive", 400]);
    }
    expect(await routeError({ ...base, amount: "1.234", currency: "ZMW" })).toEqual([
      "Kwacha amount must have at most two decimal places",
      400,
    ]);
    expect(await routeError({ ...base, amount: "0.13", currency: "ZMW", exchangeRate: "26.5" })).toEqual([
      "Kwacha amount converts to less than half a USD cent",
      400,
    ]);
  });

  it("needs exactly one active Zambia company whose parent is the other side", async () => {
    const message = "Kwacha intercompany transfers require a USD/ZMW subsidiary and its linked parent company";
    for (const [fromCompany, toCompany] of [
      [parent, { ...parent, id: 3 }],
      [zambia, { ...zambia, id: 3, parentCompanyId: 1 }],
      [{ ...parent, active: false }, zambia],
      [parent, { ...zambia, active: false }],
      [{ ...parent, id: 9 }, zambia],
      [parent, { ...zambia, baseCurrency: "EUR" }],
      // Both sides look like Zambia companies, even when one is the other's parent.
      [
        { ...zambia, parentCompanyId: 3 },
        { ...zambia, id: 3, parentCompanyId: null },
      ],
    ]) {
      expect(
        await routeError({ fromCompany, toCompany, transferDate: "2026-10-20", amount: "100", currency: "ZMW" })
      ).toEqual([message, 409]);
    }
  });

  it("reports a rate the policy refuses or does not return", async () => {
    rate.mockRejectedValueOnce(new Error("differs"));
    expect(await routeError({ ...base, amount: "100", currency: "ZMW", exchangeRate: "27" })).toEqual([
      "An approved USD/ZMW exchange rate matching the transfer date and supplied rate is required",
      409,
    ]);
    rate.mockResolvedValueOnce(null);
    expect(await routeError({ ...base, amount: "100", currency: "ZMW" })).toEqual([
      "Historical USD/ZMW exchange rate is missing",
      409,
    ]);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  execute: vi.fn(),
}));
vi.mock("../server/db", () => ({ db: { execute: harness.execute } }));
import { loadNetPositionFxActivity } from "../server/services/accounting/netPositionFxActivity";

const event = (fields: Record<string, unknown> = {}) => ({
  id: 1,
  date: "2026-11-10",
  recorded_at: "2026-11-10 09:00:00",
  reference: "Voucher-10",
  description: "EUR payment",
  currency: "EUR",
  native_amount: "-100.00",
  usd_amount: "-112.00",
  rate: "1.12",
  voucher_id: 810,
  source_key: "ledger:15",
  ...fields,
});

describe("Net Position FX activity history (read-only evidence)", () => {
  beforeEach(() => harness.execute.mockReset());

  it("returns dated voucher links and rate changes for the selected ERP company", async () => {
    harness.execute
      .mockResolvedValueOnce({ rows: [event()] })
      .mockResolvedValueOnce({ rows: [event({
        id: 3, date: "2026-11-11", reference: "EUR → USD",
        description: "Saved accounting FX rate", currency: "EUR",
        native_amount: null, usd_amount: null, rate: "1.12",
        voucher_id: null, source_key: null,
      })] });
    const result = await loadNetPositionFxActivity({ companyId: 17, factory: false });
    expect(result.companyId).toBe(17);
    expect(result.entries).toHaveLength(2);
    expect(result.entries.map((entry) => entry.kind)).toEqual(["rate", "voucher"]);
    expect(result.entries[1]).toMatchObject({
      date: "2026-11-10", voucherId: 810, sourceKey: "ledger:15",
      currency: "EUR", nativeAmount: "-100.00",
    });
    expect(result.notes.join(" ")).toContain("not a posted voucher");
    expect(harness.execute).toHaveBeenCalledTimes(2);
  });

  it("merges Factory voucher, configured FX rates, containers, payments and transfers without posting", async () => {
    harness.execute
      .mockResolvedValueOnce({ rows: [event()] })
      .mockResolvedValueOnce({ rows: [event({ id: 2, voucher_id: null, source_key: null })] })
      .mockResolvedValueOnce({ rows: [event({ id: 3, reference: "CONTAINER-EUR", voucher_id: null, source_key: "supplier:22" })] })
      .mockResolvedValueOnce({ rows: [event({ id: 4, reference: "Supplier payment #4", voucher_id: null, source_key: "supplier:22" })] })
      .mockResolvedValueOnce({ rows: [event({ id: 5, reference: "Supplier FX transfer #5", voucher_id: null, source_key: "supplier:22" })] });
    const result = await loadNetPositionFxActivity({ companyId: 22, factory: true });
    expect(result.entries).toHaveLength(5);
    expect(result.entries.map((entry) => entry.kind).sort()).toEqual(
      ["container", "rate", "supplier_payment", "supplier_transfer", "voucher"]
    );
    expect(result.entries.filter((entry) => entry.sourceKey === "supplier:22")).toHaveLength(3);
    expect(harness.execute).toHaveBeenCalledTimes(5);
  });

  it("rejects invalid or inverted filter dates without querying the database", async () => {
    await expect(loadNetPositionFxActivity({ companyId: 1, factory: false, from: "2026-99-35" }))
      .rejects.toThrow("Invalid history date");
    await expect(loadNetPositionFxActivity({
      companyId: 1, factory: true, from: "2026-11-11", to: "2026-11-01",
    })).rejects.toThrow("start date must be on or before");
    expect(harness.execute).not.toHaveBeenCalled();
  });

  it("marks an excessive history read as truncated rather than hiding omitted rows", async () => {
    const many = Array.from({ length: 201 }, (_, index) => event({ id: index + 1 }));
    harness.execute.mockResolvedValueOnce({ rows: many }).mockResolvedValueOnce({ rows: [] });
    const result = await loadNetPositionFxActivity({ companyId: 1, factory: false });
    expect(result.truncated).toBe(true);
    expect(result.entries).toHaveLength(200);
  });
});

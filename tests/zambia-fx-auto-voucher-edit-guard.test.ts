import { describe, expect, it, vi } from "vitest";
import { isAutomaticFxRevaluationVoucherTx } from "../server/services/accounting/automaticFxVoucherGuard";

describe("automatic FX revaluation voucher editing guard", () => {
  it("recognizes the engine posting identity and blocks ordinary editors", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [{ id: 1 }] });
    await expect(isAutomaticFxRevaluationVoucherTx({ execute } as any, 19, 18134))
      .resolves.toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    const rendered = execute.mock.calls[0][0];
    expect(JSON.stringify(rendered)).toContain("fx-unrealized-revaluation");
  });

  it("does not block ordinary manual journal vouchers by description or number", async () => {
    const execute = vi.fn().mockResolvedValue({ rows: [] });
    await expect(isAutomaticFxRevaluationVoucherTx({ execute } as any, 19, 18113))
      .resolves.toBe(false);
  });

  it("fails closed on missing tenant identity", async () => {
    const execute = vi.fn();
    await expect(isAutomaticFxRevaluationVoucherTx({ execute } as any, 0, 18134))
      .rejects.toThrow(/positive company/);
    expect(execute).not.toHaveBeenCalled();
  });

  it("propagates database read failures rather than allowing the edit", async () => {
    const execute = vi.fn().mockRejectedValue(new Error("RLS denied"));
    await expect(isAutomaticFxRevaluationVoucherTx({ execute } as any, 19, 18134))
      .rejects.toThrow("RLS denied");
  });
});

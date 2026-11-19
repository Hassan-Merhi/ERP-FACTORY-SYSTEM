/**
 * Shared-charge allocation preview and its input validators against the real
 * schema: role/company refusals, malformed trade lists and amounts, foreign or
 * inactive trades, received containers, editor grants, and the
 * purchase-weighted suggestion (which writes nothing).
 */
import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";
import {
  assertInvoiceInput,
  hasSharedChargeGrant,
  previewSharedChargeAllocation,
  requireInputs,
  validateAllocations,
  type ConfirmSharedChargeInput,
} from "../server/services/intercompany/previewSharedChargeAllocation";

const world = <T>(work: (w: IntercompanyTradeWorld) => Promise<T>) =>
  withRolledBackPool(async (client) => work(await createIntercompanyTradeWorld(client)));

async function versions(w: IntercompanyTradeWorld) {
  return w.q<{ id: number; version: number }>(
    `SELECT id, version FROM intercompany_trades WHERE source_company_id = $1 ORDER BY id`,
    [w.sourceCompanyId]
  );
}

describe("previewSharedChargeAllocation", () => {
  it("suggests a purchase-weighted cent-exact split without writing anything", () =>
    world(async (w) => {
      const a = await w.trade("A");
      const b = await w.trade("B");
      const before = await versions(w);
      const preview = await previewSharedChargeAllocation(
        { sourceCompanyId: w.sourceCompanyId, tradeIds: [a.tradeId, b.tradeId], amount: "40.01" },
        w.identity()
      );
      expect(preview).toEqual({
        faceAmount: "40.01",
        allocations: [
          { tradeId: a.tradeId, containerNumber: `${w.tag}A`, expectedVersion: 1, suggestedAmount: expect.any(String) },
          { tradeId: b.tradeId, containerNumber: `${w.tag}B`, expectedVersion: 1, suggestedAmount: expect.any(String) },
        ],
      });
      const shares = preview.allocations.map((x) => x.suggestedAmount).sort();
      expect(shares).toEqual(["20.00", "20.01"]);
      expect(await versions(w)).toEqual(before);
    }));

  it("refuses non-owner roles and other initiating companies", () =>
    world(async (w) => {
      const a = await w.trade("A");
      const input = { sourceCompanyId: w.sourceCompanyId, tradeIds: [a.tradeId], amount: "10" };
      await expect(previewSharedChargeAllocation(input, w.identity(w.sourceCompanyId, "Admin"))).rejects.toMatchObject({
        code: "IC_CHARGE_FORBIDDEN",
        status: 403,
      });
      await expect(
        previewSharedChargeAllocation(input, w.identity(w.destinationCompanyId, "Owner"))
      ).rejects.toMatchObject({ code: "IC_CHARGE_FORBIDDEN" });
    }));

  it("refuses malformed trade lists and amounts", () =>
    world(async (w) => {
      const a = await w.trade("A");
      const bad: Array<{ tradeIds: number[]; amount: string }> = [
        { tradeIds: [], amount: "10" },
        { tradeIds: [a.tradeId, a.tradeId], amount: "10" },
        { tradeIds: Array.from({ length: 101 }, (_, i) => i + 1), amount: "10" },
        { tradeIds: [a.tradeId], amount: "10.001" },
        { tradeIds: "x" as unknown as number[], amount: "10" },
      ];
      for (const input of bad) {
        await expect(
          previewSharedChargeAllocation({ sourceCompanyId: w.sourceCompanyId, ...input }, w.identity())
        ).rejects.toMatchObject({ code: "IC_CHARGE_INPUT", status: 422 });
      }
      await expect(
        previewSharedChargeAllocation(
          { sourceCompanyId: w.sourceCompanyId, tradeIds: [a.tradeId], amount: "0.00" },
          w.identity()
        )
      ).rejects.toMatchObject({ code: "IC_EDIT_UNSAFE", status: 409 });
    }));

  it("refuses missing, inactive or foreign trades and received containers", () =>
    world(async (w) => {
      const a = await w.trade("A");
      const b = await w.trade("B");
      const run = (tradeIds: number[]) =>
        previewSharedChargeAllocation({ sourceCompanyId: w.sourceCompanyId, tradeIds, amount: "10" }, w.identity());
      await expect(run([a.tradeId, 2_000_000_000])).rejects.toThrow(/active and belong to one Properties source/);
      const canceled = await w.one(
        `INSERT INTO intercompany_trades (relationship_id, physical_container_id, source_company_id, destination_company_id, state)
         VALUES ($1, $2, $3, $4, 'canceled') RETURNING id`,
        [w.relationshipId, b.containerId, w.sourceCompanyId, w.destinationCompanyId]
      );
      await expect(run([a.tradeId, canceled])).rejects.toMatchObject({ code: "IC_EDIT_UNSAFE" });
      await expect(
        previewSharedChargeAllocation(
          { sourceCompanyId: w.destinationCompanyId, tradeIds: [a.tradeId], amount: "10" },
          w.identity(w.destinationCompanyId)
        )
      ).rejects.toMatchObject({ code: "IC_EDIT_UNSAFE" });
      await w.q(`UPDATE containers SET status = 'Arrived' WHERE id = $1`, [a.containerId]);
      await expect(run([a.tradeId])).rejects.toMatchObject({ code: "IC_EDIT_INVENTORY_DEPENDENCY" });
    }));
});

describe("shared charge input validation", () => {
  const base: ConfirmSharedChargeInput = {
    sourceCompanyId: 5,
    invoiceKey: "INV-2026/001",
    chargeType: "freight",
    faceAmount: "100.00",
    evidenceReference: "BL 123",
    postingDate: "2026-06-10",
    requestKey: "request-key-001",
    reason: "Freight invoice",
    allocations: [],
  };

  it("accepts a valid invoice and refuses each invalid field", () => {
    expect(assertInvoiceInput(base).toFixed(2)).toBe("100.00");
    const invalid: Array<Partial<ConfirmSharedChargeInput>> = [
      { sourceCompanyId: 0 },
      { invoiceKey: "x" },
      { chargeType: "duty" as never },
      { evidenceReference: "  " },
      { evidenceReference: "ab" },
      { evidenceReference: "e".repeat(501) },
      { faceAmount: "1.234" },
    ];
    for (const patch of invalid) {
      expect(() => assertInvoiceInput({ ...base, ...patch })).toThrowError(
        expect.objectContaining({ code: "IC_CHARGE_INVALID" })
      );
    }
    expect(() => assertInvoiceInput({ ...base, faceAmount: "0" })).toThrowError(/must be positive/);
  });

  it("requires a meaningful reason and a valid request key", () => {
    expect(() => requireInputs({ ...base, reason: "no" })).toThrowError(
      expect.objectContaining({ code: "IC_CHARGE_REASON" })
    );
    expect(() => requireInputs({ ...base, reason: "r".repeat(1001) })).toThrowError(
      expect.objectContaining({ code: "IC_CHARGE_REASON" })
    );
    expect(() => requireInputs({ ...base, requestKey: "bad" })).toThrowError(
      expect.objectContaining({ code: "IC_EDIT_KEY" })
    );
  });

  it("validates allocation lists against the face amount", () => {
    const face = new Decimal("30");
    const entry = (tradeId: number, amount: string, expectedVersion = 1) => ({ tradeId, amount, expectedVersion });
    expect(validateAllocations([entry(1, "10"), entry(2, "20.00")], face).map((v) => v.toFixed(2))).toEqual([
      "10.00",
      "20.00",
    ]);
    const code = (list: unknown) => {
      try {
        validateAllocations(list as never, face);
        return "ok";
      } catch (error) {
        return (error as { code: string }).code;
      }
    };
    expect(code([])).toBe("IC_CHARGE_ALLOCATION");
    expect(code(null)).toBe("IC_CHARGE_ALLOCATION");
    expect(code([entry(1, "10"), entry(1, "20")])).toBe("IC_CHARGE_DUPLICATE");
    expect(code([entry(0, "30")])).toBe("IC_CHARGE_ALLOCATION");
    expect(code([entry(1, "30", 0)])).toBe("IC_CHARGE_ALLOCATION");
    expect(code([entry(1, "-30")])).toBe("IC_CHARGE_ALLOCATION");
    expect(code([entry(1, "29.99")])).toBe("IC_CHARGE_TOTAL_MISMATCH");
  });
});

describe("hasSharedChargeGrant", () => {
  it("lets source owners through and checks grants for everyone else", () =>
    world(async (w) => {
      const rel = [w.relationshipId];
      expect(await hasSharedChargeGrant(w.identity(), "INV-1", rel, w.sourceCompanyId)).toBe(true);
      const clerk = await w.otherUser([[w.sourceCompanyId, "Accountant"]]);
      const id = w.identity(w.sourceCompanyId, "Accountant", clerk);
      expect(await hasSharedChargeGrant(id, "INV-1", rel, w.sourceCompanyId)).toBe(false);

      const stranger = await w.otherUser([]);
      expect(await hasSharedChargeGrant(w.identity(w.sourceCompanyId, "Accountant", stranger), "INV-1", rel, 0)).toBe(
        false
      );

      const grant = (scope: string, invoiceKey: string | null) =>
        w.q(
          `INSERT INTO intercompany_permission_grants (user_id, granting_company_id, relationship_id, scope, invoice_key, granted_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [clerk, w.sourceCompanyId, w.relationshipId, scope, invoiceKey, w.userId]
        );
      await grant("invoice", "INV-1");
      expect(await hasSharedChargeGrant(id, "INV-1", rel, w.sourceCompanyId)).toBe(true);
      expect(await hasSharedChargeGrant(id, "INV-2", rel, w.sourceCompanyId)).toBe(false);
      await grant("relationship", null);
      expect(await hasSharedChargeGrant(id, "INV-2", rel, w.sourceCompanyId)).toBe(true);
    }));
});

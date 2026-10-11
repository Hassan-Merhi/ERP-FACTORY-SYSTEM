import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 22 (C): the SP offload journals post through the factory door
// (postFactoryPartyLineVoucherTx for the OTW reversal, whose clearing lines
// carry a supplier party; postFactoryVoucherTx -> the engine for the rest).
// This unit suite pins what is posted (accounts, sides, exact amounts, the
// reconciliation and the fail-closed checks) at that door; the door itself is
// covered by tests/phase22c-factory-writers-engine.test.ts against a database.
const harness = vi.hoisted(() => {
  const state = {
    selectQueue: [] as Array<Array<Record<string, unknown>>>,
  };
  const postFactoryPartyLineVoucherTx = vi.fn(async () => ({ voucherId: 100, replayed: false }));
  const postFactoryVoucherTx = vi.fn(async () => ({ voucher: { id: 101 }, entries: [], replayed: false }));
  return { state, postFactoryPartyLineVoucherTx, postFactoryVoucherTx };
});

vi.mock("../server/services/factory/factoryVoucherPosting", () => ({
  postFactoryPartyLineVoucherTx: harness.postFactoryPartyLineVoucherTx,
  postFactoryVoucherTx: harness.postFactoryVoucherTx,
}));

import { postSupplierPartnerJournals } from "../server/services/containers/offload-lifecycle/sp-journals";

type PostedLine = {
  ledgerAccountId: number;
  supplierId?: number | null;
  debit?: { toFixed(dp?: number): string };
  credit?: { toFixed(dp?: number): string };
  narration?: string;
};
type PostedInput = {
  companyId: number;
  voucherNumber: (generation: number) => string;
  source: { sourceType: string; sourceId: string; phase: string };
  lines: PostedLine[];
};

function posted(mock: { mock: { calls: unknown[][] } }, index: number): PostedInput {
  return mock.mock.calls[index]?.[1] as PostedInput;
}

function money(line: PostedLine) {
  return { debit: line.debit?.toFixed(2) ?? "0.00", credit: line.credit?.toFixed(2) ?? "0.00" };
}

function account(id: number, companyId: number, subType: string) {
  return { id, companyId, subType };
}

function makeTx() {
  const tx: any = {};
  tx.select = vi.fn(() => {
    const builder: any = {};
    builder.from = vi.fn(() => builder);
    builder.where = vi.fn(() => builder);
    builder.limit = vi.fn(async () => harness.state.selectQueue.shift() ?? []);
    return builder;
  });
  return tx;
}

function container(overrides: Record<string, unknown> = {}) {
  return {
    id: 7001,
    companyId: 7,
    grandTotal: "100.00",
    ...overrides,
  } as any;
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    companyId: 7,
    containerId: 7001,
    mode: "create-or-replace",
    locationId: 3,
    offloadDate: "2026-09-17",
    duties: "0",
    officeCharges: "0",
    transferCharges: "0",
    transportFees: "0",
    agentChargeLines: [],
    ...overrides,
  } as any;
}

function po(overrides: Record<string, unknown> = {}) {
  return {
    supplierId: 44,
    itemsTotal: "100.00",
    freight: "0",
    otherCharges: "0",
    surcharge: "0",
    fumigation: "0",
    documentCharges: "0",
    discount: "0",
    ...overrides,
  } as any;
}

function queueBaseAccounts(parentCompanyId: number | null = 1) {
  harness.state.selectQueue.push(
    [{ companyType: "supplier_partner", parentCompanyId }],
    [account(11, 7, "sp_goods_otw")],
    [account(12, 7, "sp_otw_clearing")],
    [account(13, 7, "sp_stock")],
    [account(14, 7, "sp_cost_clearing")]
  );
}

describe("Phase 33E Supplier Partner intercompany offload journals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    harness.state.selectQueue = [];
  });

  it("does nothing for a non-Supplier Partner company", async () => {
    harness.state.selectQueue.push([{ companyType: "erp", parentCompanyId: null }]);

    await expect(postSupplierPartnerJournals(makeTx(), container(), [po()], input())).resolves.toBeUndefined();

    expect(harness.postFactoryPartyLineVoucherTx).not.toHaveBeenCalled();
    expect(harness.postFactoryVoucherTx).not.toHaveBeenCalled();
  });

  it("fails closed when the base SP accounting accounts are incomplete", async () => {
    harness.state.selectQueue.push(
      [{ companyType: "supplier_partner", parentCompanyId: 1 }],
      [account(11, 7, "sp_goods_otw")],
      [],
      [account(13, 7, "sp_stock")],
      [account(14, 7, "sp_cost_clearing")]
    );

    await expect(postSupplierPartnerJournals(makeTx(), container(), [po()], input())).rejects.toMatchObject({
      status: 400,
      code: "CONTAINER_OFFLOAD_SP_ACCOUNTS_MISSING",
    });
    expect(harness.postFactoryPartyLineVoucherTx).not.toHaveBeenCalled();
    expect(harness.postFactoryVoucherTx).not.toHaveBeenCalled();
  });

  it("fails closed when parent-agent intercompany accounts are incomplete", async () => {
    queueBaseAccounts(9);
    harness.state.selectQueue.push(
      [],
      [account(21, 7, "sp_hadi_intercompany")],
      [account(22, 7, "sp_prepaid_expenses")]
    );

    await expect(
      postSupplierPartnerJournals(
        makeTx(),
        container({ grandTotal: "0" }),
        [],
        input({ agentChargeLines: [{ amountUsd: 25, parentAgentAccountId: 80 }] })
      )
    ).rejects.toMatchObject({
      status: 400,
      code: "CONTAINER_OFFLOAD_SP_AGENT_ACCOUNTS_MISSING",
    });
    expect(harness.postFactoryPartyLineVoucherTx).not.toHaveBeenCalled();
    expect(harness.postFactoryVoucherTx).not.toHaveBeenCalled();
  });

  it("creates no voucher when both OTW and valid agent amounts are zero", async () => {
    queueBaseAccounts();

    await postSupplierPartnerJournals(
      makeTx(),
      container({ grandTotal: "0" }),
      [],
      input({
        agentChargeLines: [
          { amountUsd: 0, parentAgentAccountId: 80 },
          { amountUsd: -5, parentAgentAccountId: 81 },
        ],
      })
    );

    expect(harness.postFactoryPartyLineVoucherTx).not.toHaveBeenCalled();
    expect(harness.postFactoryVoucherTx).not.toHaveBeenCalled();
  });

  it("uses a single unsupplied clearing line when OTW has no positive PO allocation", async () => {
    queueBaseAccounts();

    await postSupplierPartnerJournals(makeTx(), container(), [], input());

    expect(harness.postFactoryPartyLineVoucherTx).toHaveBeenCalledTimes(1);
    expect(harness.postFactoryVoucherTx).toHaveBeenCalledTimes(1);

    const reversal = posted(harness.postFactoryPartyLineVoucherTx, 0);
    expect(reversal.companyId).toBe(7);
    expect(reversal.voucherNumber(1)).toBe("SP-OTW-REV-ERP-7001-1");
    expect(reversal.source).toEqual({
      sourceType: "sp-container-offload",
      sourceId: "7:7001",
      phase: "otw-reversal",
    });
    expect(
      reversal.lines.map((line) => ({
        account: line.ledgerAccountId,
        supplierId: line.supplierId ?? null,
        ...money(line),
      }))
    ).toEqual([
      { account: 12, supplierId: null, debit: "100.00", credit: "0.00" },
      { account: 11, supplierId: null, debit: "0.00", credit: "100.00" },
    ]);
    expect(reversal.lines[0]?.narration).toBe("OTW Clearing reversal — ERP container #7001");

    const stock = posted(harness.postFactoryVoucherTx, 0);
    expect(stock.voucherNumber(1)).toBe("SP-STOCK-ERP-7001-1");
    expect(stock.source.phase).toBe("stock-recognition");
    expect(stock.lines.map((line) => ({ account: line.ledgerAccountId, ...money(line) }))).toEqual([
      { account: 13, debit: "100.00", credit: "0.00" },
      { account: 14, debit: "0.00", credit: "100.00" },
    ]);
  });

  it("reconciles the final supplier clearing line to the exact container OTW total", async () => {
    queueBaseAccounts();

    await postSupplierPartnerJournals(
      makeTx(),
      container({ grandTotal: "100" }),
      [po({ supplierId: 1, itemsTotal: "60" }), po({ supplierId: 2, itemsTotal: "30" })],
      input()
    );

    const reversal = posted(harness.postFactoryPartyLineVoucherTx, 0);
    expect(reversal.lines.slice(0, 2).map((line) => ({ supplierId: line.supplierId, ...money(line) }))).toEqual([
      { supplierId: 1, debit: "60.00", credit: "0.00" },
      { supplierId: 2, debit: "40.00", credit: "0.00" },
    ]);
    expect(money(reversal.lines[2] as PostedLine)).toEqual({ debit: "0.00", credit: "100.00" });
  });

  it("rejects a PO allocation whose final reconciliation would become non-positive", async () => {
    queueBaseAccounts();

    await expect(
      postSupplierPartnerJournals(
        makeTx(),
        container({ grandTotal: "100" }),
        [po({ supplierId: 1, itemsTotal: "150" }), po({ supplierId: 2, itemsTotal: "20" })],
        input()
      )
    ).rejects.toMatchObject({
      status: 409,
      code: "CONTAINER_OFFLOAD_SP_OTW_MISMATCH",
    });

    // The lines are built before anything is posted, so nothing reaches the ledger.
    expect(harness.postFactoryPartyLineVoucherTx).not.toHaveBeenCalled();
    expect(harness.postFactoryVoucherTx).not.toHaveBeenCalled();
  });

  it("filters invalid agent lines and posts equal child/parent intercompany totals", async () => {
    queueBaseAccounts(null);
    harness.state.selectQueue.push(
      [account(31, 1, "hadi_sp_intercompany")],
      [account(32, 7, "sp_hadi_intercompany")],
      [account(33, 7, "sp_prepaid_expenses")]
    );

    await postSupplierPartnerJournals(
      makeTx(),
      container({ grandTotal: "0" }),
      [],
      input({
        agentChargeLines: [
          { amountUsd: 0, parentAgentAccountId: 80, description: "ignored" },
          { amountUsd: -2, parentAgentAccountId: 81, description: "ignored" },
          { amountUsd: 25, parentAgentAccountId: 82, description: "Freight agent" },
          { amountUsd: 10, parentAgentAccountId: 83 },
        ],
      })
    );

    expect(harness.postFactoryPartyLineVoucherTx).not.toHaveBeenCalled();
    expect(harness.postFactoryVoucherTx).toHaveBeenCalledTimes(2);

    const child = posted(harness.postFactoryVoucherTx, 0);
    expect(child.companyId).toBe(7);
    expect(child.voucherNumber(1)).toBe("SP-AGENT-SETTLE-7001-1");
    expect(child.lines.map((line) => ({ account: line.ledgerAccountId, ...money(line) }))).toEqual([
      { account: 32, debit: "35.00", credit: "0.00" },
      { account: 33, debit: "0.00", credit: "35.00" },
    ]);

    const parent = posted(harness.postFactoryVoucherTx, 1);
    expect(parent.companyId).toBe(1);
    expect(parent.voucherNumber(1)).toBe("SP-AGENT-ERP-7001-1");
    expect(parent.lines.map((line) => ({ account: line.ledgerAccountId, ...money(line) }))).toEqual([
      { account: 31, debit: "35.00", credit: "0.00" },
      { account: 82, debit: "0.00", credit: "25.00" },
      { account: 83, debit: "0.00", credit: "10.00" },
    ]);
    expect(parent.lines[1]?.narration).toBe("Agent credit for ERP container #7001 — Freight agent");
  });
});

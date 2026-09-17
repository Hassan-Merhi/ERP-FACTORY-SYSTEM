import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => {
  const state = {
    selectQueue: [] as Array<Array<Record<string, unknown>>>,
    inserts: [] as Array<{ table: unknown; values: unknown }>,
    nextVoucherId: 100,
  };

  const insertInfrastructureVoucherTx = vi.fn(async () => ({
    voucher: { id: state.nextVoucherId++ },
  }));
  const infrastructurePostingIdentity = vi.fn((sourceType: string, sourceId: string, slot: string) => ({
    sourceType,
    sourceId,
    slot,
  }));

  return { state, insertInfrastructureVoucherTx, infrastructurePostingIdentity };
});

vi.mock("../server/services/accounting/infrastructureVoucherIdentity", () => ({
  insertInfrastructureVoucherTx: harness.insertInfrastructureVoucherTx,
  infrastructurePostingIdentity: harness.infrastructurePostingIdentity,
}));

import { postSupplierPartnerJournals } from "../server/services/containers/offload-lifecycle/sp-journals";

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
  tx.insert = vi.fn((table: unknown) => ({
    values: vi.fn(async (values: unknown) => {
      harness.state.inserts.push({ table, values });
      return [];
    }),
  }));
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
    harness.state.inserts = [];
    harness.state.nextVoucherId = 100;
  });

  it("does nothing for a non-Supplier Partner company", async () => {
    harness.state.selectQueue.push([{ companyType: "erp", parentCompanyId: null }]);
    const tx = makeTx();

    await expect(postSupplierPartnerJournals(tx, container(), [po()], input())).resolves.toBeUndefined();

    expect(harness.insertInfrastructureVoucherTx).not.toHaveBeenCalled();
    expect(harness.state.inserts).toHaveLength(0);
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
    expect(harness.insertInfrastructureVoucherTx).not.toHaveBeenCalled();
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
    expect(harness.insertInfrastructureVoucherTx).not.toHaveBeenCalled();
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

    expect(harness.insertInfrastructureVoucherTx).not.toHaveBeenCalled();
    expect(harness.state.inserts).toHaveLength(0);
  });

  it("uses a single unsupplied clearing line when OTW has no positive PO allocation", async () => {
    queueBaseAccounts();

    await postSupplierPartnerJournals(makeTx(), container(), [], input());

    expect(harness.insertInfrastructureVoucherTx).toHaveBeenCalledTimes(2);
    expect(harness.state.inserts).toHaveLength(3);
    expect(harness.state.inserts[0]?.values).toEqual({
      voucherId: 100,
      ledgerAccountId: 12,
      supplierId: null,
      debitAmount: "100",
      creditAmount: "0",
      narration: "OTW Clearing reversal — ERP container #7001",
    });
    expect(harness.state.inserts[1]?.values).toMatchObject({
      voucherId: 100,
      ledgerAccountId: 11,
      debitAmount: "0",
      creditAmount: "100.00",
    });
    expect(harness.state.inserts[2]?.values).toEqual([
      expect.objectContaining({ voucherId: 101, ledgerAccountId: 13, debitAmount: "100.00", creditAmount: "0" }),
      expect.objectContaining({ voucherId: 101, ledgerAccountId: 14, debitAmount: "0", creditAmount: "100.00" }),
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

    const supplierClearing = harness.state.inserts
      .slice(0, 2)
      .map((entry) => entry.values as Record<string, unknown>);
    expect(supplierClearing).toEqual([
      expect.objectContaining({ supplierId: 1, debitAmount: "60.00", creditAmount: "0" }),
      expect.objectContaining({ supplierId: 2, debitAmount: "40.00", creditAmount: "0" }),
    ]);
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

    expect(harness.insertInfrastructureVoucherTx).toHaveBeenCalledTimes(1);
    expect(harness.state.inserts).toHaveLength(1);
    expect(harness.state.inserts[0]?.values).toMatchObject({ supplierId: 1, debitAmount: "150.00" });
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

    expect(harness.insertInfrastructureVoucherTx).toHaveBeenCalledTimes(2);
    expect(harness.insertInfrastructureVoucherTx.mock.calls[0]?.[1]).toMatchObject({
      companyId: 7,
      totalAmount: "35.00",
    });
    expect(harness.insertInfrastructureVoucherTx.mock.calls[1]?.[1]).toMatchObject({
      companyId: 1,
      totalAmount: "35.00",
    });

    expect(harness.state.inserts[0]?.values).toEqual([
      expect.objectContaining({ voucherId: 100, ledgerAccountId: 32, debitAmount: "35.00", creditAmount: "0" }),
      expect.objectContaining({ voucherId: 100, ledgerAccountId: 33, debitAmount: "0", creditAmount: "35.00" }),
    ]);
    expect(harness.state.inserts[1]?.values).toMatchObject({
      voucherId: 101,
      ledgerAccountId: 31,
      debitAmount: "35.00",
      creditAmount: "0",
    });
    expect(harness.state.inserts[2]?.values).toMatchObject({
      voucherId: 101,
      ledgerAccountId: 82,
      debitAmount: "0",
      creditAmount: "25.00",
    });
    expect(harness.state.inserts[3]?.values).toMatchObject({
      voucherId: 101,
      ledgerAccountId: 83,
      debitAmount: "0",
      creditAmount: "10.00",
    });
  });
});

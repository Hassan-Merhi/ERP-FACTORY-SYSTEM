import { describe, expect, it } from "vitest";

import {
  GoldenCoastPhase13IntercompanyError,
  goldenCoastPhase13IntercompanyDefinitions,
  planGoldenCoastPhase13IntercompanyAccount,
  summarizeGoldenCoastPhase13IntercompanyAccount,
  type GoldenCoastPhase13LedgerRow,
} from "./goldenCoastIntercompany";

const defs = goldenCoastPhase13IntercompanyDefinitions({
  goldenCoastCompanyName: "Golden Coast",
  hadiCompanyName: "HADI L'SHI",
});

function row(overrides: Partial<GoldenCoastPhase13LedgerRow> = {}): GoldenCoastPhase13LedgerRow {
  return {
    id: 10,
    companyId: 7,
    code: "SP-HADI-IC",
    name: "HADI L'SHI — Intercompany",
    accountType: "Intercompany",
    subType: "sp_hadi_intercompany",
    isHidden: false,
    active: true,
    deletedAt: null,
    ...overrides,
  };
}

describe("Golden Coast Phase 13 HADI intercompany account planner", () => {
  it("defines stable subtypes on both company sides", () => {
    expect(defs.golden_coast_hadi).toEqual({
      role: "golden_coast_hadi",
      subType: "sp_hadi_intercompany",
      code: "SP-HADI-IC",
      name: "HADI L'SHI — Intercompany",
      accountType: "Intercompany",
      isHidden: false,
    });
    expect(defs.hadi_golden_coast.subType).toBe("hadi_sp_intercompany");
    expect(defs.hadi_golden_coast.name).toBe("Golden Coast — Intercompany");
  });

  it("creates a missing Golden Coast-side intercompany account", () => {
    const plan = planGoldenCoastPhase13IntercompanyAccount({
      companyId: 7,
      definition: defs.golden_coast_hadi,
      accounts: [],
    });
    expect(plan.action).toBe("create");
    expect(plan.accountId).toBeNull();
  });

  it("is idempotent when the canonical account is already healthy", () => {
    const plan = planGoldenCoastPhase13IntercompanyAccount({
      companyId: 7,
      definition: defs.golden_coast_hadi,
      accounts: [row()],
    });
    expect(plan.action).toBe("none");
    expect(plan.accountId).toBe(10);
    expect(plan.repairs).toEqual([]);
  });

  it("repairs wrong type, hidden, inactive and soft-deleted state in place", () => {
    const broken = row({ accountType: "Liability", isHidden: true, active: false, deletedAt: "2026-08-01" });
    const plan = planGoldenCoastPhase13IntercompanyAccount({
      companyId: 7,
      definition: defs.golden_coast_hadi,
      accounts: [broken],
    });
    expect(plan.action).toBe("repair");
    expect(plan.accountId).toBe(10);
    expect(plan.repairs.map((repair) => repair.field)).toEqual(["accountType", "isHidden", "active", "deletedAt"]);
  });

  it("prefers a live legacy account over a soft-deleted canonical duplicate", () => {
    const deletedCanonical = row({ id: 10, active: false, deletedAt: "2026-08-01" });
    const liveLegacy = row({ id: 11, subType: null, active: true, deletedAt: null });
    const plan = planGoldenCoastPhase13IntercompanyAccount({
      companyId: 7,
      definition: defs.golden_coast_hadi,
      accounts: [deletedCanonical, liveLegacy],
    });

    expect(plan.action).toBe("adopt");
    expect(plan.accountId).toBe(11);
    expect(plan.repairs).toContainEqual({ field: "subType", from: null, to: "sp_hadi_intercompany" });
    expect(plan.repairs.some((repair) => repair.field === "deletedAt")).toBe(false);
  });

  it("provisions the HADI-side reciprocal account with the same repair rules", () => {
    const hadiRow = row({
      id: 20,
      companyId: 1,
      code: "SP-IC",
      name: "Golden Coast — Intercompany",
      subType: "hadi_sp_intercompany",
      accountType: "Liability",
    });
    const plan = planGoldenCoastPhase13IntercompanyAccount({
      companyId: 1,
      definition: defs.hadi_golden_coast,
      accounts: [hadiRow],
    });
    expect(plan.action).toBe("repair");
    expect(plan.accountId).toBe(20);
    expect(plan.repairs).toContainEqual({ field: "accountType", from: "Liability", to: "Intercompany" });
  });

  it("fails closed instead of choosing between duplicate active canonical accounts", () => {
    expect(() =>
      planGoldenCoastPhase13IntercompanyAccount({
        companyId: 7,
        definition: defs.golden_coast_hadi,
        accounts: [row({ id: 10 }), row({ id: 11, name: "Duplicate" })],
      })
    ).toThrow(/2 active sp_hadi_intercompany accounts/);

    const status = summarizeGoldenCoastPhase13IntercompanyAccount({
      companyId: 7,
      definition: defs.golden_coast_hadi,
      accounts: [row({ id: 10 }), row({ id: 11, name: "Duplicate" })],
    });
    expect(status.status).toBe("ambiguous");
  });

  it("rejects cross-company rows rather than silently ignoring them", () => {
    expect(() =>
      planGoldenCoastPhase13IntercompanyAccount({
        companyId: 7,
        definition: defs.golden_coast_hadi,
        accounts: [row({ companyId: 8 })],
      })
    ).toThrow(GoldenCoastPhase13IntercompanyError);
  });
});

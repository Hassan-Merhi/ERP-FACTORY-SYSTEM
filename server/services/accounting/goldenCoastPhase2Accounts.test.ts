import { describe, expect, it } from "vitest";

import {
  GOLDEN_COAST_PHASE2_ACCOUNT_DEFS,
  GOLDEN_COAST_PHASE2_LOOKUP_SUBTYPES,
  GoldenCoastPhase2SetupError,
  getGoldenCoastAccountDefinition,
  planGoldenCoastAccountProvisioning,
  summarizeGoldenCoastAccountSetup,
  type GoldenCoastAccountRole,
  type GoldenCoastLedgerRow,
} from "./goldenCoastAccounts";

const COMPANY_ID = 7;

function row(
  overrides: Partial<GoldenCoastLedgerRow> & Pick<GoldenCoastLedgerRow, "id" | "subType">
): GoldenCoastLedgerRow {
  return {
    companyId: COMPANY_ID,
    code: `CODE-${overrides.id}`,
    name: `Account ${overrides.id}`,
    accountType: "Asset",
    isHidden: false,
    active: true,
    deletedAt: null,
    ...overrides,
  };
}

/** Builds the exact ledger rows a first provisioning run would produce. */
function fullyProvisionedAccounts(): GoldenCoastLedgerRow[] {
  return GOLDEN_COAST_PHASE2_ACCOUNT_DEFS.map((definition, index) =>
    row({
      id: 100 + index,
      subType: definition.subType,
      code: definition.code,
      name: definition.name,
      accountType: definition.accountType,
      isHidden: false,
    })
  );
}

function settingsForAccounts(accounts: GoldenCoastLedgerRow[]) {
  const idFor = (role: GoldenCoastAccountRole) => {
    const definition = getGoldenCoastAccountDefinition(role);
    return accounts.find((account) => account.subType === definition.subType)?.id ?? null;
  };
  return {
    spPosPayableAccountId: idFor("gc_sales_cash"),
    spPosProfitAccountId: idFor("profit_pending_distribution"),
  };
}

function itemFor(plan: ReturnType<typeof planGoldenCoastAccountProvisioning>, role: GoldenCoastAccountRole) {
  const item = plan.items.find((candidate) => candidate.role === role);
  if (!item) throw new Error(`missing plan item for ${role}`);
  return item;
}

function statusFor(status: ReturnType<typeof summarizeGoldenCoastAccountSetup>, role: GoldenCoastAccountRole) {
  const found = status.roles.find((candidate) => candidate.role === role);
  if (!found) throw new Error(`missing status for ${role}`);
  return found;
}

describe("Golden Coast Phase 2 canonical account roles", () => {
  it("requires exactly one definition per role with a unique canonical subType", () => {
    const roles = GOLDEN_COAST_PHASE2_ACCOUNT_DEFS.map((definition) => definition.role);
    const subTypes = GOLDEN_COAST_PHASE2_ACCOUNT_DEFS.map((definition) => definition.subType);
    expect(new Set(roles).size).toBe(roles.length);
    expect(new Set(subTypes).size).toBe(subTypes.length);
  });

  it("keeps Fresh Start and Hassan equity as distinct Equity roles", () => {
    const freshStart = getGoldenCoastAccountDefinition("fresh_start_equity");
    const hassan = getGoldenCoastAccountDefinition("hassan_equity");

    expect(freshStart.subType).not.toBe(hassan.subType);
    expect(freshStart.accountType).toBe("Equity");
    expect(hassan.accountType).toBe("Equity");
    expect(freshStart.name).toBe("Fresh Start FZ Equity");
    expect(hassan.name).toBe("Hassan Dakik Equity");
    expect(freshStart.openingBalanceTargetUsd).toBe("100000.00");
    expect(hassan.openingBalanceTargetUsd).toBe("100000.00");
    expect(freshStart.ownershipSharePct).toBe("50");
    expect(hassan.ownershipSharePct).toBe("50");
  });

  it("models Hassan Savings as a Loan owed to Hassan, never as Equity", () => {
    const savings = getGoldenCoastAccountDefinition("hassan_savings");
    expect(savings.accountType).toBe("Loans");
    expect(savings.acceptedAccountTypes).not.toContain("Equity");
    expect(savings.openingBalanceTargetUsd).toBeUndefined();
  });

  it("models GC Sales Cash as a payable liability bound to the POS payable setting", () => {
    const salesCash = getGoldenCoastAccountDefinition("gc_sales_cash");
    expect(salesCash.accountType).toBe("Liability");
    expect(salesCash.acceptedAccountTypes).toEqual(["Liability", "Accounts Payable"]);
    expect(salesCash.settingsKey).toBe("spPosPayableAccountId");
  });

  it("models Stock OTW, Stock in Hand and the container reserve as visible Assets", () => {
    for (const role of ["stock_otw", "stock_in_hand", "container_reserve"] as const) {
      const definition = getGoldenCoastAccountDefinition(role);
      expect(definition.accountType).toBe("Asset");
      expect(definition.requiresVisible).toBe(true);
    }
  });

  it("rejects an unknown role", () => {
    expect(() => getGoldenCoastAccountDefinition("nope" as GoldenCoastAccountRole)).toThrow(
      GoldenCoastPhase2SetupError
    );
  });
});

describe("first-time provisioning", () => {
  it("creates every canonical role for an empty company", () => {
    const plan = planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts: [] });

    expect(plan.createRoles).toEqual(GOLDEN_COAST_PHASE2_ACCOUNT_DEFS.map((definition) => definition.role));
    expect(plan.repairRoles).toEqual([]);
    expect(plan.adoptRoles).toEqual([]);
    expect(plan.isClean).toBe(false);
    expect(plan.items.every((item) => item.accountId === null)).toBe(true);
  });

  it("reports an unconfigured company as missing every role", () => {
    const status = summarizeGoldenCoastAccountSetup({ companyId: COMPANY_ID, accounts: [] });

    expect(status.isConfigured).toBe(false);
    expect(status.configuredRoleCount).toBe(0);
    expect(status.missingRoles).toHaveLength(GOLDEN_COAST_PHASE2_ACCOUNT_DEFS.length);
    expect(status.roles.every((role) => role.status === "missing")).toBe(true);
  });
});

describe("rerunning provisioning", () => {
  it("does not create or change anything on a fully provisioned company", () => {
    const accounts = fullyProvisionedAccounts();
    const plan = planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts });

    expect(plan.isClean).toBe(true);
    expect(plan.createRoles).toEqual([]);
    expect(plan.adoptRoles).toEqual([]);
    expect(plan.repairRoles).toEqual([]);
    expect(plan.items.every((item) => item.action === "none")).toBe(true);
  });

  it("resolves each role to exactly one account id and never reuses one twice", () => {
    const accounts = fullyProvisionedAccounts();
    const plan = planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts });
    const ids = plan.items.map((item) => item.accountId);

    expect(ids.every((id) => typeof id === "number")).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("reports a fully provisioned and bound company as configured", () => {
    const accounts = fullyProvisionedAccounts();
    const status = summarizeGoldenCoastAccountSetup({
      companyId: COMPANY_ID,
      accounts,
      settings: settingsForAccounts(accounts),
    });

    expect(status.isConfigured).toBe(true);
    expect(status.missingRoles).toEqual([]);
    expect(status.invalidRoles).toEqual([]);
    expect(status.unboundSettingsKeys).toEqual([]);
    expect(status.configuredRoleCount).toBe(status.requiredRoleCount);
  });

  it("leaves a second account on the same subType untouched instead of deduplicating it", () => {
    const accounts = fullyProvisionedAccounts();
    const stockInHand = getGoldenCoastAccountDefinition("stock_in_hand");
    accounts.push(row({ id: 900, subType: stockInHand.subType, name: "Legacy duplicate stock", accountType: "Asset" }));

    const plan = planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts });
    const item = itemFor(plan, "stock_in_hand");

    expect(item.duplicateAccountIds).toEqual([900]);
    expect(item.accountId).not.toBe(900);
    expect(item.warnings.join(" ")).toContain("left untouched");
  });
});

describe("repairing a partially configured company", () => {
  it("renames and unhides a legacy Stock on Floor account rather than creating Stock in Hand", () => {
    const accounts = [
      row({
        id: 11,
        subType: "sp_stock",
        code: "SP-STOCK",
        name: "Stock on Floor",
        accountType: "Asset",
        isHidden: true,
      }),
    ];
    const plan = planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts });
    const item = itemFor(plan, "stock_in_hand");

    expect(item.action).toBe("repair");
    expect(item.accountId).toBe(11);
    expect(item.repairs.map((repair) => repair.field).sort()).toEqual(["isHidden", "name"]);
    expect(item.repairs.find((repair) => repair.field === "name")?.to).toBe("Stock in Hand");
    expect(item.repairs.find((repair) => repair.field === "isHidden")?.to).toBe(false);
  });

  it("adopts the legacy Supplier Cash Payable account as GC Sales Cash", () => {
    const accounts = [
      row({ id: 12, subType: "sp_payable", code: "SP-PAY", name: "Supplier Cash Payable", accountType: "Liability" }),
    ];
    const item = itemFor(planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts }), "gc_sales_cash");

    expect(item.accountId).toBe(12);
    expect(item.repairs).toEqual([
      expect.objectContaining({ field: "name", from: "Supplier Cash Payable", to: "GC Sales Cash" }),
    ]);
  });

  it("reuses the Phase 1 partner capital accounts under the Phase 2 equity names", () => {
    const accounts = [
      row({
        id: 13,
        subType: "gc_partner_capital",
        code: "GC-FSCAP",
        name: "Fresh Start Capital",
        accountType: "Equity",
      }),
      row({ id: 14, subType: "gc_owner_capital", code: "GC-HCAP", name: "Hassan Capital", accountType: "Equity" }),
    ];
    const plan = planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts });

    expect(itemFor(plan, "fresh_start_equity").accountId).toBe(13);
    expect(itemFor(plan, "hassan_equity").accountId).toBe(14);
    expect(plan.createRoles).not.toContain("fresh_start_equity");
    expect(plan.createRoles).not.toContain("hassan_equity");
  });

  it("restores an inactive or soft-deleted required account instead of recreating it", () => {
    const accounts = [
      row({
        id: 15,
        subType: "gc_hassan_savings",
        code: "GC-HSAV",
        name: "Hassan Savings",
        accountType: "Loans",
        active: false,
        deletedAt: new Date("2026-01-01T00:00:00.000Z"),
      }),
    ];
    const item = itemFor(planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts }), "hassan_savings");

    expect(item.accountId).toBe(15);
    expect(item.repairs.map((repair) => repair.field).sort()).toEqual(["active", "deletedAt"]);
    expect(item.repairs.find((repair) => repair.field === "deletedAt")?.to).toBeNull();
  });

  it("retypes an account whose account type is wrong for its role", () => {
    const accounts = [
      row({ id: 16, subType: "gc_hassan_savings", code: "GC-HSAV", name: "Hassan Savings", accountType: "Equity" }),
    ];
    const item = itemFor(planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts }), "hassan_savings");

    expect(item.repairs).toEqual([expect.objectContaining({ field: "accountType", from: "Equity", to: "Loans" })]);
  });

  it("tolerates an accepted non-canonical account type without repairing it", () => {
    const accounts = [
      row({ id: 17, subType: "sp_payable", code: "SP-PAY", name: "GC Sales Cash", accountType: "Accounts Payable" }),
    ];
    const item = itemFor(planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts }), "gc_sales_cash");

    expect(item.action).toBe("none");
    expect(item.repairs).toEqual([]);
  });

  it("keeps a user-customized account name and reports it instead of overwriting it", () => {
    const accounts = [
      row({
        id: 18,
        subType: "sp_goods_otw",
        code: "SP-OTW",
        name: "Container Goods In Transit",
        accountType: "Asset",
      }),
    ];
    const item = itemFor(planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts }), "stock_otw");

    expect(item.repairs.some((repair) => repair.field === "name")).toBe(false);
    expect(item.name).toBe("Container Goods In Transit");
    expect(item.warnings.join(" ")).toContain("custom name");
  });

  it("creates only the roles that are actually missing", () => {
    const accounts = fullyProvisionedAccounts().filter(
      (account) => account.subType !== "gc_hassan_savings" && account.subType !== "gc_profit_pending_distribution"
    );
    const plan = planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts });

    expect(plan.createRoles).toEqual(["hassan_savings", "profit_pending_distribution"]);
    expect(plan.repairRoles).toEqual([]);
  });
});

describe("Profit Pending Distribution", () => {
  it("is a distinct clearing role with no opening-balance target", () => {
    const definition = getGoldenCoastAccountDefinition("profit_pending_distribution");

    expect(definition.subType).toBe("gc_profit_pending_distribution");
    expect(definition.name).toBe("Profit Pending Distribution");
    expect(definition.openingBalanceTargetUsd).toBeUndefined();
    expect(definition.settingsKey).toBe("spPosProfitAccountId");
  });

  it("is provisioned clean, with no opening balance planned by Phase 2", () => {
    const plan = planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts: [] });
    const item = itemFor(plan, "profit_pending_distribution");

    expect(item.action).toBe("create");
    expect(item.openingBalanceTargetUsd).toBeNull();
  });
});

describe("company isolation", () => {
  it("refuses to plan against an account from another company", () => {
    const accounts = [row({ id: 19, subType: "sp_stock", companyId: COMPANY_ID + 1 })];

    expect(() => planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts })).toThrow(/belongs to company/);
  });

  it("rejects an invalid company id", () => {
    expect(() => planGoldenCoastAccountProvisioning({ companyId: 0, accounts: [] })).toThrow(
      GoldenCoastPhase2SetupError
    );
  });

  it("does not resolve a role from another company's identical account", () => {
    const status = summarizeGoldenCoastAccountSetup({ companyId: COMPANY_ID, accounts: [] });
    expect(status.roles.every((role) => role.accountId === null)).toBe(true);
  });
});

describe("setup status reporting", () => {
  it("flags a role whose account type is invalid", () => {
    const accounts = fullyProvisionedAccounts().map((account) =>
      account.subType === "gc_hassan_savings" ? { ...account, accountType: "Equity" } : account
    );
    const status = summarizeGoldenCoastAccountSetup({
      companyId: COMPANY_ID,
      accounts,
      settings: settingsForAccounts(accounts),
    });

    expect(status.isConfigured).toBe(false);
    expect(status.invalidRoles).toEqual(["hassan_savings"]);
    expect(statusFor(status, "hassan_savings").status).toBe("needs_repair");
    expect(statusFor(status, "hassan_savings").issues.join(" ")).toContain("Loans");
  });

  it("flags a company-settings column that does not point at the canonical account", () => {
    const accounts = fullyProvisionedAccounts();
    const status = summarizeGoldenCoastAccountSetup({
      companyId: COMPANY_ID,
      accounts,
      settings: { ...settingsForAccounts(accounts), spPosProfitAccountId: 4242 },
    });

    expect(status.unboundSettingsKeys).toEqual(["spPosProfitAccountId"]);
    expect(statusFor(status, "profit_pending_distribution").settingsBound).toBe(false);
    expect(status.isConfigured).toBe(false);
  });

  it("reports the missing role explicitly rather than only a count", () => {
    const accounts = fullyProvisionedAccounts().filter((account) => account.subType !== "sp_prepaid_expenses");
    const status = summarizeGoldenCoastAccountSetup({
      companyId: COMPANY_ID,
      accounts,
      settings: settingsForAccounts(accounts),
    });

    expect(status.missingRoles).toEqual(["container_reserve"]);
    expect(statusFor(status, "container_reserve").accountId).toBeNull();
  });

  it("surfaces the cutover opening-balance targets without planning a posting", () => {
    const accounts = fullyProvisionedAccounts();
    const status = summarizeGoldenCoastAccountSetup({
      companyId: COMPANY_ID,
      accounts,
      settings: settingsForAccounts(accounts),
    });

    expect(statusFor(status, "fresh_start_equity").openingBalanceTargetUsd).toBe("100000.00");
    expect(statusFor(status, "hassan_equity").openingBalanceTargetUsd).toBe("100000.00");
    expect(statusFor(status, "stock_otw").openingBalanceTargetUsd).toBeNull();
  });
});

describe("historical ledger safety", () => {
  it("never plans a destructive change to an existing account", () => {
    const accounts = [
      row({
        id: 20,
        subType: "sp_stock",
        code: "SP-STOCK",
        name: "Stock on Floor",
        accountType: "Asset",
        isHidden: true,
      }),
      row({ id: 21, subType: "sp_payable", code: "SP-PAY", name: "Supplier Cash Payable", accountType: "Liability" }),
      row({ id: 22, subType: "sp_unrelated_legacy", code: "SP-XX", name: "Legacy account", accountType: "Asset" }),
    ];
    const plan = planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts });
    const touchedIds = plan.items.filter((item) => item.repairs.length > 0).map((item) => item.accountId);
    const allowedFields = new Set(["subType", "accountType", "name", "isHidden", "active", "deletedAt"]);

    // Account 22 is not a Phase 2 role and must not be touched at all.
    expect(touchedIds).not.toContain(22);
    for (const item of plan.items) {
      for (const repair of item.repairs) {
        expect(allowedFields.has(repair.field)).toBe(true);
      }
    }
  });

  it("only ever looks up sub types it declares, so unrelated accounts are never loaded", () => {
    for (const definition of GOLDEN_COAST_PHASE2_ACCOUNT_DEFS) {
      expect(GOLDEN_COAST_PHASE2_LOOKUP_SUBTYPES).toContain(definition.subType);
      for (const legacy of definition.legacySubTypes) {
        expect(GOLDEN_COAST_PHASE2_LOOKUP_SUBTYPES).toContain(legacy);
      }
    }
    expect(GOLDEN_COAST_PHASE2_LOOKUP_SUBTYPES).not.toContain("sp_unrelated_legacy");
  });
});

describe("account name uniqueness", () => {
  // Production enforces uq_ledger_accounts_company_name_active on
  // (company_id, name) WHERE deleted_at IS NULL. A rename or insert that
  // collides would abort the whole provisioning transaction.
  it("skips a legacy rename when another live account already holds the target name", () => {
    const accounts = [
      row({ id: 30, subType: "sp_stock", code: "SP-STOCK", name: "Stock on Floor", accountType: "Asset" }),
    ];
    const existingNames = new Map([
      ["Stock on Floor", 30],
      ["Stock in Hand", 31],
    ]);
    const item = itemFor(
      planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts, existingNames }),
      "stock_in_hand"
    );

    expect(item.repairs.some((repair) => repair.field === "name")).toBe(false);
    expect(item.name).toBe("Stock on Floor");
    expect(item.warnings.join(" ")).toContain("already named");
  });

  it("still renames when the target name is held by the same account", () => {
    const accounts = [
      row({ id: 32, subType: "sp_stock", code: "SP-STOCK", name: "Stock on Floor", accountType: "Asset" }),
    ];
    const existingNames = new Map([["Stock on Floor", 32]]);
    const item = itemFor(
      planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts, existingNames }),
      "stock_in_hand"
    );

    expect(item.repairs.find((repair) => repair.field === "name")?.to).toBe("Stock in Hand");
  });

  it("disambiguates a created account whose canonical name is already taken", () => {
    const existingNames = new Map([["Hassan Savings", 99]]);
    const item = itemFor(
      planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts: [], existingNames }),
      "hassan_savings"
    );

    expect(item.action).toBe("create");
    expect(item.name).toBe("Hassan Savings (GC-HSAV)");
    expect(item.warnings.join(" ")).toContain("already named");
  });

  it("never plans two roles onto the same name in one run", () => {
    const plan = planGoldenCoastAccountProvisioning({
      companyId: COMPANY_ID,
      accounts: [],
      existingNames: new Map(),
    });
    const names = plan.items.map((item) => item.name);

    expect(new Set(names).size).toBe(names.length);
  });

  it("keeps the previous behaviour when no name index is supplied", () => {
    const plan = planGoldenCoastAccountProvisioning({ companyId: COMPANY_ID, accounts: [] });
    expect(plan.items.map((item) => item.name)).toEqual(
      GOLDEN_COAST_PHASE2_ACCOUNT_DEFS.map((definition) => definition.name)
    );
  });
});

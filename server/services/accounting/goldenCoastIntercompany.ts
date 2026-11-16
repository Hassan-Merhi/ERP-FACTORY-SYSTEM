export type GoldenCoastPhase13IntercompanyRole = "golden_coast_hadi" | "hadi_golden_coast";

export interface GoldenCoastPhase13IntercompanyDefinition {
  role: GoldenCoastPhase13IntercompanyRole;
  subType: "sp_hadi_intercompany" | "hadi_sp_intercompany";
  code: string;
  name: string;
  accountType: "Intercompany";
  isHidden: false;
}

export interface GoldenCoastPhase13LedgerRow {
  id: number;
  companyId: number;
  code: string;
  name: string;
  accountType: string;
  subType: string | null;
  isHidden: boolean;
  active: boolean;
  deletedAt: Date | string | null;
}

export interface GoldenCoastPhase13IntercompanyRepair {
  field: "accountType" | "subType" | "isHidden" | "active" | "deletedAt";
  from: unknown;
  to: unknown;
}

export interface GoldenCoastPhase13IntercompanyPlan {
  definition: GoldenCoastPhase13IntercompanyDefinition;
  action: "create" | "adopt" | "repair" | "none";
  accountId: number | null;
  repairs: GoldenCoastPhase13IntercompanyRepair[];
}

export interface GoldenCoastPhase13IntercompanyStatus {
  role: GoldenCoastPhase13IntercompanyRole;
  companyId: number;
  subType: string;
  expectedName: string;
  status: "ok" | "missing" | "needs_repair" | "ambiguous";
  accountId: number | null;
  name: string | null;
  accountType: string | null;
  issues: string[];
}

export class GoldenCoastPhase13IntercompanyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenCoastPhase13IntercompanyError";
  }
}

function positiveId(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new GoldenCoastPhase13IntercompanyError(`${field} must be a positive integer`);
  }
  return value;
}

function cleanName(value: string, field: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new GoldenCoastPhase13IntercompanyError(`${field} is required`);
  return text;
}

export function goldenCoastPhase13IntercompanyDefinitions(input: {
  goldenCoastCompanyName: string;
  hadiCompanyName: string;
}): Record<GoldenCoastPhase13IntercompanyRole, GoldenCoastPhase13IntercompanyDefinition> {
  const goldenCoastCompanyName = cleanName(input.goldenCoastCompanyName, "goldenCoastCompanyName");
  const hadiCompanyName = cleanName(input.hadiCompanyName, "hadiCompanyName");
  return {
    golden_coast_hadi: {
      role: "golden_coast_hadi",
      subType: "sp_hadi_intercompany",
      code: "SP-HADI-IC",
      name: `${hadiCompanyName} — Intercompany`,
      accountType: "Intercompany",
      isHidden: false,
    },
    hadi_golden_coast: {
      role: "hadi_golden_coast",
      subType: "hadi_sp_intercompany",
      code: "SP-IC",
      name: `${goldenCoastCompanyName} — Intercompany`,
      accountType: "Intercompany",
      isHidden: false,
    },
  };
}

function assertScoped(companyId: number, rows: readonly GoldenCoastPhase13LedgerRow[]): void {
  const foreign = rows.find((row) => Number(row.companyId) !== companyId);
  if (foreign) {
    throw new GoldenCoastPhase13IntercompanyError(
      `Intercompany account ${foreign.id} belongs to company ${foreign.companyId}, not company ${companyId}`
    );
  }
}

function byId(a: GoldenCoastPhase13LedgerRow, b: GoldenCoastPhase13LedgerRow): number {
  return a.id - b.id;
}

function isLive(row: GoldenCoastPhase13LedgerRow): boolean {
  return row.active === true && row.deletedAt == null;
}

function selectCandidate(input: {
  companyId: number;
  definition: GoldenCoastPhase13IntercompanyDefinition;
  accounts: readonly GoldenCoastPhase13LedgerRow[];
}): { selected: GoldenCoastPhase13LedgerRow | null; adopted: boolean } {
  const canonical = input.accounts.filter((row) => row.subType === input.definition.subType).sort(byId);
  const legacy = input.accounts
    .filter((row) => row.subType !== input.definition.subType)
    .filter((row) => row.code === input.definition.code || row.name === input.definition.name)
    .sort(byId);

  const liveCanonical = canonical.filter(isLive);
  if (liveCanonical.length > 1) {
    throw new GoldenCoastPhase13IntercompanyError(
      `Company ${input.companyId} has ${liveCanonical.length} active ${input.definition.subType} accounts; repair duplicates before Golden Coast setup`
    );
  }

  const liveLegacy = legacy.filter(isLive);
  if (liveLegacy.length > 1) {
    throw new GoldenCoastPhase13IntercompanyError(
      `Company ${input.companyId} has multiple live legacy candidates for ${input.definition.subType}; repair duplicates before Golden Coast setup`
    );
  }

  // Preserve the live account that already owns historical voucher links before
  // considering any soft-deleted canonical row. This avoids reviving a deleted
  // duplicate when a healthy legacy account with the stable code/name exists.
  if (liveCanonical[0]) return { selected: liveCanonical[0], adopted: false };
  if (liveLegacy[0]) return { selected: liveLegacy[0], adopted: true };

  const deletedCanonical = canonical[0] ?? null;
  if (deletedCanonical) return { selected: deletedCanonical, adopted: false };

  const deletedLegacy = legacy[0] ?? null;
  return { selected: deletedLegacy, adopted: deletedLegacy != null };
}

/**
 * Plans one side of the Golden Coast ↔ HADI pair. Canonical subtype is the
 * durable identity. A missing row is created; a legacy/wrong/inactive row is
 * adopted or repaired in place so historical voucher links keep the same id.
 */
export function planGoldenCoastPhase13IntercompanyAccount(input: {
  companyId: number;
  definition: GoldenCoastPhase13IntercompanyDefinition;
  accounts: readonly GoldenCoastPhase13LedgerRow[];
}): GoldenCoastPhase13IntercompanyPlan {
  const companyId = positiveId(input.companyId, "companyId");
  const accounts = input.accounts ?? [];
  assertScoped(companyId, accounts);
  const { selected, adopted } = selectCandidate({ companyId, definition: input.definition, accounts });
  if (!selected) {
    return { definition: input.definition, action: "create", accountId: null, repairs: [] };
  }

  const repairs: GoldenCoastPhase13IntercompanyRepair[] = [];
  if (selected.accountType !== "Intercompany") {
    repairs.push({ field: "accountType", from: selected.accountType, to: "Intercompany" });
  }
  if (selected.subType !== input.definition.subType) {
    repairs.push({ field: "subType", from: selected.subType, to: input.definition.subType });
  }
  if (selected.isHidden) repairs.push({ field: "isHidden", from: true, to: false });
  if (!selected.active) repairs.push({ field: "active", from: false, to: true });
  if (selected.deletedAt != null) repairs.push({ field: "deletedAt", from: selected.deletedAt, to: null });

  return {
    definition: input.definition,
    action: adopted ? "adopt" : repairs.length > 0 ? "repair" : "none",
    accountId: selected.id,
    repairs,
  };
}

export function summarizeGoldenCoastPhase13IntercompanyAccount(input: {
  companyId: number;
  definition: GoldenCoastPhase13IntercompanyDefinition;
  accounts: readonly GoldenCoastPhase13LedgerRow[];
}): GoldenCoastPhase13IntercompanyStatus {
  const companyId = positiveId(input.companyId, "companyId");
  const accounts = input.accounts ?? [];
  assertScoped(companyId, accounts);
  try {
    const plan = planGoldenCoastPhase13IntercompanyAccount({ companyId, definition: input.definition, accounts });
    const selected = plan.accountId == null ? null : (accounts.find((row) => row.id === plan.accountId) ?? null);
    if (!selected) {
      return {
        role: input.definition.role,
        companyId,
        subType: input.definition.subType,
        expectedName: input.definition.name,
        status: "missing",
        accountId: null,
        name: null,
        accountType: null,
        issues: ["Required intercompany account is missing"],
      };
    }
    return {
      role: input.definition.role,
      companyId,
      subType: input.definition.subType,
      expectedName: input.definition.name,
      status: plan.repairs.length > 0 ? "needs_repair" : "ok",
      accountId: selected.id,
      name: selected.name,
      accountType: selected.accountType,
      issues: plan.repairs.map((repair) => `${repair.field} must be ${String(repair.to)}`),
    };
  } catch (error) {
    if (error instanceof GoldenCoastPhase13IntercompanyError && /duplicate|multiple/.test(error.message)) {
      return {
        role: input.definition.role,
        companyId,
        subType: input.definition.subType,
        expectedName: input.definition.name,
        status: "ambiguous",
        accountId: null,
        name: null,
        accountType: null,
        issues: [error.message],
      };
    }
    throw error;
  }
}

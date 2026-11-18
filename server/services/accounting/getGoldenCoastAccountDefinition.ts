// Extracted from ./goldenCoastPhase2Accounts.ts to keep that module under the source-size cap.

export type GoldenCoastAccountRole =
  | "fresh_start_equity"
  | "hassan_equity"
  | "hassan_savings"
  | "gc_sales_cash"
  | "profit_pending_distribution"
  | "stock_otw"
  | "stock_in_hand"
  | "container_reserve";

export type GoldenCoastSettingsKey = "spPosPayableAccountId" | "spPosProfitAccountId";

export interface GoldenCoastAccountDefinition {
  readonly role: GoldenCoastAccountRole;
  /** Canonical, stable role identifier persisted in ledger_accounts.sub_type. */
  readonly subType: string;
  readonly code: string;
  readonly name: string;
  readonly accountType: string;
  /**
   * Account types tolerated on an already-provisioned account. The canonical
   * type is always first. Anything outside this list is treated as misconfigured
   * and repaired back to the canonical type.
   */
  readonly acceptedAccountTypes: readonly string[];
  /**
   * Legacy sub types this role may adopt instead of creating a second account.
   * Adoption rewrites the role mapping only — never journal entries.
   */
  readonly legacySubTypes: readonly string[];
  /**
   * Names a legacy account is allowed to carry before Phase 2 renames it. A
   * name outside this list is assumed to be a deliberate user customization and
   * is left alone.
   */
  readonly legacyNames: readonly string[];
  /** Phase 2 requires these roles to be readable on the balance sheet. */
  readonly requiresVisible: boolean;
  /** Cutover target only — Phase 2 never posts an opening balance. */
  readonly openingBalanceTargetUsd?: string;
  /** Partner ownership / profit share percentage. */
  readonly ownershipSharePct?: string;
  /** Company-settings column that must point at this account, when applicable. */
  readonly settingsKey?: GoldenCoastSettingsKey;
}

export const GOLDEN_COAST_PHASE2_ACCOUNT_DEFS: readonly GoldenCoastAccountDefinition[] = [
  {
    role: "fresh_start_equity",
    // Reuses the Phase 1 `gc_partner_capital` role so Phase 1 postings keep working.
    subType: "gc_partner_capital",
    code: "GC-FSCAP",
    name: "Fresh Start FZ Equity",
    accountType: "Equity",
    acceptedAccountTypes: ["Equity"],
    legacySubTypes: [],
    legacyNames: ["Fresh Start Capital", "Fresh Start FZ Capital"],
    // Fresh Start FZ partner capital: 50% ownership and 50% profit share.
    requiresVisible: true,
    openingBalanceTargetUsd: "100000.00",
    ownershipSharePct: "50",
  },
  {
    role: "hassan_equity",
    // Reuses the Phase 1 `gc_owner_capital` role.
    subType: "gc_owner_capital",
    code: "GC-HCAP",
    name: "Hassan Dakik Equity",
    accountType: "Equity",
    acceptedAccountTypes: ["Equity"],
    legacySubTypes: [],
    legacyNames: ["Hassan Capital", "Hassan Dakik Capital"],
    // Hassan Dakik partner capital: 50% ownership and 50% profit share.
    requiresVisible: true,
    openingBalanceTargetUsd: "100000.00",
    ownershipSharePct: "50",
  },
  {
    role: "hassan_savings",
    subType: "gc_hassan_savings",
    code: "GC-HSAV",
    name: "Hassan Savings",
    accountType: "Loans",
    // Explicitly NOT Equity: this is an amount the company owes Hassan.
    acceptedAccountTypes: ["Loans"],
    legacySubTypes: [],
    legacyNames: [],
    // A loan owed to Hassan. Later phases credit it from special-location
    // deductions and unused container reserve, and debit it on withdrawals.
    requiresVisible: true,
  },
  {
    role: "gc_sales_cash",
    // Adopts the existing Supplier Partner payable so settlement history is preserved.
    subType: "sp_payable",
    code: "SP-PAY",
    name: "GC Sales Cash",
    accountType: "Liability",
    acceptedAccountTypes: ["Liability", "Accounts Payable"],
    legacySubTypes: [],
    legacyNames: ["Supplier Cash Payable"],
    // Running settlement owed to the person whose goods were sold. It is
    // partially payable and does not have to be cleared in full.
    requiresVisible: true,
    settingsKey: "spPosPayableAccountId",
  },
  {
    role: "profit_pending_distribution",
    subType: "gc_profit_pending_distribution",
    code: "GC-PPD",
    name: "Profit Pending Distribution",
    accountType: "Equity",
    acceptedAccountTypes: ["Equity", "Profit"],
    legacySubTypes: [],
    legacyNames: [],
    // Temporary month-close clearing account. It returns to zero after every
    // finalized month, when profit is split 50/50 between Hassan and Fresh Start.
    requiresVisible: true,
    settingsKey: "spPosProfitAccountId",
  },
  {
    role: "stock_otw",
    // Adopts the existing SP `Goods On The Way` asset.
    subType: "sp_goods_otw",
    code: "SP-OTW",
    name: "Stock OTW",
    accountType: "Asset",
    acceptedAccountTypes: ["Asset"],
    legacySubTypes: [],
    legacyNames: ["Goods On The Way", "Goods on the Way"],
    // Container goods in transit, before offload.
    requiresVisible: true,
  },
  {
    role: "stock_in_hand",
    // Adopts the existing SP `Stock on Floor` asset and unhides it so it is
    // readable on the balance sheet, as Phase 2 requires.
    subType: "sp_stock",
    code: "SP-STOCK",
    name: "Stock in Hand",
    accountType: "Asset",
    acceptedAccountTypes: ["Asset"],
    legacySubTypes: [],
    legacyNames: ["Stock on Floor", "Stock On Floor"],
    // Offloaded stock available on the floor. Later phases move Stock OTW here.
    requiresVisible: true,
  },
  {
    role: "container_reserve",
    // Adopts the existing SP `Prepaid Expenses` asset.
    subType: "sp_prepaid_expenses",
    code: "SP-PREEXP",
    name: "Prepaid Expenses / Container Reserve",
    accountType: "Asset",
    acceptedAccountTypes: ["Asset"],
    legacySubTypes: [],
    legacyNames: ["Prepaid Expenses", "Prepaid Charges"],
    // Real money set aside for duties, transport and container expenses.
    requiresVisible: true,
  },
] as const;

/** Every sub type Phase 2 looks at, canonical plus adoptable legacy aliases. */
export const GOLDEN_COAST_PHASE2_LOOKUP_SUBTYPES: readonly string[] = [
  ...new Set(
    GOLDEN_COAST_PHASE2_ACCOUNT_DEFS.flatMap((definition) => [definition.subType, ...definition.legacySubTypes])
  ),
];

export function getGoldenCoastAccountDefinition(role: GoldenCoastAccountRole): GoldenCoastAccountDefinition {
  const definition = GOLDEN_COAST_PHASE2_ACCOUNT_DEFS.find((candidate) => candidate.role === role);
  if (!definition) throw new GoldenCoastPhase2SetupError(`Unknown Golden Coast account role: ${role}`);
  return definition;
}

export class GoldenCoastPhase2SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoldenCoastPhase2SetupError";
  }
}

// ── Input / output shapes ────────────────────────────────────────────────────

export interface GoldenCoastLedgerRow {
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

export type GoldenCoastRepairField = "subType" | "accountType" | "name" | "isHidden" | "active" | "deletedAt";

export interface GoldenCoastRepair {
  field: GoldenCoastRepairField;
  from: string | boolean | null;
  to: string | boolean | null;
  reason: string;
}

export type GoldenCoastRoleAction = "create" | "adopt" | "repair" | "none";

export interface GoldenCoastRolePlanItem {
  role: GoldenCoastAccountRole;
  subType: string;
  code: string;
  name: string;
  accountType: string;
  requiresVisible: boolean;
  openingBalanceTargetUsd: string | null;
  ownershipSharePct: string | null;
  settingsKey: GoldenCoastSettingsKey | null;
  action: GoldenCoastRoleAction;
  /** Existing account this role resolves to, when one was found. */
  accountId: number | null;
  /** Field-level, non-destructive corrections to apply to `accountId`. */
  repairs: GoldenCoastRepair[];
  /** Problems Phase 2 refuses to fix automatically. */
  warnings: string[];
  /** Extra accounts sharing this role's sub type. Never modified or deleted. */
  duplicateAccountIds: number[];
}

export interface GoldenCoastProvisioningPlan {
  companyId: number;
  items: GoldenCoastRolePlanItem[];
  /** Roles that will be created because nothing suitable exists yet. */
  createRoles: GoldenCoastAccountRole[];
  /** Roles that will adopt an existing legacy account instead of duplicating it. */
  adoptRoles: GoldenCoastAccountRole[];
  /** Roles with at least one field-level repair queued. */
  repairRoles: GoldenCoastAccountRole[];
  warnings: string[];
  /** True when applying this plan would change nothing. */
  isClean: boolean;
}

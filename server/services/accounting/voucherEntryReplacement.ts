/**
 * Rules for replacing the lines of an existing voucher.
 *
 * The voucher edit routes (PATCH /api/vouchers/:id and
 * PUT /api/vouchers/:id/with-entries) delete a voucher's lines and insert the
 * submitted ones. The 2026-10 accounting audit found that they:
 *   - wiped every line when the request carried no `entries` (a header-only edit
 *     of date or description left the voucher with no ledger lines);
 *   - inserted lines with no account at all when the client sent the
 *     `{ accountType, accountId }` shape the Daybook form uses;
 *   - dropped `customerId` on every edit, removing customer-account lines from
 *     the customer sub-ledger and statements;
 *   - checked balance with float sums and a 0.01 tolerance, or not at all.
 *
 * These helpers make a replacement explicit, validated and sub-ledger
 * preserving. Amount rules are the manual-voucher rules
 * (validateManualVoucherEntryAmounts); voucher types whose ledger evidence is
 * one-sided by design (stock adjustments) keep the per-line rules only.
 */
import { and, eq, inArray, isNull } from "drizzle-orm";

import { customers, voucherEntries } from "@shared/schema";

import type { db, DbTransaction } from "../../db";

import { PostingValidationError } from "./centralPostingEngine";
import { validateManualVoucherEntryAmounts, type ManualVoucherEntryAmountInput } from "./manualVoucherEntryValidation";
import { classifyVoucherLedgerExpectation } from "./voucherLedgerExpectation";

export interface ReplacementEntryInput extends ManualVoucherEntryAmountInput {
  ledgerAccountId?: unknown;
  bankAccountId?: unknown;
  fixedAssetId?: unknown;
  supplierId?: unknown;
  employeeId?: unknown;
  customerId?: unknown;
  factorySupplierId?: unknown;
  narration?: unknown;
  /** Daybook form shape: one of ledger | bank | supplier | employee | fixedAsset | customer | factorySupplier. */
  accountType?: unknown;
  accountId?: unknown;
}

export interface ReplacementEntryTargets {
  ledgerAccountId: number | null;
  bankAccountId: number | null;
  fixedAssetId: number | null;
  supplierId: number | null;
  employeeId: number | null;
  customerId: number | null;
  factorySupplierId: number | null;
}

const ACCOUNT_TYPE_TARGET: Record<string, keyof ReplacementEntryTargets> = {
  ledger: "ledgerAccountId",
  bank: "bankAccountId",
  fixedAsset: "fixedAssetId",
  supplier: "supplierId",
  employee: "employeeId",
  customer: "customerId",
  factorySupplier: "factorySupplierId",
};

function positiveId(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Reads a line's posting target from either the column shape
 * (`ledgerAccountId`, `supplierId`, ...) or the Daybook form shape
 * (`accountType` + `accountId`).
 */
export function resolveReplacementEntryTargets(entry: ReplacementEntryInput): ReplacementEntryTargets {
  const targets: ReplacementEntryTargets = {
    ledgerAccountId: positiveId(entry.ledgerAccountId),
    bankAccountId: positiveId(entry.bankAccountId),
    fixedAssetId: positiveId(entry.fixedAssetId),
    supplierId: positiveId(entry.supplierId),
    employeeId: positiveId(entry.employeeId),
    customerId: positiveId(entry.customerId),
    factorySupplierId: positiveId(entry.factorySupplierId),
  };
  const field = typeof entry.accountType === "string" ? ACCOUNT_TYPE_TARGET[entry.accountType] : undefined;
  const accountId = positiveId(entry.accountId);
  if (field && accountId && targets[field] === null) targets[field] = accountId;
  return targets;
}

/**
 * Every line posts to exactly one account. The one allowed pair is a customer
 * line carrying the customer's own ledger account (that is how customer
 * receivables are posted).
 */
export function assertReplacementEntryTargets(targets: ReplacementEntryTargets, index: number): void {
  const present = (Object.keys(targets) as (keyof ReplacementEntryTargets)[]).filter((key) => targets[key] !== null);
  if (present.length === 0) {
    throw new PostingValidationError("POSTING_TARGET_REQUIRED", `Entry ${index + 1} must post to an account`);
  }
  const customerPair = present.length === 2 && present.includes("customerId") && present.includes("ledgerAccountId");
  if (present.length > 1 && !customerPair) {
    throw new PostingValidationError("POSTING_TARGET_AMBIGUOUS", `Entry ${index + 1} must post to exactly one account`);
  }
}

const ONE_SIDED_EXPECTATIONS: ReadonlySet<string> = new Set(["single-sided", "inventory-sided", "none"]);

/**
 * Whether an active voucher of this type must balance exactly. Fails closed:
 * only the known one-sided stock types are exempt.
 */
export function voucherTypeRequiresBalance(voucherType: unknown): boolean {
  return !ONE_SIDED_EXPECTATIONS.has(classifyVoucherLedgerExpectation(voucherType));
}

/**
 * Validates the amounts of a full replacement set for a voucher of the given
 * type. Active vouchers must balance exactly unless their type is a known
 * one-sided stock type, which keeps the per-line rules only.
 */
export function assertReplacementEntryAmounts(
  voucherType: unknown,
  optional: boolean,
  entries: readonly ManualVoucherEntryAmountInput[]
): void {
  // Fails closed: only the known one-sided stock types are exempt, so a type
  // nobody has classified must still balance.
  validateManualVoucherEntryAmounts(entries, { optional: optional || !voucherTypeRequiresBalance(voucherType) });
}

/**
 * Full validation of a replacement set: targets and amounts.
 *
 * The edit routes insert `debitAmount` / `creditAmount` as submitted (for a
 * foreign-currency line that is the native amount, which the route or the
 * normalization trigger converts), so those are the amounts validated, even
 * when the line also names its `transactionCurrency`.
 */
export function assertValidReplacementEntries(
  voucherType: unknown,
  optional: boolean,
  entries: readonly ReplacementEntryInput[]
): ReplacementEntryTargets[] {
  const targets = entries.map((entry, index) => {
    const resolved = resolveReplacementEntryTargets(entry);
    assertReplacementEntryTargets(resolved, index);
    return resolved;
  });
  assertReplacementEntryAmounts(
    voucherType,
    optional,
    entries.map((entry) => ({ debitAmount: entry.debitAmount, creditAmount: entry.creditAmount }))
  );
  return targets;
}

/**
 * A voucher's stored lines, as the amount validator reads them. Used when a
 * header-only edit activates an optional voucher: its existing lines must then
 * satisfy the active-voucher rules.
 */
export function storedEntriesAsAmountInput(
  entries: readonly {
    debitAmount: string | null;
    creditAmount: string | null;
    transactionCurrency?: string | null;
    transactionDebitAmount?: string | null;
    transactionCreditAmount?: string | null;
  }[]
): ManualVoucherEntryAmountInput[] {
  // Stored debit/credit are the posted (base) amounts; balance is judged on them.
  return entries.map((entry) => ({ debitAmount: entry.debitAmount, creditAmount: entry.creditAmount }));
}

/**
 * Re-reads a voucher's stored lines and checks them against the rules for its
 * type and state (an active balanced-type voucher must balance exactly). Pass
 * `optional: false` to check whether the voucher may be activated. Throws a
 * PostingValidationError (see replacementErrorStatus) when the lines fail.
 */
export async function assertStoredVoucherLinesValidTx(
  reader: typeof db | DbTransaction,
  voucher: { id: number; voucherType: unknown; optional: boolean }
): Promise<void> {
  const lines = await reader.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucher.id));
  assertReplacementEntryAmounts(voucher.voucherType, voucher.optional, storedEntriesAsAmountInput(lines));
}

/**
 * Restores the customer link on lines that post to a customer's own ledger
 * account. Edit forms do not round-trip `customerId`, so without this every
 * edit removed those lines from the customer sub-ledger.
 */
export async function linkCustomerLedgerTargets(
  reader: typeof db | DbTransaction,
  companyId: number,
  targets: ReplacementEntryTargets[]
): Promise<ReplacementEntryTargets[]> {
  const ledgerIds = [
    ...new Set(
      targets
        .filter((target) => target.customerId === null && target.ledgerAccountId !== null)
        .map((target) => target.ledgerAccountId as number)
    ),
  ];
  if (ledgerIds.length === 0) return targets;
  const rows = await reader
    .select({ id: customers.id, ledgerAccountId: customers.ledgerAccountId })
    .from(customers)
    .where(
      and(
        eq(customers.companyId, companyId),
        inArray(customers.ledgerAccountId, ledgerIds),
        isNull(customers.deletedAt)
      )
    );
  const customerByLedger = new Map<number, number>();
  for (const row of rows) {
    // An account shared by two customers is ambiguous; leave such lines unlinked.
    if (row.ledgerAccountId === null) continue;
    if (customerByLedger.has(row.ledgerAccountId)) customerByLedger.set(row.ledgerAccountId, -1);
    else customerByLedger.set(row.ledgerAccountId, row.id);
  }
  return targets.map((target) => {
    if (target.customerId !== null || target.ledgerAccountId === null) return target;
    const customerId = customerByLedger.get(target.ledgerAccountId);
    return customerId && customerId > 0 ? { ...target, customerId } : target;
  });
}

/** HTTP status for a replacement validation failure. */
export function replacementErrorStatus(error: unknown): number | null {
  return error instanceof PostingValidationError ? 400 : null;
}

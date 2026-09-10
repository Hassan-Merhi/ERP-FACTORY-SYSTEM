/**
 * Which column on a voucher entry holds the account it points at.
 *
 * A voucher entry links to exactly one of seven account tables, chosen by the
 * entry's `accountType`. Several voucher write paths were each rebuilding that
 * mapping as an eight-branch if-chain assigning into an `any` accumulator,
 * which meant a missing branch or a misspelled column produced no error and a
 * silently unlinked entry — an entry that posts against no account at all.
 *
 * Declaring the mapping once, keyed by the account-type union, makes the set of
 * types exhaustive and the column names checked against the insert contract.
 */
import type { VoucherEntryInsertFields } from "./accountingTypes";

export const VOUCHER_ACCOUNT_TYPES = [
  "ledger",
  "bank",
  "supplier",
  "factorySupplier",
  "employee",
  "fixedAsset",
  "customer",
] as const;

export type VoucherAccountType = (typeof VOUCHER_ACCOUNT_TYPES)[number];

/**
 * The link columns, keyed by account type.
 *
 * `satisfies` checks every value is a real field of the insert contract while
 * keeping the literal key/value types, so `ACCOUNT_LINK_FIELD[type]` stays
 * precise rather than widening to `string`.
 */
export const ACCOUNT_LINK_FIELD = {
  ledger: "ledgerAccountId",
  bank: "bankAccountId",
  supplier: "supplierId",
  factorySupplier: "factorySupplierId",
  employee: "employeeId",
  fixedAsset: "fixedAssetId",
  customer: "customerId",
} as const satisfies Record<VoucherAccountType, keyof VoucherEntryInsertFields>;

/** The account-linkage slice of a voucher entry: exactly one key populated. */
export type VoucherEntryAccountLink = Partial<
  Pick<VoucherEntryInsertFields, (typeof ACCOUNT_LINK_FIELD)[VoucherAccountType]>
>;

export function isVoucherAccountType(value: unknown): value is VoucherAccountType {
  return (VOUCHER_ACCOUNT_TYPES as readonly unknown[]).includes(value);
}

/**
 * Build the linkage for one entry.
 *
 * Callers that receive an unvalidated account type should guard with
 * `isVoucherAccountType` first; an unrecognized type has no column to write and
 * must not silently become a different one.
 */
export function voucherEntryAccountLink(accountType: VoucherAccountType, accountId: number): VoucherEntryAccountLink {
  return { [ACCOUNT_LINK_FIELD[accountType]]: accountId };
}

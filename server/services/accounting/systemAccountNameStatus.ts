/**
 * A same-named legacy ledger account is NOT safe to reuse when its account
 * type disagrees with the canonical system role (e.g. FX loss typed Asset).
 */
import type { SystemAccountDefinition, SystemAccountStatus } from "./systemAccounts";

export function statusForSameNamedSystemAccount(
  definition: SystemAccountDefinition,
  existing: { id: number; code: string; account_type: string }
): SystemAccountStatus {
  if (existing.account_type !== definition.accountType) {
    return {
      code: definition.code,
      state: "type_differs",
      accountId: existing.id,
      expectedType: definition.accountType,
      actualType: existing.account_type,
    };
  }
  return {
    code: definition.code,
    state: "reused_by_name",
    accountId: existing.id,
    actualCode: existing.code,
  };
}

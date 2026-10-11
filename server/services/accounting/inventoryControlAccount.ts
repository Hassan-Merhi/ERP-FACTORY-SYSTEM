import { and, eq } from "drizzle-orm";
import { ledgerAccounts } from "@shared/schema";
import type { DatabaseOrTransaction } from "../../db";
import { HttpError } from "../../lib/httpError";
import { classifyAccountType } from "./accountClassification";
import { ensureSystemAccounts } from "./systemAccounts";

export const INVENTORY_CONTROL_ACCOUNT_CODE = "INVENTORY" as const;
export const INVENTORY_CONTROL_ACCOUNT_CONFLICT_CODE = "INVENTORY_CONTROL_ACCOUNT_CONFLICT" as const;

export type InventoryControlAccountConflictReason = "not_asset" | "deleted" | "name_taken";

/**
 * The INVENTORY control account cannot be used or created as it stands. The
 * accounting integrity diagnostic lists the same rows
 * (`inventory_control_account_conflict`) for a reviewed correction.
 */
export class InventoryControlAccountConflictError extends HttpError {
  readonly code = INVENTORY_CONTROL_ACCOUNT_CONFLICT_CODE;
  constructor(
    readonly reason: InventoryControlAccountConflictReason,
    readonly accountId: number
  ) {
    super(409, INVENTORY_CONTROL_ACCOUNT_CONFLICT_MESSAGES[reason]);
    this.name = "InventoryControlAccountConflictError";
  }
}

export const INVENTORY_CONTROL_ACCOUNT_CONFLICT_MESSAGES: Record<InventoryControlAccountConflictReason, string> = {
  not_asset:
    "The account with code INVENTORY is not an asset account, so it cannot be used as the inventory control account. Correct it in the chart of accounts first (see the accounting integrity diagnostic).",
  deleted:
    "The account with code INVENTORY is deleted, so it cannot be used as the inventory control account. Review it in the accounting integrity diagnostic first.",
  name_taken:
    "There is no account with code INVENTORY and another account already uses the name Inventory, so the inventory control account cannot be created. Review it in the accounting integrity diagnostic first.",
};

/**
 * Resolve the inventory control ledger (credit/debit notes, stock adjustments,
 * receipts, sale COGS, movement journals).
 *
 * Wave 18 (B): by code only (INVENTORY), never by name — a name match could
 * pick RETAIL-INVENTORY or Golden Coast's "Stock in Hand", which is reconciled
 * against FIFO layers. An existing account is never retyped, renamed,
 * reactivated or restored:
 *   - a live INVENTORY account of an asset type is used as it is;
 *   - a live INVENTORY account of another type, or a deleted one, is refused
 *     (409 INVENTORY_CONTROL_ACCOUNT_CONFLICT);
 *   - with none, the registry account is created (code, name and type from the
 *     system account registry); if another live account already holds the
 *     registry name, that conflict is refused too.
 */
export async function getOrCreateInventoryControlAccount(
  tx: DatabaseOrTransaction,
  companyId: number
): Promise<{ id: number }> {
  const [byCode] = await tx
    .select({
      id: ledgerAccounts.id,
      accountType: ledgerAccounts.accountType,
      subType: ledgerAccounts.subType,
      deletedAt: ledgerAccounts.deletedAt,
    })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, INVENTORY_CONTROL_ACCOUNT_CODE)))
    .limit(1);

  if (byCode) {
    if (byCode.deletedAt) throw new InventoryControlAccountConflictError("deleted", byCode.id);
    if (classifyAccountType(byCode.accountType, byCode.subType) !== "asset") {
      throw new InventoryControlAccountConflictError("not_asset", byCode.id);
    }
    return { id: byCode.id };
  }

  // Created by the registry (its code, name and type), never reused by name.
  const [status] = await ensureSystemAccounts(tx, companyId, [INVENTORY_CONTROL_ACCOUNT_CODE]);
  switch (status?.state) {
    case "created":
    case "ok":
      return { id: status.accountId };
    case "reused_by_name":
      throw new InventoryControlAccountConflictError("name_taken", status.accountId);
    case "deleted":
      throw new InventoryControlAccountConflictError("deleted", status.accountId);
    case "type_differs":
      // A concurrent writer created it with another type: use it only when it is an asset.
      if (classifyAccountType(status.actualType) !== "asset") {
        throw new InventoryControlAccountConflictError("not_asset", status.accountId);
      }
      return { id: status.accountId };
    default:
      throw new Error(`Unable to create Inventory control account for company ${companyId}`);
  }
}

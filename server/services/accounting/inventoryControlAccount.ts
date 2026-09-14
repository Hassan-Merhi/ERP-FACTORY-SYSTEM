import { and, eq, ilike, isNull, or } from "drizzle-orm";
import { ledgerAccounts } from "@shared/schema";
import type { DatabaseOrTransaction } from "../../db";

/**
 * Resolve the inventory control ledger used by credit/debit-note accounting.
 *
 * Older code silently skipped the inventory leg when no matching account was
 * present, creating an unbalanced journal. This helper never returns null: it
 * reuses a live inventory asset, revives the canonical INVENTORY code when it
 * was soft-deleted, or creates the control account transactionally.
 */
export async function getOrCreateInventoryControlAccount(
  tx: DatabaseOrTransaction,
  companyId: number
): Promise<{ id: number }> {
  const [liveByMeaning] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        isNull(ledgerAccounts.deletedAt),
        or(
          eq(ledgerAccounts.code, "INVENTORY"),
          ilike(ledgerAccounts.name, "%inventory%"),
          ilike(ledgerAccounts.name, "%stock in hand%"),
          ilike(ledgerAccounts.name, "%stock on hand%")
        )
      )
    )
    .limit(1);
  if (liveByMeaning) return liveByMeaning;

  const [canonicalByCode] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, companyId), eq(ledgerAccounts.code, "INVENTORY")))
    .limit(1);

  if (canonicalByCode) {
    const [revived] = await tx
      .update(ledgerAccounts)
      .set({
        name: "Inventory",
        accountType: "Asset",
        subType: "Current Asset",
        active: true,
        isHidden: false,
        deletedAt: null,
      })
      .where(eq(ledgerAccounts.id, canonicalByCode.id))
      .returning({ id: ledgerAccounts.id });
    if (revived) return revived;
  }

  const [created] = await tx
    .insert(ledgerAccounts)
    .values({
      companyId,
      code: "INVENTORY",
      name: "Inventory",
      accountType: "Asset",
      subType: "Current Asset",
      openingBalance: "0",
      openingBalanceSide: "Dr",
      active: true,
      isHidden: false,
    })
    .returning({ id: ledgerAccounts.id });

  if (!created) throw new Error(`Unable to create Inventory control account for company ${companyId}`);
  return created;
}

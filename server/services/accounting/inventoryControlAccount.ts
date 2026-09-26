import { and, eq, ilike, inArray, isNull, or } from "drizzle-orm";
import { ledgerAccounts } from "@shared/schema";
import type { DatabaseOrTransaction } from "../../db";

/**
 * Resolve the inventory control ledger used by credit/debit-note accounting.
 *
 * Canonical INVENTORY is a balance-sheet asset, never an operating expense.
 * Older companies may still have a live INVENTORY row that was created as an
 * Indirect Expense. Normalize that row before reusing it so future returns do
 * not keep flowing through the indirect-expense section.
 */
export async function getOrCreateInventoryControlAccount(
  tx: DatabaseOrTransaction,
  companyId: number
): Promise<{ id: number }> {
  const [liveCanonical] = await tx
    .select({
      id: ledgerAccounts.id,
      name: ledgerAccounts.name,
      accountType: ledgerAccounts.accountType,
      subType: ledgerAccounts.subType,
      active: ledgerAccounts.active,
      isHidden: ledgerAccounts.isHidden,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        eq(ledgerAccounts.code, "INVENTORY"),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .limit(1);

  if (liveCanonical) {
    const needsNormalization =
      liveCanonical.accountType !== "Asset" ||
      liveCanonical.subType !== "Current Asset" ||
      !liveCanonical.active ||
      liveCanonical.isHidden ||
      liveCanonical.name.trim().toLowerCase() === "credit note - customer return";

    if (!needsNormalization) return { id: liveCanonical.id };

    const [normalized] = await tx
      .update(ledgerAccounts)
      .set({
        name:
          liveCanonical.name.trim().toLowerCase() === "credit note - customer return"
            ? "Inventory"
            : liveCanonical.name,
        accountType: "Asset",
        subType: "Current Asset",
        active: true,
        isHidden: false,
      })
      .where(eq(ledgerAccounts.id, liveCanonical.id))
      .returning({ id: ledgerAccounts.id });

    if (normalized) return normalized;
  }

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

  const [liveByMeaning] = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        isNull(ledgerAccounts.deletedAt),
        inArray(ledgerAccounts.accountType, ["Asset", "Current Asset"]),
        or(
          ilike(ledgerAccounts.name, "%inventory%"),
          ilike(ledgerAccounts.name, "%stock in hand%"),
          ilike(ledgerAccounts.name, "%stock on hand%")
        )
      )
    )
    .limit(1);
  if (liveByMeaning) return liveByMeaning;

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

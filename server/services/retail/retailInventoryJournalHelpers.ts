// Extracted from ./retailInventoryJournal.ts
import type Decimal from "decimal.js";
import { and, eq } from "drizzle-orm";
import { retailVariantInventory } from "@shared/schema";
import { type DbTransaction } from "../../db";
import { MoneyDecimal, toMoney } from "../../lib/money";
import { type RetailJournalActor } from "./retailLedgerPosting";

export interface RetailStockKey {
  variantId: number;
  locationId: number;
}

export type RetailStockJournalKind =
  "receipt" | "intake" | "import" | "product" | "adjustment" | "transfer" | "return" | "cancel" | "count";

export const keyOf = (key: RetailStockKey) => `${key.variantId}:${key.locationId}`;

export async function rowValues(tx: DbTransaction, companyId: number, keys: RetailStockKey[]) {
  const values = new Map<string, Decimal>();
  for (const key of keys) {
    const [row] = await tx
      .select({ quantity: retailVariantInventory.quantity, averageCost: retailVariantInventory.averageCost })
      .from(retailVariantInventory)
      .where(
        and(
          eq(retailVariantInventory.companyId, companyId),
          eq(retailVariantInventory.variantId, key.variantId),
          eq(retailVariantInventory.locationId, key.locationId)
        )
      )
      .limit(1);
    values.set(keyOf(key), row ? toMoney(row.quantity).times(toMoney(row.averageCost)) : new MoneyDecimal(0));
  }
  return values;
}

export interface RetailStockValueTracker {
  /** Takes the value of more rows before the writer changes them (rows already taken are kept). */
  include(keys: RetailStockKey[]): Promise<void>;
  /**
   * Journals the value the writer moved since the tracker was taken. `contra`
   * lines are signed (debit positive): a receipt credits RETAIL-GRNI with the
   * purchase value. `alreadyDebited` is what another journal of the same
   * document already put on the inventory account (a refund's restored
   * cost). The rest goes to RETAIL-INVENTORY-ADJUSTMENT. Null before the
   * opening, or when nothing moved.
   */
  post(input: {
    kind: RetailStockJournalKind;
    sourceId: string | number;
    description: string;
    actor: RetailJournalActor;
    contra?: { accountCode: string; amount: Decimal; narration: string }[];
    alreadyDebited?: Decimal;
  }): Promise<number | null>;
}

export interface RetailInventoryReconciliation {
  companyId: number;
  applicable: boolean;
  opening: { openingDate: string; voucherId: number | null } | null;
  inventoryAccountIds: number[];
  ledger: string;
  subLedger: string;
  difference: string;
  stockRows: number;
}

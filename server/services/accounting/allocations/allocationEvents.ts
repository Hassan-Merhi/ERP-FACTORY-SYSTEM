/**
 * Open-item allocation events (accounting audit phase 25, AR-4).
 *
 * The allocation service (allocationService.ts) calls these in the
 * transaction that writes the allocation row, so whatever a listener posts
 * (phase 24, M6: the realized FX gain/loss of a settlement) commits or rolls
 * back with the allocation itself.
 *
 * The defaults do nothing. Phase 24 plugs realized FX in here (or through
 * `registerAllocationListener`); a listener throws to refuse the allocation
 * (the whole transaction rolls back).
 */
import type { DbTransaction } from "../../../db";

export type AllocationPartyKind = "customer" | "supplier" | "employee" | "factorySupplier";

export interface AllocationEvent {
  companyId: number;
  allocationId: number;
  partyKind: AllocationPartyKind;
  partyId: number;
  /** The item that raised what is owed; null = the party's master opening. */
  invoiceVoucherId: number | null;
  /** The settling item (receipt, payment, credit/debit note, advance); null = the master opening. */
  paymentVoucherId: number | null;
  /** Book amount settled (2 dp string), in `currency`. */
  amount: string;
  /** The company's base (book) currency. */
  currency: string;
  method: "auto_fifo" | "manual" | "note";
}

export interface AllocationListener {
  /** A new allocation row was written. */
  posted?: (tx: DbTransaction, event: AllocationEvent) => Promise<void>;
  /** An allocation row was released (manual re-allocation or a source that changed). */
  released?: (tx: DbTransaction, event: AllocationEvent & { releaseReason: string }) => Promise<void>;
}

const listeners: AllocationListener[] = [];

/** Adds a listener (phase 24 realized FX); returns a function that removes it (tests). */
export function registerAllocationListener(listener: AllocationListener): () => void {
  listeners.push(listener);
  return () => {
    const index = listeners.indexOf(listener);
    if (index >= 0) listeners.splice(index, 1);
  };
}

/** Called once per new allocation row, in its transaction. */
export async function onAllocationPostedTx(tx: DbTransaction, event: AllocationEvent): Promise<void> {
  for (const listener of listeners) {
    if (listener.posted) await listener.posted(tx, event);
  }
}

/** Called once per released allocation row, in its transaction. */
export async function onAllocationReleasedTx(
  tx: DbTransaction,
  event: AllocationEvent & { releaseReason: string }
): Promise<void> {
  for (const listener of listeners) {
    if (listener.released) await listener.released(tx, event);
  }
}

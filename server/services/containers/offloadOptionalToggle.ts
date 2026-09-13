/**
 * Suspending and restoring a container offload.
 *
 * `POST /api/offloads/:id/toggle-optional` flips an offload between active and
 * optional. Both directions are real financial and stock effects: suspending
 * removes the offloaded quantity from inventory at the exact value it was added
 * with and marks the offload's charge vouchers optional; restoring adds the
 * quantity back and reactivates them.
 *
 * The route used to decide the target state, generate a random operation id, and
 * run the whole effect set from a pre-transaction read. Two simultaneous
 * requests — a double-click, a proxy retry, an offline replay — both read
 * `optional = false`, both removed the stock, and both journaled a movement,
 * because the random operation id made every attempt look like a brand-new
 * movement to the canonical journal. The offload ended up suspended once on the
 * record and twice in inventory.
 *
 * The effect set is therefore transaction-owned, owned by one writer at a time,
 * and state-guarded:
 *
 * 1. A transaction-scoped advisory lock makes the toggle single-writer. An
 *    overlapping request is rejected with 409 OFFLOAD_TOGGLE_IN_PROGRESS rather
 *    than admitted to read the state the first request just wrote and undo it —
 *    a toggle has no target state of its own, so admitting the second request is
 *    what turns one user action into two opposite stock movements.
 * 2. The target state is derived from the state the caller saw, so the request
 *    means "make this offload optional/active", not "flip whatever is current".
 * 3. The container row is locked first and the offload row second — the same
 *    order every other offload writer uses — so all offload work for one
 *    container is serialized instead of interleaved.
 * 4. The locked offload state is re-read. If it already matches the target, the
 *    request is a replay of work that committed: it reports the current state
 *    and produces no stock, voucher, or container-status effect at all.
 *
 * A caller may additionally supply a stable request identity
 * (`X-Idempotency-Key` or `clientRequestId`), which the route wraps in the
 * durable financial-operation boundary so an identical retransmission replays
 * the recorded response and the canonical stock journal sees one movement key.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, like, or, sql } from "drizzle-orm";

import { containerOffloadItems, containerOffloads, containers, vouchers } from "@shared/schema";
import type { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { adjustInventory, reverseInventoryByExactValue } from "../../inventoryHelper";
import { createDatabaseStockMovementAdapter } from "../inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../inventory/stockMovementIntegrityService";

/** The transaction handle drizzle passes to a `db.transaction` callback. */
export type OffloadOptionalToggleTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export class OffloadOptionalToggleError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = "OffloadOptionalToggleError";
    this.status = status;
    this.code = code;
  }
}

export interface OffloadOptionalToggleInput {
  companyId: number;
  offloadId: number;
  /**
   * The state the caller asked for. The UI button is explicit — Suspend or
   * Restore — so a caller that states its intent makes a retransmission
   * recognizable: a request whose target is already the current state is a
   * replay, not a second toggle in the opposite direction. Omitted by legacy
   * callers, which keep the pure "flip what I saw" toggle semantics.
   */
  requestedOptional?: boolean | null;
  /** Stable caller identity when one was supplied; otherwise a per-request id. */
  requestId?: string | null;
  actorUserId?: string | null;
  actorUsername?: string | null;
}

export interface OffloadOptionalToggleOutcome {
  optional: boolean;
  /** True when the locked state already matched the requested target. */
  replayed: boolean;
  message: string;
}

const OFFLOAD_VOUCHER_PREFIXES = ["DUTY", "OFFICE", "TRANS", "XFER", "CHG"] as const;

function suspendMessage(): string {
  return "Offload suspended — stock removed, vouchers set to optional, container moved back to OTW.";
}

function restoreMessage(): string {
  return "Offload restored — stock re-added, vouchers made active, container marked OFFLOADED.";
}

/**
 * Applies the toggle inside the caller's transaction and returns the resulting
 * state. Every read that decides an effect happens after the rows are locked.
 */
export async function applyOffloadOptionalToggleTx(
  tx: OffloadOptionalToggleTransaction,
  input: OffloadOptionalToggleInput
): Promise<OffloadOptionalToggleOutcome> {
  const { companyId, offloadId } = input;

  // The state the caller is reacting to. Read before the row lock so a request
  // without an explicit target keeps the meaning the UI showed.
  const [requested] = await tx
    .select({
      containerId: containerOffloads.containerId,
      optional: containerOffloads.optional,
      companyId: containers.companyId,
    })
    .from(containerOffloads)
    .innerJoin(containers, eq(containerOffloads.containerId, containers.id))
    .where(eq(containerOffloads.id, offloadId))
    .limit(1);

  if (!requested) {
    throw new OffloadOptionalToggleError("Offload not found", 404, "OFFLOAD_NOT_FOUND");
  }
  if (requested.companyId !== companyId) {
    throw new OffloadOptionalToggleError("No access to this company", 403, "COMPANY_ACCESS_DENIED");
  }

  const targetOptional = input.requestedOptional == null ? !requested.optional : Boolean(input.requestedOptional);

  if (requested.optional === targetOptional) {
    // The caller asked for the state the offload is already in. That is a
    // retransmission of work which committed, so it is reported rather than
    // executed again — no lock, no stock movement, no voucher flip.
    return {
      optional: targetOptional,
      replayed: true,
      message: targetOptional ? suspendMessage() : restoreMessage(),
    };
  }

  // Ownership gate for the requests that do have work to do. Without it two
  // overlapping toggles both read the pre-transition state and both apply it,
  // which is how one suspend removed the offloaded stock twice. Rejecting the
  // overlapping request is the same decision the Supplier Partner offload guard
  // makes with SP_OFFLOAD_IN_PROGRESS.
  const lockRows = resultRows<{ locked: boolean }>(
    await tx.execute(
      sql`SELECT pg_try_advisory_xact_lock(hashtext(${`offload-optional-toggle:${companyId}:${offloadId}`})) AS locked`
    )
  );
  if (!lockRows[0]?.locked) {
    throw new OffloadOptionalToggleError(
      "This offload is already being updated. Wait for the first request to finish before retrying.",
      409,
      "OFFLOAD_TOGGLE_IN_PROGRESS"
    );
  }

  // Lock ordering is container → offload everywhere in the offload lifecycle, so
  // a concurrent offload, reversal, or toggle for the same container queues here
  // instead of interleaving its writes with this one.
  const [lockedContainer] = await tx
    .select({ id: containers.id, containerNumber: containers.containerNumber, status: containers.status })
    .from(containers)
    .where(and(eq(containers.id, requested.containerId), eq(containers.companyId, companyId)))
    .for("update");

  if (!lockedContainer) {
    throw new OffloadOptionalToggleError("Container not found", 404, "CONTAINER_NOT_FOUND");
  }

  const [lockedOffload] = await tx
    .select({
      id: containerOffloads.id,
      locationId: containerOffloads.locationId,
      optional: containerOffloads.optional,
      offloadedAt: containerOffloads.offloadedAt,
    })
    .from(containerOffloads)
    .where(and(eq(containerOffloads.id, offloadId), eq(containerOffloads.containerId, lockedContainer.id)))
    .for("update");

  if (!lockedOffload) {
    throw new OffloadOptionalToggleError("Offload not found", 404, "OFFLOAD_NOT_FOUND");
  }

  if (lockedOffload.optional === targetOptional) {
    // Another request already applied exactly this transition, or this is a
    // retransmission of a committed one. Reporting the state is the whole job:
    // repeating the stock and voucher effects is what doubled inventory.
    return {
      optional: targetOptional,
      replayed: true,
      message: targetOptional ? suspendMessage() : restoreMessage(),
    };
  }

  const offloadItems = await tx
    .select()
    .from(containerOffloadItems)
    .where(eq(containerOffloadItems.offloadId, offloadId));

  if (offloadItems.length === 0) {
    throw new OffloadOptionalToggleError(
      "No offload items found — cannot toggle optional status",
      400,
      "OFFLOAD_NO_ITEMS"
    );
  }

  // A caller-supplied identity makes the canonical movement key stable across a
  // retransmission; without one the state guard above is what makes a repeat
  // safe, and each genuine transition still journals separately.
  const operationId = input.requestId?.trim() || randomUUID();
  const occurredAt = new Date().toISOString();

  for (const item of offloadItems) {
    const qty = parseFloat(item.quantity);
    const value = parseFloat(item.totalValue);
    const rate = parseFloat(item.rate);

    if (targetOptional) {
      // Suspending: remove the stock that was added at offload.
      await reverseInventoryByExactValue(tx, lockedOffload.locationId, item.stockItemId, qty, value, companyId);
    } else {
      // Unsuspending: add the stock back at the original rate.
      await adjustInventory(tx, lockedOffload.locationId, item.stockItemId, qty, companyId, rate);
    }

    await postStockMovementTx(
      tx,
      {
        companyId,
        stockItemId: item.stockItemId,
        kind: "adjustment",
        quantity: String(Math.abs(qty)),
        unitCost: String(Math.max(rate || (qty !== 0 ? value / qty : 0), 0)),
        fromLocationId: targetOptional ? lockedOffload.locationId : undefined,
        toLocationId: targetOptional ? undefined : lockedOffload.locationId,
        occurredAt,
        source: {
          sourceType: targetOptional ? "offload_optional_suspend" : "offload_optional_restore",
          sourceId: String(offloadId),
          idempotencyKey: `offload-optional:${companyId}:${offloadId}:${operationId}:${item.id}`,
        },
        actor: {
          userId: input.actorUserId ?? undefined,
          username: input.actorUsername ?? undefined,
          reason: targetOptional ? "Suspend container offload" : "Restore container offload",
        },
        allowNegativeStock: true,
      },
      canonicalStockMovementAdapter
    );
  }

  // Flip every voucher the offload's charges created. The container number is the
  // only stable handle those numbers carry, so the prefix set is matched exactly
  // as the offload writer produced it.
  const containerNumber = lockedContainer.containerNumber;
  const offloadVouchers = await tx
    .select({ id: vouchers.id })
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, companyId),
        or(...OFFLOAD_VOUCHER_PREFIXES.map((prefix) => like(vouchers.voucherNumber, `${prefix}-${containerNumber}-%`)))
      )
    );

  if (offloadVouchers.length > 0) {
    await tx
      .update(vouchers)
      .set({ optional: targetOptional })
      .where(
        inArray(
          vouchers.id,
          offloadVouchers.map((voucher) => voucher.id)
        )
      );
  }

  await tx.update(containerOffloads).set({ optional: targetOptional }).where(eq(containerOffloads.id, offloadId));

  if (targetOptional) {
    // Suspending: the container returns to OTW only when no active offload is
    // left on it, so a second offload keeps the container marked as arrived.
    const remainingActive = await tx
      .select({ id: containerOffloads.id })
      .from(containerOffloads)
      .where(and(eq(containerOffloads.containerId, lockedContainer.id), eq(containerOffloads.optional, false)));

    if (remainingActive.length === 0) {
      await tx
        .update(containers)
        .set({ status: "OTW", offloadDate: null })
        .where(eq(containers.id, lockedContainer.id));
    }
  } else {
    // Unsuspending: the container is offloaded again, dated from this offload.
    const restoredDate =
      lockedOffload.offloadedAt instanceof Date
        ? lockedOffload.offloadedAt.toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0];
    await tx
      .update(containers)
      .set({ status: "OFFLOADED", offloadDate: restoredDate })
      .where(eq(containers.id, lockedContainer.id));
  }

  return {
    optional: targetOptional,
    replayed: false,
    message: targetOptional ? suspendMessage() : restoreMessage(),
  };
}

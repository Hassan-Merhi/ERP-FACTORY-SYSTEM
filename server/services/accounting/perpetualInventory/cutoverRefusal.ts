/**
 * Admin stock tools after the perpetual-inventory cut-over (wave 11).
 *
 * Owner decision: the tools that rewrite stock quantities or values with no
 * ledger counterpart (rebuild inventory, repair inventory values, fix sales
 * inventory, cost-price import, SP migration stock tools, stock-item cost
 * repairs, exact reversal of stock documents and their linked journals,
 * deactivating or deleting a location that holds stock, carrying closing
 * stock forward) stay available until a company's cut-over is applied and
 * refuse afterwards with 409 PERPETUAL_INVENTORY_ACTIVE: once the ledger
 * carries the stock, such a rewrite would leave the INVENTORY account and the
 * sub-ledger apart.
 *
 * The refusal applies from the moment the cut-over row exists, whatever the
 * date of the document the tool would touch: these tools rewrite the current
 * sub-ledger, which the ledger already carries.
 *
 * The message is one fixed English sentence so the client can translate it
 * (client/src/i18n/wave8ReleaseTranslations.part3.ts); the tool's name is in
 * `action`, not in the message.
 */
import type { Response } from "express";

import type { DatabaseOrTransaction } from "../../../db";
import { HttpError } from "../../../lib/httpHandlers";
import { getInventoryCutover } from "./cutover";
import { factoryBaleMirrorStockItemIds } from "./factoryValuation";

export const PERPETUAL_INVENTORY_ACTIVE = "PERPETUAL_INVENTORY_ACTIVE" as const;

export const PERPETUAL_INVENTORY_ACTIVE_MESSAGE =
  "This stock tool is not available after the company's perpetual inventory cut-over: it would change stock values without a matching journal.";

export interface InventoryCutoverRefusalBody {
  code: typeof PERPETUAL_INVENTORY_ACTIVE;
  message: string;
  /** The refused tool, for logs and support (not translated). */
  action: string;
  /** The company's cut-over date, YYYY-MM-DD. */
  effectiveFrom: string;
}

/** The 409 error a refused tool throws; routes send `body`. */
export class InventoryCutoverRefusalError extends HttpError {
  readonly code = PERPETUAL_INVENTORY_ACTIVE;
  constructor(readonly body: InventoryCutoverRefusalBody) {
    super(409, body.message);
    this.name = "InventoryCutoverRefusalError";
  }
}

/**
 * The refusal for an admin stock tool, or null when the company has no
 * cut-over yet (the tool may run).
 */
export async function inventoryCutoverRefusal(
  executor: DatabaseOrTransaction,
  companyId: number,
  actionLabel: string
): Promise<{ status: 409; body: InventoryCutoverRefusalBody } | null> {
  const cutover = await getInventoryCutover(executor, companyId);
  if (!cutover) return null;
  return {
    status: 409,
    body: {
      code: PERPETUAL_INVENTORY_ACTIVE,
      message: PERPETUAL_INVENTORY_ACTIVE_MESSAGE,
      action: actionLabel,
      effectiveFrom: cutover.effectiveFrom,
    },
  };
}

/**
 * Throws InventoryCutoverRefusalError when the company's cut-over is applied.
 * Call it inside the tool's transaction, before any write.
 */
export async function assertNoInventoryCutoverTx(
  executor: DatabaseOrTransaction,
  companyId: number,
  actionLabel: string
): Promise<void> {
  const refusal = await inventoryCutoverRefusal(executor, companyId, actionLabel);
  if (refusal) throw new InventoryCutoverRefusalError(refusal.body);
}

/** Sends the refusal when `error` is one; returns whether it did. */
export function sendInventoryCutoverRefusal(response: Response, error: unknown): boolean {
  if (!(error instanceof InventoryCutoverRefusalError)) return false;
  response.status(409).json(error.body);
  return true;
}

// ── ERP sale or transfer of a factory bale-mirror item (wave 11) ────────────
//
// After the cut-over the ERP bale-mirror stock items (factoryBaleMirrorStockItemIds)
// hold quantity only: the factory values those bales, and the perpetual
// INVENTORY account leaves them out. An ERP sale would post COGS at zero and a
// transfer would move no value, while the bale itself stays in factory stock,
// so both are refused (409) once the company's cut-over is applied; the bale
// is sold or moved in the factory. Before the cut-over they keep working.

export const FACTORY_BALE_MIRROR_STOCK = "FACTORY_BALE_MIRROR_STOCK" as const;

export const FACTORY_BALE_MIRROR_STOCK_MESSAGE =
  "This item mirrors factory bale stock: after the company's perpetual inventory cut-over it is sold and moved in the factory, not in the ERP.";

export interface BaleMirrorMovementRefusalBody {
  code: typeof FACTORY_BALE_MIRROR_STOCK;
  message: string;
  /** The refused movement (sale, transfer, ...), for logs and support (not translated). */
  action: string;
  /** The company's cut-over date, YYYY-MM-DD. */
  effectiveFrom: string;
  /** The bale-mirror stock items the request named. */
  stockItemIds: number[];
}

export class BaleMirrorMovementRefusalError extends HttpError {
  readonly code = FACTORY_BALE_MIRROR_STOCK;
  constructor(readonly body: BaleMirrorMovementRefusalBody) {
    super(409, body.message);
    this.name = "BaleMirrorMovementRefusalError";
  }
}

/**
 * The refusal for an ERP sale or transfer naming `stockItemIds`, or null when
 * the company has no cut-over or none of the items is a factory bale-mirror item.
 */
export async function baleMirrorMovementRefusal(
  executor: DatabaseOrTransaction,
  companyId: number,
  stockItemIds: Iterable<unknown>,
  actionLabel: string
): Promise<{ status: 409; body: BaleMirrorMovementRefusalBody } | null> {
  const ids = [...new Set([...stockItemIds].map(Number))].filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) return null;
  const cutover = await getInventoryCutover(executor, companyId);
  if (!cutover) return null;
  const mirror = await factoryBaleMirrorStockItemIds(executor, companyId);
  const refused = ids.filter((id) => mirror.has(id)).sort((a, b) => a - b);
  if (refused.length === 0) return null;
  return {
    status: 409,
    body: {
      code: FACTORY_BALE_MIRROR_STOCK,
      message: FACTORY_BALE_MIRROR_STOCK_MESSAGE,
      action: actionLabel,
      effectiveFrom: cutover.effectiveFrom,
      stockItemIds: refused,
    },
  };
}

/**
 * Throws BaleMirrorMovementRefusalError when baleMirrorMovementRefusal refuses.
 * Call it before the movement writes anything (inside its transaction when it
 * has one).
 */
export async function assertNoBaleMirrorMovementTx(
  executor: DatabaseOrTransaction,
  companyId: number,
  stockItemIds: Iterable<unknown>,
  actionLabel: string
): Promise<void> {
  const refusal = await baleMirrorMovementRefusal(executor, companyId, stockItemIds, actionLabel);
  if (refusal) throw new BaleMirrorMovementRefusalError(refusal.body);
}

/** Sends a bale-mirror refusal when `error` is one; returns whether it did. */
export function sendBaleMirrorMovementRefusal(response: Response, error: unknown): boolean {
  if (!(error instanceof BaleMirrorMovementRefusalError)) return false;
  response.status(409).json(error.body);
  return true;
}

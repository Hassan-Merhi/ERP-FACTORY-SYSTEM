/**
 * Which bale status changes the generic status routes may make (accounting
 * audit phase 19 C, F3).
 *
 * `PATCH /api/factory/bales/:id/status`, `PATCH /api/factory/bales/bulk-status`
 * and `DELETE /api/factory/bales/:id` let a stock-entry user set SOLD,
 * IN_STOCK or DELETED with no value event, no invoice and no cut-over check;
 * finished goods drifted into production variance unseen.
 *
 * The factory valuation (`factoryValuation.ts`) values a bale by its status:
 *   - PENDING_PRESSING                                → work in progress (FACTORY_WIP)
 *   - IN_STOCK, RESERVED_FOR_ORDER, RESERVED_FOR_DISPATCH → finished goods
 *   - every other status                              → not factory stock
 *
 * A change is value-neutral only when the bale stays in the same class:
 * between the finished-goods statuses, or between the pre-stock statuses that
 * carry no value (LABEL_PRINTED, PRESSED, RESERVED). Everything else changes
 * the stock value or a stock account, and has its own flow:
 *   - into or out of SOLD / DISPATCHED: the customer order, invoice and dispatch;
 *   - into REMOVED / DELETED (or back): Stock Removal (waste write-off, audited
 *     value event) and its restore;
 *   - REPACKED: the repack action;
 *   - PENDING_PRESSING ↔ finished goods: the pressing batch (finalize); WIP and
 *     finished goods are separate accounts;
 *   - pre-stock ↔ valued: stock entry.
 * Deleting a bale is allowed here only for a pre-stock bale (no value).
 */
import { HttpError } from "../../lib/httpHandlers";

export const FINISHED_GOODS_BALE_STATUSES = ["IN_STOCK", "RESERVED_FOR_ORDER", "RESERVED_FOR_DISPATCH"] as const;
export const PRE_STOCK_BALE_STATUSES = ["LABEL_PRINTED", "PRESSED", "RESERVED"] as const;

export type BaleValueClass = "finished" | "wip" | "preStock" | "outOfStock";

export function baleValueClass(status: string | null | undefined): BaleValueClass {
  const value = String(status ?? "");
  if ((FINISHED_GOODS_BALE_STATUSES as readonly string[]).includes(value)) return "finished";
  if (value === "PENDING_PRESSING") return "wip";
  if ((PRE_STOCK_BALE_STATUSES as readonly string[]).includes(value)) return "preStock";
  return "outOfStock";
}

/** The statuses the generic status routes accept as a target. */
export const VALUE_NEUTRAL_TARGET_STATUSES = [
  ...FINISHED_GOODS_BALE_STATUSES,
  ...PRE_STOCK_BALE_STATUSES,
  "PENDING_PRESSING",
] as const;

/** The status vocabulary the routes accept at all (anything else is 400; an unknown status drops a bale out of stock). */
export const KNOWN_BALE_STATUSES = [
  "PENDING_PRESSING",
  "LABEL_PRINTED",
  "PRESSED",
  "IN_STOCK",
  "RESERVED",
  "RESERVED_FOR_ORDER",
  "RESERVED_FOR_DISPATCH",
  "SOLD",
  "REPACKED",
  "REMOVED",
  "DELETED",
  "DISPATCHED",
] as const;

export const FACTORY_BALE_STATUS_CHANGES_VALUE = "FACTORY_BALE_STATUS_CHANGES_VALUE" as const;
export const FACTORY_BALE_STATUS_CHANGES_VALUE_MESSAGE =
  "This bale status change would change the stock value. Sell bales through a customer order or invoice, remove or write them off through Stock Removal, and press them through a pressing batch.";
export const FACTORY_BALE_DELETE_CHANGES_VALUE_MESSAGE =
  "This bale is factory stock or has left it. Remove or write it off through Stock Removal instead of deleting it.";

export class BaleStatusChangeRefusal extends HttpError {
  readonly code = FACTORY_BALE_STATUS_CHANGES_VALUE;
  constructor(
    message: string,
    readonly refused: { id: number; from: string | null; to: string }[]
  ) {
    super(409, message);
    this.name = "BaleStatusChangeRefusal";
  }

  get body() {
    return { code: this.code, message: this.message, refused: this.refused };
  }
}

/** Whether a bale may move from `from` to `to` through the generic status routes. */
export function isValueNeutralBaleStatusChange(
  from: string | null | undefined,
  to: string,
  deletedAt?: Date | string | null
): boolean {
  if (deletedAt) return false;
  if (!(VALUE_NEUTRAL_TARGET_STATUSES as readonly string[]).includes(to)) return false;
  const fromClass = baleValueClass(from);
  if (fromClass === "outOfStock") return false;
  return fromClass === baleValueClass(to);
}

/** Whether a bale may be deleted through the generic delete route (a pre-stock bale only). */
export function isValueNeutralBaleDelete(status: string | null | undefined, deletedAt?: Date | string | null) {
  return !deletedAt && baleValueClass(status) === "preStock";
}

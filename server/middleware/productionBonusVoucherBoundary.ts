import type { Express, NextFunction, Request, Response } from "express";
import { sql } from "drizzle-orm";
import { db } from "../db";
import { firstRow } from "../lib/queryResult";

/**
 * Production bonus vouchers belong to their bonus record.
 *
 * A Production Targets bonus (daily, weekly or manual) is recorded in its own
 * table and posted as a voucher. Editing, deleting or reversing that voucher
 * from the ordinary voucher screens changed the books without the bonus
 * record (HMD manual payment 1: voucher edited 27.00 -> 26.00, register left
 * at 27.00). Corrections go through the Production Bonus page, whose reversal
 * keeps both in step. Owner decision, 2026-11-17.
 *
 * Runs before every voucher writer (see registerVoucherMutationBoundaries).
 * The bonus services post and reverse through the posting engine directly and
 * never cross this HTTP boundary.
 */
const BLOCK_CODE = "PRODUCTION_BONUS_VOUCHER_LOCKED";

/**
 * Every voucher or entry id a writer could read from this value. Writers parse
 * ids with Number() or parseInt(), which accept forms such as "16893.0" or
 * "16893abc"; the guard checks each id either would produce, so no spelling
 * of a bonus voucher's id slips past it.
 */
function candidateIds(value: unknown): number[] {
  const ids = new Set<number>();
  if (typeof value === "number") ids.add(value);
  if (typeof value === "string") {
    ids.add(Number(value));
    ids.add(Number.parseInt(value, 10));
  }
  return [...ids].filter((id) => Number.isSafeInteger(id) && id > 0);
}

async function anyProductionBonusVoucher(values: unknown[]): Promise<boolean> {
  for (const value of values) {
    for (const id of candidateIds(value)) if (await isProductionBonusVoucher(id)) return true;
  }
  return false;
}

async function anyProductionBonusVoucherEntry(values: unknown[]): Promise<boolean> {
  for (const value of values) {
    for (const entryId of candidateIds(value)) {
      const row = firstRow<{ voucherId: number | null }>(
        await db.execute(sql`SELECT voucher_id AS "voucherId" FROM voucher_entries WHERE id = ${entryId}`)
      );
      if (row?.voucherId != null && (await anyProductionBonusVoucher([Number(row.voucherId)]))) return true;
    }
  }
  return false;
}

/** True when the voucher is the payment or reversal voucher of any production bonus. */
export async function isProductionBonusVoucher(voucherId: number): Promise<boolean> {
  const row = firstRow<{ found: boolean }>(
    await db.execute(sql`
      SELECT EXISTS (
        SELECT 1 FROM factory_target_bonus_manual_payments
         WHERE payment_voucher_id = ${voucherId} OR reversal_voucher_id = ${voucherId}
        UNION ALL
        SELECT 1 FROM factory_target_bonus_payments
         WHERE payment_voucher_id = ${voucherId} OR reversal_voucher_id = ${voucherId}
        UNION ALL
        SELECT 1 FROM factory_target_bonus_weekly_payments
         WHERE payment_voucher_id = ${voucherId} OR reversal_voucher_id = ${voucherId}
      ) AS found
    `)
  );
  return row?.found === true;
}

const BLOCK_MESSAGE =
  "This voucher belongs to a production bonus. Reverse or correct it from the Production Bonus page so the bonus record stays in step.";

/** The refusal every bonus-voucher writer returns (also used by the Factory Daybook void). */
export function sendProductionBonusVoucherLocked(res: Response): Response {
  return res.status(409).json({ message: BLOCK_MESSAGE, code: BLOCK_CODE });
}

const block = sendProductionBonusVoucherLocked;

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function guard(check: (req: Request) => Promise<boolean>) {
  return async (req: Request, res: Response, next: NextFunction) => {
    if (READ_METHODS.has(req.method)) return next();
    try {
      if (await check(req)) return block(res);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

export function registerProductionBonusVoucherBoundary(app: Express): void {
  // Edit, delete, reverse, finalize and every typed update of one voucher.
  app.use(
    "/api/vouchers/:voucherId",
    guard((req) => anyProductionBonusVoucher([req.params.voucherId]))
  );

  // Reject the whole bulk delete if it includes a bonus voucher.
  app.post(
    "/api/vouchers/bulk-delete",
    guard((req) => anyProductionBonusVoucher(Array.isArray(req.body?.voucherIds) ? req.body.voucherIds : []))
  );

  // New lines on a bonus voucher.
  app.post(
    "/api/voucher-entries",
    guard((req) => anyProductionBonusVoucher([req.body?.voucherId]))
  );

  // Admin reclassification of existing lines: reject the whole transfer if any line is a bonus line.
  app.post(
    "/api/voucher-entries/transfer-account",
    guard((req) => anyProductionBonusVoucherEntry(Array.isArray(req.body?.entryIds) ? req.body.entryIds : []))
  );

  // Existing lines edited by their own id.
  app.use(
    "/api/voucher-entries/:entryId",
    guard((req) => anyProductionBonusVoucherEntry([req.params.entryId]))
  );
}

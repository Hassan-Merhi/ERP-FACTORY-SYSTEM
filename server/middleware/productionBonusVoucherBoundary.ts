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

function positiveId(value: unknown): number | null {
  const id = typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : value;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
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

async function isProductionBonusVoucherEntry(entryId: number): Promise<boolean> {
  const row = firstRow<{ voucherId: number | null }>(
    await db.execute(sql`SELECT voucher_id AS "voucherId" FROM voucher_entries WHERE id = ${entryId}`)
  );
  const voucherId = positiveId(row?.voucherId);
  return voucherId !== null && (await isProductionBonusVoucher(voucherId));
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
    guard(async (req) => {
      const id = positiveId(req.params.voucherId);
      return id !== null && (await isProductionBonusVoucher(id));
    })
  );

  // Reject the whole bulk delete if it includes a bonus voucher.
  app.post(
    "/api/vouchers/bulk-delete",
    guard(async (req) => {
      const ids = Array.isArray(req.body?.voucherIds) ? req.body.voucherIds : [];
      for (const value of ids) {
        const id = positiveId(value);
        if (id !== null && (await isProductionBonusVoucher(id))) return true;
      }
      return false;
    })
  );

  // New lines on a bonus voucher.
  app.post(
    "/api/voucher-entries",
    guard(async (req) => {
      const id = positiveId(req.body?.voucherId);
      return id !== null && (await isProductionBonusVoucher(id));
    })
  );

  // Existing lines edited by their own id.
  app.use(
    "/api/voucher-entries/:entryId",
    guard(async (req) => {
      const id = positiveId(req.params.entryId);
      return id !== null && (await isProductionBonusVoucherEntry(id));
    })
  );
}

import type { DbTransaction } from "../../db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { salesItems, vouchers } from "@shared/schema";

export interface ExistingPosSale {
  voucher: typeof vouchers.$inferSelect;
  saleItems: Array<typeof salesItems.$inferSelect>;
}

/**
 * Preserve the existing clientSaleId compatibility contract. Values are stored
 * as strings by PostgreSQL; null/undefined/empty values mean the caller did not
 * provide retry identity and therefore do not acquire an advisory lock.
 */
/** Mirrors the vouchers.client_sale_id column, which is sized for a UUID. */
export const POS_CLIENT_SALE_ID_MAX_LENGTH = 36;

export function normalizePosClientSaleId(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

export function buildPosSaleAdvisoryLockKey(companyId: number, clientSaleId: string): string {
  return `pos-sale:${companyId}:${clientSaleId}`;
}

/**
 * Serialize concurrent POS sale submissions that carry the same company-scoped
 * clientSaleId, then re-check for an already committed sale while still inside
 * the transaction. The PostgreSQL transaction lock is automatically released
 * on commit or rollback and requires no schema migration.
 */
export async function lockAndFindExistingPosSaleTx(input: {
  tx: DbTransaction;
  companyId: number;
  clientSaleId: unknown;
}): Promise<ExistingPosSale | null> {
  const clientSaleId = normalizePosClientSaleId(input.clientSaleId);
  if (!clientSaleId) return null;

  const lockKey = buildPosSaleAdvisoryLockKey(input.companyId, clientSaleId);
  await input.tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

  const [voucher] = await input.tx
    .select()
    .from(vouchers)
    .where(
      and(
        eq(vouchers.companyId, input.companyId),
        eq(vouchers.clientSaleId, clientSaleId),
        eq(vouchers.voucherType, "Sales"),
        isNull(vouchers.deletedAt)
      )
    )
    .limit(1);

  if (!voucher) return null;

  const saleItemsRows = await input.tx.select().from(salesItems).where(eq(salesItems.voucherId, voucher.id));

  return { voucher, saleItems: saleItemsRows };
}

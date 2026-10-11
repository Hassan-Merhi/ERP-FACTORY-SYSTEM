/**
 * Phase 22 (B): numbers of the rental guarantee vouchers.
 *
 * The guarantee family keeps its number shape `GUAR[-KIND]-<n>-<contractId>`:
 * the guarantee-to-statement duplicate guard and the balance repair's deposit
 * check find a contract's guarantee vouchers by it (`GUAR-%-<contractId>`).
 * `<n>` is the contract's next number of that kind (it was Date.now() plus a
 * random part), taken with the contract row locked, so it is deterministic
 * and never collides.
 */
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db";
import { resultRows } from "../../../lib/queryResult";

export type GuaranteeVoucherKind = "GUAR" | "GUAR-CASH" | "GUAR-RENT" | "GUAR-REFUND";

export async function nextGuaranteeVoucherNumberTx(
  tx: DbTransaction,
  input: { companyId: number; contractId: number; kind: GuaranteeVoucherKind }
): Promise<string> {
  await tx.execute(
    sql`SELECT id FROM property_contracts WHERE id = ${input.contractId} AND company_id = ${input.companyId} FOR UPDATE`
  );
  const pattern = `^${input.kind}-([0-9]+)-${input.contractId}$`;
  const [row] = resultRows<{ last: string | number | null }>(
    await tx.execute(sql`
      SELECT MAX(substring(voucher_number from ${pattern})::int) AS last
        FROM vouchers
       WHERE company_id = ${input.companyId} AND voucher_number ~ ${pattern}
    `)
  );
  const next = Number(row?.last ?? 0) + 1;
  return `${input.kind}-${next}-${input.contractId}`;
}

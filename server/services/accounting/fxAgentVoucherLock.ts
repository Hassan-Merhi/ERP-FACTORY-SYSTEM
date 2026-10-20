/**
 * Protect the native EUR movement and its posted journal from diverging.
 * Until a dedicated atomic wallet reversal exists, a generic voucher
 * correction/retirement MUST NOT remove or reverse FX wallet settlements.
 * Optional during rollout: on databases without the migration, do nothing.
 */
import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";

export const FX_AGENT_VOUCHER_LOCKED = "FX_AGENT_VOUCHER_LOCKED";
export const FX_AGENT_VOUCHER_LOCKED_MESSAGE =
  "This voucher belongs to an FX agent EUR payment. Its native EUR movement and USD posting must stay linked; ordinary voucher edit, reversal or deletion is blocked.";

export async function isFxAgentSettlementVoucherTx(
  tx: Pick<DatabaseOrTransaction, "execute">,
  companyId: number,
  voucherIds: readonly number[]
): Promise<boolean> {
  const ids = [...new Set(voucherIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  if (!ids.length) return false;
  const existence = resultRows<{ name: string | null }>(
    await tx.execute(sql`SELECT to_regclass('factory_fx_agent_wallet_operations')::text AS name`)
  )[0];
  if (!existence?.name) return false;
  const matches = resultRows<{ id: number }>(
    await tx.execute(sql`
      SELECT id FROM factory_fx_agent_wallet_operations
       WHERE company_id = ${companyId} AND voucher_id IN ${sql`(${sql.join(
         ids.map((id) => sql`${id}`),
         sql`, `
       )})`}
       LIMIT 1
    `)
  );
  return matches.length > 0;
}

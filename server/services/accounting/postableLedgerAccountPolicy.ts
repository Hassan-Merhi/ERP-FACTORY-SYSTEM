import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import { ledgerAccounts } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { PostingValidationError } from "./centralPostingEngine";

/**
 * A posting account is a leaf, not a chart-of-accounts group heading.
 * Some historical group headers were never marked sub_type='Group', so a
 * company-scoped live child also makes a ledger a group. Deleted children
 * must not disqualify an otherwise valid account.
 *
 * Do not apply this predicate to chart-of-accounts management or reporting:
 * those views must retain the complete account hierarchy.
 */
export function ledgerPostingLeafCondition(companyId: number): SQL {
  return sql`${ledgerAccounts.subType} IS DISTINCT FROM 'Group'
    AND NOT EXISTS (
      SELECT 1 FROM ledger_accounts AS posting_group_child
      WHERE posting_group_child.parent_id = ${ledgerAccounts.id}
        AND posting_group_child.company_id = ${companyId}
        AND posting_group_child.deleted_at IS NULL
    )`;
}

/**
 * Never trust a picker: posted ledger IDs may come from an old page, a
 * bookmarked client or a crafted API request. Validate inside the posting
 * transaction, before any voucher/entry is inserted. The central engine
 * calls this guard for ERP, Factory, POS and other engine-backed vouchers.
 */
export async function assertPostingLedgerLeavesTx(
  tx: DbTransaction,
  companyId: number,
  accountIds: readonly number[]
): Promise<void> {
  const ids = [...new Set(accountIds)].filter((id) => Number.isInteger(id) && id > 0);
  if (!ids.length) return;
  const valid = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        inArray(ledgerAccounts.id, ids),
        sql`${ledgerAccounts.deletedAt} IS NULL`,
        ledgerPostingLeafCondition(companyId)
      )
    );
  const validIds = new Set(valid.map((account) => account.id));
  const rejected = ids.filter((id) => !validIds.has(id));
  if (rejected.length) {
    throw new PostingValidationError(
      "POSTING_LEDGER_GROUP_NOT_ALLOWED",
      `Account ${rejected.join(", ")} is unavailable for posting. Choose a valid ledger leaf account, not a group heading.`
    );
  }
}

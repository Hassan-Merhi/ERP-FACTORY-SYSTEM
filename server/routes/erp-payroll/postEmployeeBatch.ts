/**
 * Phase 22 (B): one ERP payroll voucher (bulk bonus, bulk withdrawal, …)
 * through the central engine, with the employee balances moved from the posted
 * lines in the same transaction. A replayed request (same clientRequestId)
 * returns the voucher already posted and moves no balance again.
 */
import type { DbTransaction } from "../../db";
import { syncEmployeeBalancesFromEntries } from "../_helpers";
import {
  postErpVoucherTx,
  type ErpPostingResult,
  type ErpVoucherPostingInput,
} from "../../services/accounting/erpVoucherPosting";

export async function postEmployeeVoucherTx(
  tx: DbTransaction,
  input: ErpVoucherPostingInput
): Promise<ErpPostingResult> {
  const posted = await postErpVoucherTx(tx, input);
  if (!posted.replayed) {
    await syncEmployeeBalancesFromEntries(
      posted.entries.map((e) => ({
        ledgerAccountId: e.ledgerAccountId,
        employeeId: e.employeeId,
        debitAmount: e.debitAmount,
        creditAmount: e.creditAmount,
      })),
      input.companyId,
      false,
      tx
    );
  }
  return posted;
}

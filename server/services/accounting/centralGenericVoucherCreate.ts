/**
 * A protected generic voucher (USD, active, with a client request id), posted
 * the one way both the live route (POST /api/vouchers/with-entries, central
 * path) and the offline replay (server/edge/phase9SalesVoucherApply.ts) post
 * it: customer lines take the customer's linked ledger, the central posting
 * engine posts it (a repeat of the same client request id is a replay), and
 * employee balances and the audit row are written, all on the caller's
 * transaction.
 */
import { and, eq, inArray } from "drizzle-orm";
import { customers } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { buildVoucherChangesForCreate, logAudit, snapshotVoucherEntries } from "../../routes/_helpers";
import { PostingValidationError, postBalancedVoucherTx, type PostingActor } from "./centralPostingEngine";
import { createDatabasePostingDependencies } from "./databasePostingDependencies";
import { applyEmployeeBalanceDeltasTx } from "./employeeBalancePosting";
import { buildGenericVoucherPostingRequest } from "./genericVoucherPosting";

const postingDependencies = createDatabasePostingDependencies();
type CustomerLinkedLedgerRow = { id: number; ledgerAccountId: number | null };

/** Customer lines take the customer's linked ledger; a different ledger is refused. */
export async function resolveCustomerLinkedLedgersTx(input: {
  tx: DbTransaction;
  companyId: number;
  entries: Array<Record<string, unknown>>;
}): Promise<Array<Record<string, unknown>>> {
  const customerIds = [
    ...new Set(input.entries.map((entry) => Number(entry.customerId)).filter((id) => Number.isInteger(id) && id > 0)),
  ];

  if (customerIds.length === 0) return input.entries.map((entry) => ({ ...entry }));

  const rows: CustomerLinkedLedgerRow[] = await input.tx
    .select({ id: customers.id, ledgerAccountId: customers.ledgerAccountId })
    .from(customers)
    .where(and(eq(customers.companyId, input.companyId), inArray(customers.id, customerIds)));
  const customerById = new Map<number, CustomerLinkedLedgerRow>(rows.map((row) => [Number(row.id), row] as const));

  return input.entries.map((entry) => {
    const customerId = Number(entry.customerId);
    if (!Number.isInteger(customerId) || customerId <= 0) return { ...entry };

    const customer = customerById.get(customerId);
    if (!customer) {
      throw new PostingValidationError(
        "POSTING_TARGET_NOT_OWNED",
        `Customer ${customerId} not found in company ${input.companyId}`
      );
    }

    const linkedLedgerId = customer.ledgerAccountId == null ? null : Number(customer.ledgerAccountId);
    const suppliedLedgerId = entry.ledgerAccountId == null ? null : Number(entry.ledgerAccountId);
    if (linkedLedgerId && suppliedLedgerId && linkedLedgerId !== suppliedLedgerId) {
      throw new PostingValidationError(
        "POSTING_LINKED_LEDGER_MISMATCH",
        `Customer ${customerId} is linked to ledger ${linkedLedgerId}, but the entry specifies ledger ${suppliedLedgerId}`
      );
    }

    return {
      ...entry,
      ...(linkedLedgerId ? { ledgerAccountId: linkedLedgerId } : {}),
    };
  });
}

export async function postCentralGenericVoucherTx(
  tx: DbTransaction,
  input: {
    companyId: number;
    clientRequestId: unknown;
    voucher: Record<string, unknown>;
    entries: Array<Record<string, unknown>>;
    exchangeRate: string | null;
    actor: PostingActor & { userId: string; username: string };
  }
) {
  const resolvedEntries = await resolveCustomerLinkedLedgersTx({
    tx,
    companyId: input.companyId,
    entries: input.entries,
  });
  const built = buildGenericVoucherPostingRequest({
    companyId: input.companyId,
    clientRequestId: input.clientRequestId,
    // Phase 22 (B), PE8: a form's display number is not the voucher number;
    // the engine allocates the gapless one.
    voucher: { ...input.voucher, voucherNumber: undefined },
    entries: resolvedEntries,
    exchangeRate: input.exchangeRate,
    actor: input.actor,
  });

  const posted = await postBalancedVoucherTx(tx, built.request, postingDependencies);

  if (!posted.replayed) {
    await applyEmployeeBalanceDeltasTx({ tx, companyId: input.companyId, entries: posted.entries });
    // Wave 16 (B): audited in the posting transaction; an audit failure rolls
    // the voucher back.
    const entrySnapshot = await snapshotVoucherEntries(posted.entries, tx);
    await logAudit(
      {
        userId: input.actor.userId,
        username: input.actor.username,
        companyId: input.companyId,
        action: "create",
        tableName: "vouchers",
        recordId: posted.voucher.id,
        recordIdentifier: posted.voucher.voucherNumber,
        changes: buildVoucherChangesForCreate(posted.voucher, entrySnapshot),
      },
      tx
    );
  }
  return { posted, clientRequestId: built.clientRequestId };
}

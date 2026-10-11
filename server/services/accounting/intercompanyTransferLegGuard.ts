/**
 * Intercompany transfer legs are not edited through the generic voucher
 * editors (accounting audit phase 19 C, MC-2; decision).
 *
 * An intercompany transfer is two vouchers, one in each company, and the
 * `inter_company_transfers` row linking them with the amount and the date.
 * Before: the with-entries editor and the legacy journal PATCH (which edits
 * Payment and Receipt vouchers) rescaled the other company's voucher after
 * their own commit, outside a transaction, hiding any failure; only debit and
 * credit were scaled (base and transaction_* amounts untouched, so a non-USD
 * leg was misstated), each line rounded on its own (the leg could stop
 * balancing), the link's amount and date were never updated, and the editor's
 * access to the other company was not checked. The Payment/Receipt editor
 * and the single-line editors changed one leg and left the other as it was.
 *
 * Decision: refuse, rather than mirror. A Payment/Receipt leg carries a bank or
 * cash line and a counterpart account, each company may book it in its own
 * currency and rate, and the generic editors may change a leg's shape
 * (accounts, number of lines), which no rescale of the other leg can follow.
 * The safe correction is reverse-and-repost: delete the transfer (deleting
 * either leg removes both vouchers and the link, audited, in one
 * transaction) and record it again. The Journal editor
 * (centralJournalLifecycleRoute.ts, wave 18 B) keeps its in-transaction,
 * Decimal, normalized counterpart rescale with the access check, unchanged.
 *
 * Every generic edit path of a voucher named by an `inter_company_transfers`
 * row calls `assertNotIntercompanyTransferLeg` before writing: PUT
 * /api/vouchers/:id/with-entries, PATCH /api/vouchers/:id/journal (legacy,
 * non-Journal or draft), PATCH /api/vouchers/:id/payment-receipt (central and
 * legacy), PATCH /api/vouchers/:id when it changes the date, amount or lines,
 * PATCH /api/vouchers/:id/optional when it suspends or activates the leg, and
 * the amount edit of PATCH /api/voucher-entries/:id. Refused with 409
 * INTERCOMPANY_TRANSFER_LEG_EDIT_REFUSED; nothing is written.
 */
import { eq, or } from "drizzle-orm";
import { interCompanyTransfers } from "@shared/schema";

import { db, type DatabaseOrTransaction } from "../../db";
import { HttpError } from "../../lib/httpError";

export const INTERCOMPANY_TRANSFER_LEG_EDIT_REFUSED = "INTERCOMPANY_TRANSFER_LEG_EDIT_REFUSED" as const;
export const INTERCOMPANY_TRANSFER_LEG_EDIT_REFUSED_MESSAGE =
  "This voucher is one side of an intercompany transfer. It cannot be edited here: delete the transfer (both companies' vouchers are removed together) and record it again.";

export class IntercompanyTransferLegEditRefused extends HttpError {
  readonly code = INTERCOMPANY_TRANSFER_LEG_EDIT_REFUSED;
  constructor(
    readonly voucherId: number,
    readonly transferId: number
  ) {
    super(409, INTERCOMPANY_TRANSFER_LEG_EDIT_REFUSED_MESSAGE);
    this.name = "IntercompanyTransferLegEditRefused";
  }

  get body() {
    return { code: this.code, message: this.message, voucherId: this.voucherId, transferId: this.transferId };
  }
}

/** The transfer naming the voucher as either leg, or null. */
export async function intercompanyTransferOfVoucher(
  voucherId: number,
  executor: DatabaseOrTransaction = db
): Promise<{ id: number } | null> {
  const [transfer] = await executor
    .select({ id: interCompanyTransfers.id })
    .from(interCompanyTransfers)
    .where(or(eq(interCompanyTransfers.fromVoucherId, voucherId), eq(interCompanyTransfers.toVoucherId, voucherId)))
    .limit(1);
  return transfer ?? null;
}

/** Throws IntercompanyTransferLegEditRefused (409) when the voucher is a transfer leg. */
export async function assertNotIntercompanyTransferLeg(
  voucherId: number,
  executor: DatabaseOrTransaction = db
): Promise<void> {
  const transfer = await intercompanyTransferOfVoucher(voucherId, executor);
  if (transfer) throw new IntercompanyTransferLegEditRefused(voucherId, transfer.id);
}

/** Sends the 409 when `error` is the refusal; returns whether it did. */
export function sendIntercompanyTransferLegRefusal(
  response: { status: (code: number) => { json: (body: unknown) => unknown } },
  error: unknown
): boolean {
  if (!(error instanceof IntercompanyTransferLegEditRefused)) return false;
  response.status(409).json(error.body);
  return true;
}

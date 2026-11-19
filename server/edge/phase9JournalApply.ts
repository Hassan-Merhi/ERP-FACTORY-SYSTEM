/**
 * Full offline mode: cloud apply handler for `voucher.journal.v1`, a Journal
 * voucher entered offline on a PC.
 *
 * Posts the journal through the same service as the live route
 * (postJournalVoucherTx), on the SAME transaction as the receipt, with a
 * source id derived from the operation so a replay posts nothing. The rate is
 * the one the cloud approves for that date (ZMW rate policy), as for a live
 * journal. A refusal by the posting code (a closed period, an account missing
 * in the cloud, an unbalanced journal, no approved rate) is a conflict that can
 * only be rejected; the cloud keeps its state. The factory daybook row the live
 * route writes is written too, best effort, as there.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import type { PoolClient } from "pg";
import * as schema from "@shared/schema";
import type { DbTransaction } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import { MoneyDecimal, toMoney } from "../lib/money";
import { erpRateToDaybookFxRateToUsd } from "../services/accounting/currencyAmounts";
import { JournalVoucherInputError, postJournalVoucherTx } from "../services/accounting/journalVoucherPosting";
import { PostingValidationError } from "../services/accounting/postingValidationError";
import { ZambiaVoucherRateError } from "../services/accounting/zambiaVoucherRatePolicy";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import type { Phase9JournalInputs } from "./phase9JournalEnvelope.mjs";
import { throwIfClosedPeriod } from "./phase9ClosedPeriod";

type Queryable = Pick<PoolClient, "query">;

export interface Phase9JournalEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: {
    requestId: string;
    companyId: number;
    actorUserId: string;
    actorUsername: string;
    localVoucherId: number;
    journal: Phase9JournalInputs;
  };
  payloadSha256: string;
}

export interface Phase9JournalApplyResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const NOT_PERMITTED_ROLES = new Set(["View Only", "Create Only", "ERP Tester", "POS"]);

/** The live route is requireNonPOS; re-checked against CURRENT cloud access. */
async function authorize(client: Queryable, event: Phase9JournalEvent): Promise<void> {
  const access = await client.query(
    `SELECT u.active, r.role, r.pos_view_only
       FROM users u
       JOIN user_company_roles r ON r.user_id = u.id AND r.company_id = $2
      WHERE u.id = $1`,
    [event.actorUserId, event.companyId]
  );
  const row = access.rows[0];
  if (!row || row.active !== true) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ACCESS_REVOKED", { actorUserId: event.actorUserId });
  }
  if (row.pos_view_only === true || NOT_PERMITTED_ROLES.has(String(row.role))) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", {
      actorUserId: event.actorUserId,
      role: String(row.role),
    });
  }
}

/** The factory daybook row the live route writes; never fails the journal. */
async function writeFactoryDaybookTx(tx: DbTransaction, companyId: number, voucher: schema.Voucher): Promise<void> {
  try {
    await tx.transaction(async (sp) => {
      const [settings] = await sp
        .select({ id: schema.factorySettings.id })
        .from(schema.factorySettings)
        .where(eq(schema.factorySettings.companyId, companyId));
      if (!settings) return;
      const currency = voucher.currency || "USD";
      const baseTotal = toMoney(voucher.totalAmount);
      const rate = voucher.exchangeRate ? toMoney(voucher.exchangeRate) : new MoneyDecimal(1);
      const amountCurrency = currency !== "USD" && rate.greaterThan(0) ? baseTotal.times(rate) : baseTotal;
      await sp.insert(schema.factoryDaybookEntries).values({
        companyId,
        txDate: voucher.voucherDate,
        txType: "JOURNAL",
        referenceId: voucher.id,
        referenceTable: "vouchers",
        description: voucher.description || `Journal voucher #${voucher.voucherNumber}`,
        currencyCode: currency,
        amountCurrency: amountCurrency.toFixed(),
        fxRateToUsd: erpRateToDaybookFxRateToUsd(currency, "USD", voucher.exchangeRate),
        amountUsd: baseTotal.toFixed(),
        createdBy: null,
      });
    });
  } catch (error) {
    logger.error("Factory daybook write failed for an offline journal (non-fatal)", { error });
  }
}

async function apply(client: Queryable, event: Phase9JournalEvent): Promise<Phase9JournalApplyResult> {
  const j = event.payload.journal;
  const tx = drizzle(client as PoolClient, { schema }) as unknown as DbTransaction;
  try {
    const posted = await postJournalVoucherTx(tx, {
      companyId: event.companyId,
      voucherDate: j.voucherDate,
      entries: j.entries,
      notes: j.notes,
      optional: j.optional,
      currency: j.currency,
      exchangeRate: j.exchangeRate,
      effectiveDate: j.effectiveDate,
      sourceType: "offline-journal",
      sourceId: `${event.companyId}:edge-${event.operationId}`,
      postingActor: {
        userId: event.actorUserId,
        username: event.payload.actorUsername,
        reason: "Journal entered offline",
      },
      auditActor: { userId: event.actorUserId, username: event.payload.actorUsername },
    });
    if (!posted.replayed) await writeFactoryDaybookTx(tx, event.companyId, posted.voucher);
    return {
      outcome: posted.replayed ? "already-present" : "cloud-applied",
      cloudRef: Number(posted.voucher.id),
      businessDate: j.voucherDate,
    };
  } catch (error) {
    throwIfClosedPeriod(error);
    // Business refusals need a decision; anything else (a dropped connection,
    // a deadlock) is retried by the next apply run.
    const message = getErrorMessage(error);
    if (
      error instanceof PostingValidationError ||
      error instanceof JournalVoucherInputError ||
      error instanceof ZambiaVoucherRateError ||
      /not found in current company/i.test(message)
    ) {
      throw new Phase9EventConflict("PHASE9_JOURNAL_REFUSED", { message });
    }
    throw error;
  }
}

async function verify(
  client: Queryable,
  event: Phase9JournalEvent,
  result: Phase9JournalApplyResult
): Promise<boolean> {
  const check = await client.query(
    `SELECT 1 FROM vouchers
      WHERE id = $1 AND company_id = $2 AND voucher_type = 'Journal' AND voucher_date = $3::date`,
    [result.cloudRef, event.companyId, result.businessDate]
  );
  return check.rows.length === 1;
}

export const phase9JournalApplyHandler = Object.freeze({ authorize, apply, verify });

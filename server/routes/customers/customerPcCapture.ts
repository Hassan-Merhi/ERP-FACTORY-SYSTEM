/**
 * Full offline mode (Phase C1): a customer created on a PC in entry mode is
 * recorded for the cloud as `customer.create.v1`, in the customer's own
 * transaction, so the customer and its record commit or roll back together.
 * The PC's ids (the customer's, and the ledger account it opened for it) go
 * with it; the cloud creates its own and records which is which
 * (server/edge/phase9PcRecordMap.mjs). Anywhere else this does nothing.
 */
import { randomUUID } from "node:crypto";
import type { Customer } from "@shared/schema";
import type { DbTransaction } from "../../db";
import { capturePcLocalEnvelopeTx, isPcLocalId, pcLocalEntryMode } from "../../offline/pcLocal/pcCapture";
import { phase9CustomerCreateEnvelope } from "../../edge/phase9CustomerCreateEnvelope.mjs";
import { CustomerRouteError } from "./customerErrors";
import type { CustomerAuditActor } from "./customerRequestContext";

const textOrNull = (value: unknown) => (typeof value === "string" && value.trim() ? value : null);

export async function capturePcCustomerCreateTx(
  tx: DbTransaction,
  created: Customer,
  input: unknown,
  actor: CustomerAuditActor
): Promise<void> {
  if (!pcLocalEntryMode()) return;
  const requested = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const linkedLedger = Number(requested.ledgerAccountId);
  let envelope;
  try {
    envelope = phase9CustomerCreateEnvelope({
      requestId: randomUUID(),
      companyId: created.companyId,
      actorUserId: actor.userId,
      actorUsername: actor.username,
      businessDate: new Date().toISOString().slice(0, 10),
      localCustomerId: created.id,
      localLedgerAccountId:
        created.ledgerAccountId != null && isPcLocalId(created.ledgerAccountId) ? created.ledgerAccountId : null,
      customer: {
        legalName: created.legalName,
        phone: textOrNull(created.phone),
        openingBalance: String(created.openingBalance ?? "0"),
        openingBalanceSide: created.openingBalanceSide === "Cr" ? "Cr" : "Dr",
        active: created.active,
        statementNote: textOrNull(created.statementNote),
        paymentTermsDays: created.paymentTermsDays ?? null,
        ledgerAccountId: Number.isSafeInteger(linkedLedger) && linkedLedger > 0 ? linkedLedger : null,
      },
    });
  } catch {
    // Not something the cloud could replay (e.g. a negative opening, or a
    // ledger made on this PC): refused here, and the transaction rolls back.
    throw new CustomerRouteError(423, "OFFLINE_PC_LOCAL_CHANGE_NOT_SUPPORTED");
  }
  await capturePcLocalEnvelopeTx(tx, envelope, envelope.localCustomerId);
}

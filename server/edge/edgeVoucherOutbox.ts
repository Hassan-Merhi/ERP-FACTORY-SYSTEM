/**
 * Phase 4: append-only LAN voucher delivery evidence.
 * Recording the envelope in the same transaction as the voucher makes the
 * source durable; it does NOT authorize applying it against the cloud ledger.
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { DbTransaction } from "../db";
import { readFactoryEdgeConfiguration } from "./edgeRuntimePolicy.mjs";
import { EdgeRefusal } from "./edgeRefusal";
import { resultRows } from "../lib/queryResult";
import { PostingValidationError } from "../services/accounting/postingValidationError";
import { PHASE8_CASH_BOX_VOUCHER_TYPES, phase8CashBoxRefusal } from "./phase8CashBoxPolicy.mjs";

/** Stable object-key order for comparing a JSONB record after remote transport. */
export function canonicalEdgeVoucherPayload(voucher: unknown, entries: readonly unknown[]): string {
  const source: unknown = JSON.parse(JSON.stringify({ voucher, entries }));
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(sort);
    if (input !== null && typeof input === "object") {
      return Object.fromEntries(
        Object.entries(input)
          .sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([key, value]) => [key, sort(value)])
      );
    }
    return input;
  };
  return JSON.stringify(sort(source));
}

export interface EdgeVoucherEvidence {
  companyId: number;
  actorUserId: string;
  localVoucherId: number;
  requestId?: string | null;
  voucher: unknown;
  entries: readonly unknown[];
}

/**
 * Owner policy: offline Payment/Receipt vouchers move only the factory cash
 * box against expense/income accounts (phase8CashBoxPolicy). Checked against
 * the LAN database here so a non-compliant voucher rolls back now instead of
 * blocking the cloud replay later; the cloud re-checks at apply.
 */
async function assertCashBoxVoucherTx(tx: DbTransaction, evidence: EdgeVoucherEvidence): Promise<void> {
  const voucherType = String((evidence.voucher as { voucherType?: unknown } | null)?.voucherType ?? "");
  if (!PHASE8_CASH_BOX_VOUCHER_TYPES.includes(voucherType as "Payment" | "Receipt")) return;
  const entries = evidence.entries as Array<{ ledgerAccountId: number; debitAmount?: unknown; creditAmount?: unknown }>;
  const ids = [...new Set(entries.map((entry) => Number(entry.ledgerAccountId)))];
  const result = await tx.execute(sql`
    SELECT id, account_type FROM ledger_accounts
     WHERE company_id = ${evidence.companyId} AND id IN (${sql.join(
       ids.map((id) => sql`${id}`),
       sql`, `
     )})
  `);
  const types = new Map(
    resultRows<{ id: number; account_type: string }>(result).map((row) => [Number(row.id), String(row.account_type)])
  );
  const refusal = phase8CashBoxRefusal(voucherType, entries, types);
  if (refusal) {
    throw new PostingValidationError(
      refusal,
      "Offline payments and receipts may only move the factory cash box against expense or income accounts."
    );
  }
}

export async function captureEdgeVoucherTx(tx: DbTransaction, evidence: EdgeVoucherEvidence): Promise<void> {
  const config = readFactoryEdgeConfiguration();
  if (config.mode !== "lan" || !config.primary) return;
  if (
    !Number.isSafeInteger(evidence.companyId) ||
    evidence.companyId < 1 ||
    !Number.isSafeInteger(evidence.localVoucherId) ||
    evidence.localVoucherId < 1 ||
    !evidence.actorUserId
  ) {
    throw new EdgeRefusal("EDGE_OUTBOX_SCOPE_INVALID");
  }
  // Never invent a different operation ID after the voucher has posted:
  // a broken/missing request identity must roll back this SAME transaction.
  if (
    typeof evidence.requestId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(evidence.requestId)
  ) {
    throw new EdgeRefusal("EDGE_OUTBOX_OPERATION_ID_INVALID");
  }
  const operationId = evidence.requestId;
  await assertCashBoxVoucherTx(tx, evidence);
  const payload = canonicalEdgeVoucherPayload(evidence.voucher, evidence.entries);
  const hash = createHash("sha256").update(payload, "utf8").digest("hex");
  // Ordered captures serialize to commit in the same order as sequence
  // allocation. A future relay must still use acknowledgements, not simply
  // advance past unconfirmed rows.
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('factory-edge-voucher-outbox-order'))`);
  await tx.execute(sql`
    WITH next_sequence AS (
      INSERT INTO factory_edge_outbox_counter(site_id, last_sequence)
      VALUES (${config.siteId}::uuid, 1)
      ON CONFLICT (site_id)
        DO UPDATE SET last_sequence = factory_edge_outbox_counter.last_sequence + 1
      RETURNING last_sequence
    )
    INSERT INTO factory_edge_voucher_outbox
      (sequence, site_id, operation_id, company_id, actor_user_id,
       local_voucher_id, payload, payload_sha256)
    SELECT next_sequence.last_sequence, ${config.siteId}::uuid, ${operationId}::uuid,
      ${evidence.companyId}, ${evidence.actorUserId},
      ${evidence.localVoucherId}, ${payload}::jsonb, ${hash}
    FROM next_sequence
  `);
}

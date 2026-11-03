/**
 * Phase 9 cloud apply handler for `pos.sale-cancel.v1` (a POS sale cancelled,
 * i.e. its voucher deleted, on the factory LAN server).
 *
 * The cancellation runs through the same delete code as the live route
 * (deleteVoucherTx: stock and COGS reversal, balances, soft delete, audit) on
 * the SAME transaction as the Phase 9 receipt. The sale is found by its
 * client sale id (offline sales) or voucher id (pre-outage sales). A sale
 * that is missing or already cancelled in the cloud can only be rejected.
 * The operator tool refreshes the intercompany POS mirror for the date after
 * the apply commits.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import type { PoolClient } from "pg";
import * as schema from "@shared/schema";
import type { DbTransaction } from "../db";
import { deleteVoucherTx } from "../routes/voucher-entries/delete";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import type { Phase9PosSaleCancelEvidence } from "./phase9PosSaleEnvelope.mjs";

type Queryable = Pick<PoolClient, "query">;

export interface Phase9PosSaleCancelEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  payload: { kind: string } & { [K in keyof Phase9PosSaleCancelEvidence]: Phase9PosSaleCancelEvidence[K] };
  payloadSha256: string;
}

export interface Phase9PosSaleCancelApplyResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

/** The live route is Admin-only; re-checked against CURRENT cloud access. */
async function authorize(client: Queryable, event: Phase9PosSaleCancelEvent): Promise<void> {
  const access = await client.query(
    `SELECT u.active, r.role FROM users u
       JOIN user_company_roles r ON r.user_id = u.id AND r.company_id = $2
      WHERE u.id = $1`,
    [event.actorUserId, event.companyId]
  );
  const row = access.rows[0];
  if (!row || row.active !== true) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ACCESS_REVOKED", { actorUserId: event.actorUserId });
  }
  if (!["Admin", "Developer"].includes(String(row.role))) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", {
      actorUserId: event.actorUserId,
      role: String(row.role),
    });
  }
}

async function apply(client: Queryable, event: Phase9PosSaleCancelEvent): Promise<Phase9PosSaleCancelApplyResult> {
  const p = event.payload;
  const found = p.voucherRef.clientSaleId
    ? await client.query(
        "SELECT id, deleted_at FROM vouchers WHERE company_id = $1 AND client_sale_id = $2 AND voucher_type = 'Sales'",
        [event.companyId, p.voucherRef.clientSaleId]
      )
    : await client.query(
        "SELECT id, deleted_at FROM vouchers WHERE company_id = $1 AND id = $2 AND voucher_type = 'Sales'",
        [event.companyId, p.voucherRef.voucherId]
      );
  if (found.rows.length !== 1) {
    throw new Phase9EventConflict("PHASE9_POS_SALE_MISSING", { ...p.voucherRef });
  }
  if (found.rows[0].deleted_at !== null) {
    throw new Phase9EventConflict("PHASE9_POS_SALE_ALREADY_CANCELLED", { voucherId: Number(found.rows[0].id) });
  }
  const tx = drizzle(client as PoolClient, { schema }) as unknown as DbTransaction;
  const [voucher] = await tx
    .select()
    .from(schema.vouchers)
    .where(eq(schema.vouchers.id, Number(found.rows[0].id)))
    .limit(1);
  const actor = { userId: event.actorUserId, username: p.actorUsername };
  await deleteVoucherTx(tx, {
    companyId: event.companyId,
    voucher,
    occurredAt: new Date().toISOString(),
    asOfDate: p.businessDate,
    actor,
    retirementActor: actor,
  });
  return { outcome: "cloud-applied", cloudRef: voucher.id, businessDate: p.businessDate };
}

async function verify(
  client: Queryable,
  event: Phase9PosSaleCancelEvent,
  result: Phase9PosSaleCancelApplyResult
): Promise<boolean> {
  const check = await client.query(
    "SELECT 1 FROM vouchers WHERE id = $1 AND company_id = $2 AND deleted_at IS NOT NULL",
    [result.cloudRef, event.companyId]
  );
  return check.rows.length === 1;
}

export const phase9PosSaleCancelApplyHandler = Object.freeze({ authorize, apply, verify });

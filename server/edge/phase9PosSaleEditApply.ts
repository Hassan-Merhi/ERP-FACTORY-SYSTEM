/**
 * Phase 9 cloud apply handler for `pos.sale-edit.v1` (POS returns and sale
 * corrections recorded on the factory LAN server).
 *
 * The edit is replayed through the sale-edit core (applyPosSaleUpdateTx) on
 * the SAME transaction as the Phase 9 receipt. The sale is found by its
 * client sale id (offline sales) or its voucher id (sales made before the
 * outage, which share ids with the cloud). Lines that were already on the
 * sale are matched to the cloud's lines of the same item, in order, so they
 * keep their original cost. A replay that would take stock below zero is
 * held for an Admin/Developer approve/reject decision; a missing sale or any
 * other refusal by the edit core can only be rejected.
 */
import { drizzle } from "drizzle-orm/node-postgres";
import type { PoolClient } from "pg";
import * as schema from "@shared/schema";
import type { DbTransaction } from "../db";
import { getErrorMessage } from "../lib/httpHandlers";
import { fetchSpEditAccountingContext } from "../services/pos/edit/posEditSaleHelpers";
import { writePosSaleUpdateAuditTx } from "../services/pos/edit/posSaleUpdateAudit";
import { applyPosSaleUpdateTx } from "../services/pos/edit/updateSaleService";
import { Phase9EventConflict } from "./phase9CloudEventStore.mjs";
import { PHASE9_POS_NEGATIVE_CONFLICT, type Phase9PosSaleEditEvidence } from "./phase9PosSaleEnvelope.mjs";

type Queryable = Pick<PoolClient, "query">;

export interface Phase9PosSaleEditEvent {
  sequence: string;
  operationId: string;
  companyId: number;
  actorUserId: string;
  kind: string;
  localRef: number;
  // Mapped (not an interface) so it stays assignable to the store's payload record.
  payload: { kind: string } & { [K in keyof Phase9PosSaleEditEvidence]: Phase9PosSaleEditEvidence[K] };
  payloadSha256: string;
}

export interface Phase9PosSaleEditApplyResult {
  outcome: "cloud-applied" | "already-present";
  cloudRef: number;
  businessDate: string;
}

const READ_ONLY_ROLES = new Set(["View Only", "Create Only", "ERP Tester"]);

async function authorize(client: Queryable, event: Phase9PosSaleEditEvent): Promise<void> {
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
  if (row.pos_view_only === true || READ_ONLY_ROLES.has(String(row.role))) {
    throw new Phase9EventConflict("PHASE9_ACTOR_ROLE_NOT_PERMITTED", {
      actorUserId: event.actorUserId,
      role: String(row.role),
    });
  }
}

async function cloudVoucherId(client: Queryable, event: Phase9PosSaleEditEvent): Promise<number> {
  const { clientSaleId, voucherId } = event.payload.voucherRef;
  const found = clientSaleId
    ? await client.query(
        "SELECT id FROM vouchers WHERE company_id = $1 AND client_sale_id = $2 AND voucher_type = 'Sales'",
        [event.companyId, clientSaleId]
      )
    : await client.query("SELECT id FROM vouchers WHERE company_id = $1 AND id = $2 AND voucher_type = 'Sales'", [
        event.companyId,
        voucherId,
      ]);
  if (found.rows.length !== 1) {
    throw new Phase9EventConflict("PHASE9_POS_SALE_MISSING", { clientSaleId, voucherId });
  }
  return Number(found.rows[0].id);
}

async function apply(
  client: Queryable,
  event: Phase9PosSaleEditEvent,
  context: { readonly overrideConflicts: readonly string[] } = { overrideConflicts: [] }
): Promise<Phase9PosSaleEditApplyResult> {
  const p = event.payload;
  const voucherId = await cloudVoucherId(client, event);

  // Map lines that were already on the sale to the cloud's line ids.
  const cloudLines = await client.query("SELECT id, stock_item_id FROM sales_items WHERE voucher_id = $1 ORDER BY id", [
    voucherId,
  ]);
  const byItem = new Map<number, number[]>();
  for (const row of cloudLines.rows) {
    const list = byItem.get(Number(row.stock_item_id)) ?? [];
    list.push(Number(row.id));
    byItem.set(Number(row.stock_item_id), list);
  }
  const items = p.edit.items.map((line) => {
    const id = line.existing ? byItem.get(line.stockItemId)?.shift() : undefined;
    return {
      ...(id ? { id } : {}),
      stockItemId: line.stockItemId,
      quantity: line.quantity,
      sellingPrice: line.sellingPrice,
    };
  });

  const role = await client.query(
    "SELECT role, can_sell_negative_stock FROM user_company_roles WHERE user_id = $1 AND company_id = $2",
    [event.actorUserId, event.companyId]
  );
  const spContext = await fetchSpEditAccountingContext(event.companyId);
  if ("error" in spContext)
    throw new Phase9EventConflict("PHASE9_POS_EDIT_REFUSED", { status: spContext.error.status });
  const tx = drizzle(client as PoolClient, { schema }) as unknown as DbTransaction;
  const params = {
    voucherId,
    currentCompanyId: event.companyId,
    userId: event.actorUserId,
    username: p.actorUsername,
    userRole: role.rows[0]?.role ? String(role.rows[0].role) : undefined,
    canSellNegativeStock:
      role.rows[0]?.can_sell_negative_stock === true ||
      context.overrideConflicts.includes(PHASE9_POS_NEGATIVE_CONFLICT),
    body: {
      description: p.edit.description,
      items,
      paymentAccountType: p.edit.paymentAccountType,
      paymentAccountId: p.edit.paymentAccountId,
      isCreditSale: p.edit.isCreditSale,
      voucherDate: p.edit.voucherDate,
      locationId: p.edit.locationId,
    },
  };
  let result;
  try {
    result = await applyPosSaleUpdateTx(tx, params, spContext.context);
  } catch (error) {
    const message = getErrorMessage(error);
    if (/^Insufficient stock/i.test(message)) {
      throw new Phase9EventConflict(PHASE9_POS_NEGATIVE_CONFLICT, { message });
    }
    throw new Phase9EventConflict("PHASE9_POS_EDIT_REFUSED", { message });
  }
  if (result.error) {
    throw new Phase9EventConflict("PHASE9_POS_EDIT_REFUSED", {
      status: result.error.status,
      message: typeof result.error.body.message === "string" ? result.error.body.message : undefined,
    });
  }
  await writePosSaleUpdateAuditTx(
    tx,
    { voucherId, companyId: event.companyId, userId: event.actorUserId, username: p.actorUsername },
    result
  );
  return { outcome: "cloud-applied", cloudRef: voucherId, businessDate: p.businessDate };
}

async function verify(
  client: Queryable,
  event: Phase9PosSaleEditEvent,
  result: Phase9PosSaleEditApplyResult
): Promise<boolean> {
  const check = await client.query(
    "SELECT 1 FROM vouchers WHERE id = $1 AND company_id = $2 AND voucher_type = 'Sales'",
    [result.cloudRef, event.companyId]
  );
  return check.rows.length === 1;
}

export const phase9PosSaleEditApplyHandler = Object.freeze({ authorize, apply, verify });

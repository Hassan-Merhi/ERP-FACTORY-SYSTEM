/**
 * Full offline mode (Phase B2): applying an entry a PC made while offline.
 *
 * Exactly the browser offline apply path (exactly once, actor from the session,
 * changed replays refused, conflicts held), with one owner decision on top
 * (2026-11-17): stock sold twice while PCs were offline goes negative and is
 * flagged. When the only disagreement is that stock would go below zero, the
 * entry is applied anyway and one row is written to
 * offline_negative_stock_flags in the same transaction, for an Admin or
 * Developer to review and close. Flags may stay open at month end. Every other
 * conflict is still held for Admin/Developer approval.
 */
import type { PoolClient } from "pg";
import { pool } from "../../db";
import { PHASE9_POS_SALE_EDIT_KIND } from "../../edge/phase9PosSaleEnvelope.mjs";
import { pcPosSaleEditRefusal } from "./pcPosEditPolicy";
import { PHASE9_POS_NEGATIVE_CONFLICT } from "../../edge/phase9PosSaleEnvelope.mjs";
import { PHASE9_STOCK_NEGATIVE_CONFLICT } from "../../edge/phase9StockEnvelope.mjs";
import {
  applyBrowserOperation,
  type BrowserApplyResult,
  type BrowserOperationRequest,
  type BrowserReceipt,
} from "../browserSync/browserSyncApply";
import type { BrowserActor } from "../browserSync/browserOperationKinds";

export const PC_NEGATIVE_STOCK_CODES: readonly string[] = Object.freeze([
  PHASE9_STOCK_NEGATIVE_CONFLICT,
  PHASE9_POS_NEGATIVE_CONFLICT,
]);

export type PcApplyResult = BrowserApplyResult | { status: "applied"; receipt: BrowserReceipt; flagged: true };

async function insertFlag(
  client: PoolClient,
  actor: BrowserActor,
  request: BrowserOperationRequest,
  receipt: BrowserReceipt,
  code: string,
  detail: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO offline_negative_stock_flags
       (company_id, device_id, operation_id, kind, conflict_code, detail, cloud_ref, created_by)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5, $6::jsonb, $7, $8)
     ON CONFLICT (device_id, operation_id) DO NOTHING`,
    [
      actor.companyId,
      request.deviceId.toLowerCase(),
      request.operationId,
      request.kind,
      code,
      JSON.stringify(detail ?? {}),
      receipt.cloudRef,
      actor.userId,
    ]
  );
}

/**
 * Live-route rules a PC's own record must still meet in the cloud (the LAN
 * server enforced them before recording; a PC is the user's own claim). A
 * replay of an entry already applied is not re-judged.
 */
async function pcEnvelopeRefusal(actor: BrowserActor, request: BrowserOperationRequest) {
  if (request.envelope?.kind !== PHASE9_POS_SALE_EDIT_KIND) return null;
  const client = await pool.connect();
  try {
    const applied = await client.query(
      "SELECT 1 FROM factory_edge_applied_events WHERE site_id = $1::uuid AND operation_id = $2::uuid LIMIT 1",
      [request.deviceId.toLowerCase(), request.operationId.toLowerCase()]
    );
    if (applied.rows.length) return null;
    return await pcPosSaleEditRefusal(client, actor, request.envelope as Parameters<typeof pcPosSaleEditRefusal>[2]);
  } finally {
    client.release();
  }
}

export async function applyPcOperation(actor: BrowserActor, request: BrowserOperationRequest): Promise<PcApplyResult> {
  const refused = await pcEnvelopeRefusal(actor, request);
  if (refused) return { status: "conflict", code: refused.code, overridable: false, detail: refused.detail };
  const first = await applyBrowserOperation(actor, request, { allowEnvelope: true });
  if (first.status !== "conflict" || !first.overridable || !PC_NEGATIVE_STOCK_CODES.includes(first.code)) return first;
  const code = first.code;
  const second = await applyBrowserOperation(
    actor,
    { ...request, override: code },
    {
      allowEnvelope: true,
      preApprovedOverrides: [code],
      afterApply: (client, receipt) => insertFlag(client, actor, request, receipt, code, first.detail),
    }
  );
  return second.status === "applied" ? { ...second, flagged: true } : second;
}

export interface NegativeStockFlag {
  id: number;
  deviceId: string;
  operationId: string;
  kind: string;
  conflictCode: string;
  detail: Record<string, unknown>;
  cloudRef: number | null;
  createdBy: string;
  createdAt: string;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
}

type Queryable = Pick<PoolClient, "query">;

export async function listNegativeStockFlags(
  client: Queryable,
  companyId: number,
  status: "open" | "all"
): Promise<NegativeStockFlag[]> {
  const { rows } = await client.query(
    `SELECT id, device_id, operation_id, kind, conflict_code, detail, cloud_ref, created_by, created_at,
            resolved_at, resolved_by, resolution_note
       FROM offline_negative_stock_flags
      WHERE company_id = $1 AND ($2::boolean OR resolved_at IS NULL)
      ORDER BY created_at DESC, id DESC
      LIMIT 500`,
    [companyId, status === "all"]
  );
  return rows.map((r) => ({
    id: Number(r.id),
    deviceId: String(r.device_id),
    operationId: String(r.operation_id),
    kind: String(r.kind),
    conflictCode: String(r.conflict_code),
    detail: (r.detail as Record<string, unknown>) ?? {},
    cloudRef: r.cloud_ref == null ? null : Number(r.cloud_ref),
    createdBy: String(r.created_by),
    createdAt: new Date(r.created_at).toISOString(),
    resolvedAt: r.resolved_at ? new Date(r.resolved_at).toISOString() : null,
    resolvedBy: r.resolved_by == null ? null : String(r.resolved_by),
    resolutionNote: r.resolution_note == null ? null : String(r.resolution_note),
  }));
}

/** Closes an open flag of this company; false when there is none to close. */
export async function resolveNegativeStockFlag(
  client: Queryable,
  companyId: number,
  id: number,
  userId: string,
  note: string
): Promise<boolean> {
  const { rowCount } = await client.query(
    `UPDATE offline_negative_stock_flags
        SET resolved_at = now(), resolved_by = $3, resolution_note = $4
      WHERE company_id = $1 AND id = $2 AND resolved_at IS NULL`,
    [companyId, id, userId, note]
  );
  return (rowCount ?? 0) === 1;
}

/**
 * Per-company enablement of the automatic open-item allocation (phases 23–29
 * integration review of phase 25 AR-4 with phase 24 M6).
 *
 * The hourly FIFO run (allocationRun.ts) and the realized-FX listener
 * (fx/realizedFx.ts) would otherwise allocate every company's history and post
 * realized exchange differences on it right after deploy, with nobody having
 * reviewed it. So:
 *
 *   - a company is enabled only by the Owner's first allocation run
 *     (`POST /api/open-items/allocate` with `{ confirm: true, planHash }` from
 *     `GET /api/open-items/allocate/preview`); that run writes the marker row
 *     (`open_item_allocation_enablements`) in its own transaction;
 *   - the scheduled run does nothing for a company without the marker;
 *   - realized FX is posted automatically only for an allocation written in a
 *     later transaction than the enablement (`now() > enabled_at`) whose
 *     settlement (the later of its two documents) is dated on or after the
 *     enablement's business date; every other allocation's FX is left to the
 *     reviewed history tool (`/api/accounting/realized-fx/history/plan|apply`).
 *
 * No boot step and no scheduled step posts history.
 */
import { createHash } from "node:crypto";
import type Decimal from "decimal.js";
import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../../db";
import { MoneyDecimal } from "../../../lib/money";
import { companyBusinessDate } from "../companyBusinessDate";
import type { AllocationPartyKind } from "./allocationEvents";
import { planOpenItemAllocationsTx } from "./allocationService";
import { OPEN_ITEM_PARTY_KINDS } from "./openItems";

export const OPEN_ITEM_ENABLEMENT_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS open_item_allocation_enablements (
    company_id INTEGER PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
    enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    enabled_on DATE NOT NULL,
    enabled_by TEXT NOT NULL,
    plan_hash TEXT NOT NULL
  )`;

export interface AllocationEnablement {
  enabledAt: string;
  enabledOn: string;
  enabledBy: string;
  planHash: string;
}

export async function loadAllocationEnablement(
  executor: DatabaseOrTransaction,
  companyId: number
): Promise<AllocationEnablement | null> {
  const result = await executor.execute<
    { enabled_at: string; enabled_on: string; enabled_by: string; plan_hash: string } & Record<string, unknown>
  >(sql`
    SELECT enabled_at::text AS enabled_at, to_char(enabled_on, 'YYYY-MM-DD') AS enabled_on, enabled_by, plan_hash
      FROM open_item_allocation_enablements
     WHERE company_id = ${companyId}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return { enabledAt: row.enabled_at, enabledOn: row.enabled_on, enabledBy: row.enabled_by, planHash: row.plan_hash };
}

/** The companies the scheduled run may allocate (enabled by their Owner). */
export async function enabledAllocationCompanyIds(executor: DatabaseOrTransaction = db): Promise<number[]> {
  const result = await executor.execute<{ company_id: number } & Record<string, unknown>>(sql`
    SELECT e.company_id FROM open_item_allocation_enablements e
      JOIN companies c ON c.id = e.company_id
     ORDER BY e.company_id
  `);
  return result.rows.map((row) => Number(row.company_id));
}

/**
 * Whether the realized FX of an allocation settled on `settledOn` may be
 * posted automatically in the current transaction (see the header).
 */
export async function realizedFxAutoPostingAllowedTx(
  tx: DbTransaction,
  companyId: number,
  settledOn: string
): Promise<boolean> {
  const result = await tx.execute<{ allowed: boolean } & Record<string, unknown>>(sql`
    SELECT (now() > enabled_at AND ${settledOn}::date >= enabled_on) AS allowed
      FROM open_item_allocation_enablements
     WHERE company_id = ${companyId}
  `);
  return result.rows[0]?.allowed === true;
}

export interface AllocationPreviewKind {
  kind: AllocationPartyKind;
  parties: number;
  creates: number;
  createdAmount: string;
  releases: number;
}

export interface AllocationPreview {
  companyId: number;
  enabled: AllocationEnablement | null;
  kinds: AllocationPreviewKind[];
  planHash: string;
  /** What the first run does not do (shown with the preview). */
  realizedFx: "history-tool-only";
}

/** The plan of the reviewed first run (every kind), read only. */
export async function previewOpenItemAllocationTx(tx: DbTransaction, companyId: number): Promise<AllocationPreview> {
  const kinds: AllocationPreviewKind[] = [];
  const hashed: unknown[] = [];
  for (const kind of OPEN_ITEM_PARTY_KINDS) {
    const plans = await planOpenItemAllocationsTx(tx, { companyId, kind });
    let creates = 0;
    let releases = 0;
    let created: Decimal = new MoneyDecimal(0);
    for (const plan of plans) {
      creates += plan.creates.length;
      releases += plan.releases.length;
      for (const create of plan.creates) created = created.plus(create.amount);
    }
    kinds.push({ kind, parties: plans.length, creates, createdAmount: created.toFixed(2), releases });
    hashed.push({
      kind,
      plans: plans.map((plan) => ({
        partyId: plan.partyId,
        releases: plan.releases,
        creates: plan.creates.map((create) => [create.invoiceKey, create.paymentKey, create.amount.toFixed(2)]),
      })),
    });
  }
  const planHash = createHash("sha256").update(JSON.stringify({ companyId, hashed })).digest("hex");
  return {
    companyId,
    enabled: await loadAllocationEnablement(tx, companyId),
    kinds,
    planHash,
    realizedFx: "history-tool-only",
  };
}

/** Writes the enablement marker (the Owner's reviewed first run, in its transaction). */
export async function enableOpenItemAllocationTx(
  tx: DbTransaction,
  input: { companyId: number; enabledBy: string; planHash: string }
): Promise<AllocationEnablement> {
  const enabledOn = await companyBusinessDate(input.companyId, tx);
  await tx.execute(sql`
    INSERT INTO open_item_allocation_enablements (company_id, enabled_at, enabled_on, enabled_by, plan_hash)
    VALUES (${input.companyId}, now(), ${enabledOn}::date, ${input.enabledBy}, ${input.planHash})
  `);
  const enabled = await loadAllocationEnablement(tx, input.companyId);
  if (!enabled) throw new Error("The allocation enablement was not recorded");
  return enabled;
}

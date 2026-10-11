/**
 * The legacy import-cycle "plug", cleared through a reviewed Owner tool
 * (accounting audit phase 20, production item A2).
 *
 * GET /api/stats/import-cycle-balance and POST /api/admin/recalculate-equity-
 * adjustment(-all) used to store system_settings.equity_adjustment_<companyId>
 * = −(raw import-cycle difference), so the dashboard showed 0. They stopped
 * writing it (2026-10 audit), and nothing reads it any more except the
 * integrity diagnostic (`legacy_equity_plug`, warn while it is not zero). The
 * stored figure was never a journal: it is a settings row, so clearing it
 * changes no balance and posts nothing, and no period lock applies (no
 * voucher is dated). The import-cycle difference it hid stays visible in the
 * report until reviewed entries correct it.
 *
 * - planLegacyEquityPlugClear (read-only): the stored value and its last
 *   update, a blocker when there is nothing to clear, and a sha256 plan hash
 *   of the stored row (the route adds the live import-cycle difference; it is
 *   informational and not in the hash, so an unrelated posting between the
 *   preview and the apply does not refuse it — decided by default, owner can
 *   override);
 * - applyLegacyEquityPlugClear: current company only, one transaction
 *   (company scope, advisory lock, the settings row locked FOR UPDATE), the
 *   plan derived again and applied only when its hash is the reviewed one
 *   (PLAN_CHANGED: the value changed since the preview). It deletes the row
 *   (decided by default: a missing row and "0" read the same everywhere) and
 *   writes one audit row with the value before and after and the live
 *   difference, in the same transaction.
 */
import { createHash } from "node:crypto";

import { sql } from "drizzle-orm";

import { db, type DatabaseOrTransaction, type DbTransaction } from "../../db";
import { toMoney } from "../../lib/money";
import { writeAuditEvent } from "../audit";
import { assertTransactionCompanyScope } from "../security/transactionCompanyScope";

export const legacyEquityPlugKey = (companyId: number) => `equity_adjustment_${companyId}`;

export const LEGACY_EQUITY_PLUG_MESSAGES = {
  NOTHING_TO_CLEAR: "There is no stored equity adjustment to clear for this company.",
  PLAN_CHANGED: "The stored equity adjustment changed since it was reviewed; review it again before clearing.",
} as const;

export class LegacyEquityPlugRefusal extends Error {
  constructor(readonly code: keyof typeof LEGACY_EQUITY_PLUG_MESSAGES) {
    super(LEGACY_EQUITY_PLUG_MESSAGES[code]);
    this.name = "LegacyEquityPlugRefusal";
  }
  get status(): number {
    return this.code === "NOTHING_TO_CLEAR" ? 400 : 409;
  }
}

export interface LegacyEquityPlugPlan {
  companyId: number;
  settingKey: string;
  /** The stored row, as stored (null when there is none). */
  stored: { id: number; value: string | null; updatedAt: string } | null;
  /** The stored value to the cent ("0.00" when there is none or it is not a number). */
  storedValue: string;
  blockers: "NOTHING_TO_CLEAR"[];
  planHash: string;
}

type SettingRow = { id: number; value: string | null; updated_at: string } & Record<string, unknown>;

function parsedValue(value: string | null): string {
  try {
    return toMoney(value ?? 0).toFixed(2);
  } catch {
    return "0.00";
  }
}

async function derivePlan(
  executor: DatabaseOrTransaction,
  companyId: number,
  lock: boolean
): Promise<LegacyEquityPlugPlan> {
  const settingKey = legacyEquityPlugKey(companyId);
  const result = await executor.execute<SettingRow>(sql`
    SELECT id, value, updated_at::text AS updated_at FROM system_settings
     WHERE key = ${settingKey}
     ${lock ? sql`FOR UPDATE` : sql``}`);
  const row = result.rows[0];
  const stored = row ? { id: Number(row.id), value: row.value, updatedAt: row.updated_at } : null;
  const body = {
    companyId,
    settingKey,
    stored,
    storedValue: parsedValue(stored?.value ?? null),
    blockers: stored ? [] : (["NOTHING_TO_CLEAR"] as "NOTHING_TO_CLEAR"[]),
  };
  return { ...body, planHash: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
}

/** Read-only plan for the company. */
export function planLegacyEquityPlugClear(
  companyId: number,
  executor: DatabaseOrTransaction = db
): Promise<LegacyEquityPlugPlan> {
  return derivePlan(executor, companyId, false);
}

/** Clears the reviewed stored value for the company in one transaction, audited in it. */
export function applyLegacyEquityPlugClear(
  companyId: number,
  options: {
    planHash: string;
    liveImportCycleDifference: string | null;
    actor: { userId: string; username: string };
  }
): Promise<LegacyEquityPlugPlan> {
  return db.transaction(async (tx: DbTransaction) => {
    await assertTransactionCompanyScope(tx, companyId);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('legacy-equity-plug-clear'), ${companyId})`);
    const plan = await derivePlan(tx, companyId, true);
    if (plan.planHash !== options.planHash) throw new LegacyEquityPlugRefusal("PLAN_CHANGED");
    if (!plan.stored) throw new LegacyEquityPlugRefusal("NOTHING_TO_CLEAR");

    await tx.execute(sql`DELETE FROM system_settings WHERE id = ${plan.stored.id} AND key = ${plan.settingKey}`);
    await writeAuditEvent(
      {
        userId: options.actor.userId,
        username: options.actor.username,
        companyId,
        action: "delete",
        tableName: "system_settings",
        recordId: plan.stored.id,
        recordIdentifier: "legacy-equity-plug-clear",
        changes: {
          [plan.settingKey]: { old: plan.stored.value, new: null },
          storedValue: { old: plan.storedValue, new: "0.00" },
          liveImportCycleDifference: {
            old: options.liveImportCycleDifference,
            new: options.liveImportCycleDifference,
          },
          planHash: { new: plan.planHash },
        },
      },
      tx
    );
    return plan;
  });
}

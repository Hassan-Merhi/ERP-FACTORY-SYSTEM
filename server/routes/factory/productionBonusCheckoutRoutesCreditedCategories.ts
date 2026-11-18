// Extracted from ./productionBonusCheckoutRoutes.ts to keep that module under the source-size cap.
import type { Request } from "express";
import { createHash } from "node:crypto";
import Decimal from "decimal.js";
import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import { requireFactoryTabAccess } from "../../lib/factoryAccessControl";
import { resultRows } from "../../lib/queryResult";
import { workerCategoryCredits } from "@shared/productionBonusCheckoutMath";

export const guard = requireFactoryTabAccess("factory/stock-entry", "hide_tab_stockentry_production_targets");

export type Method = "standard" | "category";

export type BonusLine = { category: string; produced: number; extra: number; rate: string; bonus: string };

export type Offer = {
  date: string;
  workerId: number;
  workerName: string;
  linkGroupId: number | null;
  category: string;
  target: number;
  produced: number;
  extra: number;
  method: Method;
  lines: BonusLine[];
  amount: string;
  token: string;
  status: "pending" | "approved" | "paid" | "reversed" | "no_bonus" | "needs_setup" | "blocked" | "rejected" | "weekly";
  issue: string | null;
  /** Read-only weekly amount. Daily payment checkout never uses this field. */
  weeklyBonus?: { weekStart: string; amount: string; state: "projected" | "approved" };
};

type RecordRow = Record<string, unknown>;

export const rows = (x: unknown): RecordRow[] => resultRows(x) as RecordRow[];

// Annotated so a call narrows like a throw (TypeScript only narrows on
// never-returning functions with an explicit type).
export const fail: (status: number, message: string) => never = (status: number, message: string): never => {
  throw Object.assign(new Error(message), { status });
};

export const usd = (value: Decimal.Value) => new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);

export const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const allowed = (req: Request) =>
  ["Admin", "Owner"].includes(String(req.session.currentRole || req.user?.role || ""));

export const company = (req: Request) => Number(req.session.factoryCompanyId || req.session.currentCompanyId) || null;

export const actor = (req: Request) => ({
  userId: String(req.session.userId || ""),
  username: String(req.session.username || req.session.userId || ""),
});

export async function creditedCategories(
  tx: DatabaseOrTransaction,
  companyId: number,
  date: string,
  workerId: number,
  groupId: number | null
): Promise<Array<{ category: string; count: number }>> {
  const members =
    groupId == null
      ? [workerId]
      : rows(
          await tx.execute(sql`
      SELECT worker_id AS id FROM factory_worker_production_link_members
      WHERE company_id=${companyId} AND link_id=${groupId}
      ORDER BY worker_id
    `)
        ).map((item) => Number(item.id));
  if (!members.includes(workerId) || !members.length) fail(409, "Worker link assignment changed");
  const memberSql = sql.join(
    members.map((id) => sql`${id}`),
    sql`,`
  );
  const closed =
    rows(
      await tx.execute(sql`
    SELECT 1 FROM factory_staff_tracking_period_closures
    WHERE company_id=${companyId} AND page_type='production'
      AND period_type='daily' AND period_start=${date}::date
      AND period_end=${date}::date LIMIT 1
  `)
    ).length > 0;
  // Historical closed days always use their immutable per-bale category capture.
  // Open days use the same stock status and carry convention as Production Targets.
  const found = closed
    ? rows(
        await tx.execute(sql`
    SELECT bale_id AS id, worker_id AS worker, category_label AS category
    FROM factory_target_bonus_category_bale_snapshots
    WHERE company_id=${companyId} AND production_date=${date}::date
      AND worker_id IN (${memberSql})
    ORDER BY bale_id
  `)
      )
    : rows(
        await tx.execute(sql`
    SELECT fb.id, fb.finalized_by AS worker, fb.category
    FROM factory_bales fb
    WHERE fb.company_id=${companyId}
      AND fb.finalized_by IN (${memberSql})
      AND fb.status IN ('IN_STOCK','SOLD','RESERVED_FOR_ORDER','DISPATCHED','FINALIZED')
      AND (
        fb.stock_entry_date=${date}::date OR
        (fb.stock_entry_date=${date}::date - 1 AND
         COALESCE(fb.finalized_at,fb.created_at) >
          (SELECT c.ended_at FROM factory_staff_tracking_period_closures c
           WHERE c.company_id=${companyId} AND c.page_type='production'
            AND c.period_type='daily' AND c.period_start=${date}::date - 1
            AND c.period_end=${date}::date - 1 LIMIT 1))
      )
    ORDER BY fb.id
    FOR SHARE OF fb
  `)
      );
  if (!found.length) return [];
  // Frozen or live bales are ordered by their physical ID before splitting.
  return workerCategoryCredits(
    found.map((bale) => ({
      id: Number(bale.id),
      worker: bale.worker == null ? null : Number(bale.worker),
      category: typeof bale.category === "string" ? bale.category : null,
    })),
    members,
    workerId
  );
}

import { sql } from "drizzle-orm";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { loadActiveProductionWorkerLinks } from "./productionWorkerLinks";

type ProductionTargetDefaultRow = {
  workerId: number | string;
  category: string | null;
  targetBales: string | number | null;
};

export type ProductionTargetDefault = {
  category: string | null;
  targetBales: number | null;
};

export async function loadProductionTargetDefaults(
  companyId: number,
  asOf: string
): Promise<Map<number, ProductionTargetDefault>> {
  const result = await db.execute(sql`
    SELECT DISTINCT ON (worker_id)
      worker_id AS "workerId",
      category,
      target_bales AS "targetBales"
    FROM factory_worker_production_target_defaults
    WHERE company_id = ${companyId}
      AND effective_from <= ${asOf}
    ORDER BY worker_id, effective_from DESC, id DESC
  `);
  const rows = resultRows(result) as ProductionTargetDefaultRow[];
  const defaults = new Map<number, ProductionTargetDefault>();

  for (const row of rows) {
    defaults.set(Number(row.workerId), {
      category: row.category,
      targetBales: row.targetBales === null || row.targetBales === undefined ? null : Number(row.targetBales),
    });
  }

  // Older links may have a shared target but no per-worker target history.
  // Retain that value only as a fallback for genuinely missing worker records;
  // never replace an individual's own target (including an explicitly blank one).
  const activeLinks = await loadActiveProductionWorkerLinks(companyId, asOf);
  for (const link of activeLinks) {
    if (link.sharedTargetBales == null) continue;
    for (const member of link.members) {
      if (!defaults.has(member.workerId)) {
        defaults.set(member.workerId, { category: null, targetBales: link.sharedTargetBales });
      }
    }
  }

  return defaults;
}

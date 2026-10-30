import { sql } from "drizzle-orm";
import { categoryReviewSnapshotPayload, categoryReviewSnapshotToken } from "./categoryBonusReviewSnapshot";
import type { DatabaseOrTransaction } from "../../db";
import { db } from "../../db";
import { resultRows } from "../../lib/queryResult";
import {
  calculateCategoryBonusDay, type CategoryBonusDayProposal,
} from "@shared/productionTargetBonusCategoryCalculation";
import type { ProductionBonusCategoryRateVersion } from "@shared/productionTargetBonusCategoryRates";
import { loadProductionBonusCategoryEvidence } from "./productionBonusCategoryEvidenceService";

type RateRow = {
  id: number | string;
  categoryKey: string;
  categoryLabel: string;
  effectiveFrom: string;
  enabled: boolean;
  ratePerExtraBale: string;
};
type ReviewRow = { workerId: number | string; status: "approved" | "rejected" };

/** Read-only Phase 10 preview. No account writes, approvals, cash movements,
 * payroll claims or Daybook postings are possible via this service.
 *
 * The company is derived from the authorized factory session by the caller;
 * both rate versions and existing reviews are explicitly company-scoped.
 */
export async function previewProductionBonusCategories(
  companyId: number, date: string, executor: DatabaseOrTransaction = db,
): Promise<CategoryBonusDayProposal> {
  const evidence = await loadProductionBonusCategoryEvidence(executor, companyId, date);
  const keys = [...new Set(evidence.workers.flatMap(worker =>
    worker.categories.map(category => category.categoryKey)))];
  const [ratesResult, existingResult] = await Promise.all([
    keys.length ? executor.execute(sql`
      SELECT DISTINCT ON (category_key)
        id, category_key AS "categoryKey",
        category_label AS "categoryLabel", effective_from::text AS "effectiveFrom",
        enabled, rate_per_extra_bale::text AS "ratePerExtraBale"
      FROM factory_production_target_bonus_category_rates
      WHERE company_id = ${companyId} AND effective_from <= ${date}::date
        AND category_key IN (${sql.join(keys.map(key => sql`${key}`), sql`, `)})
      ORDER BY category_key, effective_from DESC, id DESC
    `) : Promise.resolve({ rows: [] }),
    executor.execute(sql`
      SELECT worker_id AS "workerId", status
      FROM factory_target_bonus_reviews
      WHERE company_id = ${companyId} AND production_date = ${date}::date
    `),
  ]);
  const rates: ProductionBonusCategoryRateVersion[] =
    (resultRows(ratesResult) as RateRow[]).map(row => ({
      id: Number(row.id),
      categoryKey: row.categoryKey,
      categoryLabel: row.categoryLabel,
      effectiveFrom: row.effectiveFrom,
      enabled: row.enabled,
      ratePerExtraBale: row.ratePerExtraBale,
    }));
  const legacyReviews = new Map<number, "approved" | "rejected">(
    (resultRows(existingResult) as ReviewRow[]).map(row => [Number(row.workerId), row.status]),
  );
  const proposal = calculateCategoryBonusDay(evidence, rates, legacyReviews);
  for (const worker of proposal.workers) {
    worker.reviewToken = categoryReviewSnapshotToken(
      categoryReviewSnapshotPayload(proposal.calculationVersion, worker),
    );
  }
  return proposal;
}


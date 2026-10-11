/**
 * The scheduled automatic allocation run (phase 25, AR-4): every company and
 * party kind, each in its own transaction (one failure is logged, the others
 * still run). Allocations post no journal; listeners (phase 24 realized FX)
 * post in the same transaction as the rows.
 *
 * Integration review: only companies whose Owner has run the reviewed first
 * allocation (allocationEnablement.ts) are allocated; the others are skipped
 * until then, so deploying never back-fills (or FX-posts) a company's history.
 */
import { db } from "../../../db";
import { getErrorMessage } from "../../../lib/httpHandlers";
import { logger } from "../../../lib/logger";
import { runInCompanyPostingScope } from "../scheduledPostingScope";
import { enabledAllocationCompanyIds } from "./allocationEnablement";
import { syncOpenItemAllocationsTx, type SyncResult } from "./allocationService";
import { OPEN_ITEM_PARTY_KINDS } from "./openItems";

export async function runOpenItemAllocationForAllCompanies(): Promise<SyncResult[]> {
  const companyIds = await enabledAllocationCompanyIds(db);
  const results: SyncResult[] = [];
  for (const companyId of companyIds) {
    for (const kind of OPEN_ITEM_PARTY_KINDS) {
      try {
        // The tick's maintenance scope only lists the companies; each company is
        // allocated in its own tenant scope, so the realized FX the listener posts
        // meets the closed-period guard and RLS like any request.
        const result = await runInCompanyPostingScope(
          companyId,
          () => db.transaction((tx) => syncOpenItemAllocationsTx(tx, { companyId, kind })),
          "open-item-allocation"
        );
        if (result.created > 0 || result.released > 0) results.push(result);
      } catch (error: unknown) {
        logger.error("[OpenItems] Allocation run failed", {
          companyId,
          kind,
          error: getErrorMessage(error),
        });
      }
    }
  }
  logger.info("[OpenItems] Allocation run complete", { enabledCompanies: companyIds.length, changed: results.length });
  return results;
}

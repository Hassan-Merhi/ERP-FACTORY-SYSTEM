import { db, pool } from "../../db";
import { logger } from "../../lib/logger";
import { loadDatabaseStockConvergenceSnapshots } from "../inventory/databaseStockConvergenceSnapshots";
import {
  ConvergenceReconciliationError,
  reconcileConvergenceTx,
  type ConvergenceReconciliationResult,
} from "./convergenceReconciliation";
import { createDatabaseConvergenceAdapter } from "./databaseConvergenceAdapter";
import { loadDatabasePhase3AccountingAudit } from "./databasePhase3AccountingAudit";
import { auditPhase3Accounting } from "./phase3AccountingAudit";
import { loadPhase3InventoryValuationSnapshot } from "./phase3InventoryValuation";

const convergenceAdapter = createDatabaseConvergenceAdapter(loadDatabaseStockConvergenceSnapshots);

export interface ScheduledConvergenceSummary {
  companies: number;
  clean: number;
  withDiscrepancies: number;
  rejected: number;
  failed: number;
  discrepancies: number;
}

interface ScheduledConvergenceDependencies {
  listCompanyIds(): Promise<number[]>;
  reconcileCompany(companyId: number): Promise<ConvergenceReconciliationResult>;
  info(message: string, context: Record<string, unknown>): void;
  warn(message: string, context: Record<string, unknown>): void;
  error(message: string, context: Record<string, unknown>): void;
}

const defaultDependencies: ScheduledConvergenceDependencies = {
  async listCompanyIds() {
    const result = await pool.query<{ id: number }>("SELECT id FROM companies ORDER BY id");
    return result.rows.map(({ id }) => id);
  },
  reconcileCompany(companyId) {
    return db.transaction(
      async (tx) => {
        const convergence = await reconcileConvergenceTx(tx, companyId, convergenceAdapter);

        // Load the cross-subsystem accounting surfaces and replace the legacy
        // Inventory-GL heuristic with the Phase 3 cutover valuation: immutable
        // baseline + append-only canonical movements replayed independently from
        // live inventory. Both reads share this repeatable-read snapshot.
        const phase3Input = await loadDatabasePhase3AccountingAudit({ tx, companyId });
        phase3Input.stock = await loadPhase3InventoryValuationSnapshot({ tx, companyId });
        const phase3 = auditPhase3Accounting(phase3Input);
        if (!phase3.clean) {
          logger.warn("Scheduled Phase 3 accounting audit found discrepancies", {
            module: "accounting",
            action: "phase3ScheduledAudit",
            companyId,
            issueCount: phase3.issues.length,
            issueCodes: [...new Set(phase3.issues.map(({ code }) => code))].sort(),
            issues: phase3.issues.slice(0, 100),
            checked: phase3.checked,
          });
        }

        return convergence;
      },
      {
        isolationLevel: "repeatable read",
        accessMode: "read only",
      }
    );
  },
  info(message, context) {
    logger.info(message, context);
  },
  warn(message, context) {
    logger.warn(message, context);
  },
  error(message, context) {
    logger.error(message, context);
  },
};

function discrepancyCodes(result: ConvergenceReconciliationResult): string[] {
  return [...new Set(result.discrepancies.map(({ code }) => code))].sort();
}

/**
 * Run read-only convergence reconciliation for every company.
 *
 * This is deliberately an observer, never a repair job. Historical repairs run
 * once in the guarded startup path; scheduled reconciliation only reports new
 * drift. Each company uses its own repeatable-read transaction so source rows,
 * journal rows and valuation evidence are one stable snapshot.
 */
export async function runScheduledConvergenceReconciliation(
  dependencies: ScheduledConvergenceDependencies = defaultDependencies
): Promise<ScheduledConvergenceSummary> {
  const companyIds = await dependencies.listCompanyIds();
  const summary: ScheduledConvergenceSummary = {
    companies: companyIds.length,
    clean: 0,
    withDiscrepancies: 0,
    rejected: 0,
    failed: 0,
    discrepancies: 0,
  };

  for (const companyId of companyIds) {
    try {
      const result = await dependencies.reconcileCompany(companyId);
      if (result.clean) {
        summary.clean += 1;
        continue;
      }

      summary.withDiscrepancies += 1;
      summary.discrepancies += result.discrepancies.length;
      dependencies.warn("Scheduled convergence reconciliation found discrepancies", {
        module: "convergence",
        action: "scheduledReconcile",
        companyId,
        accountingSnapshots: result.accountingSnapshots,
        stockSnapshots: result.stockSnapshots,
        discrepancyCount: result.discrepancies.length,
        discrepancyCodes: discrepancyCodes(result),
      });
    } catch (error: unknown) {
      if (error instanceof ConvergenceReconciliationError) {
        summary.rejected += 1;
        dependencies.warn("Scheduled convergence reconciliation rejected untrustworthy evidence", {
          module: "convergence",
          action: "scheduledReconcile",
          companyId,
          code: error.code,
          error: error.message,
        });
        continue;
      }

      summary.failed += 1;
      dependencies.error("Scheduled convergence reconciliation failed for company", {
        module: "convergence",
        action: "scheduledReconcile",
        companyId,
        error,
      });
    }
  }

  dependencies.info("Scheduled convergence reconciliation complete", {
    module: "convergence",
    action: "scheduledReconcile",
    ...summary,
  });

  return summary;
}

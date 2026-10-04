import { logger } from "../../lib/logger";
import {
  applyHistoricalSalesCostRepair,
  buildHistoricalSalesCostRepairDryRun,
  getHistoricalSalesCostRepairRun,
} from "./historicalSalesCostRepair";
import {
  HISTORICAL_SALES_COST_PARTIAL_APPLY_MODE,
  applyHistoricalSalesCostPartial,
  previewHistoricalSalesCostPartialApply,
  rollbackHistoricalSalesCostPartial,
  verifyHistoricalSalesCostPartialApply,
} from "./historicalSalesCostPartialApply";

const ENV_MODE = "HISTORICAL_SALES_COST_REPAIR_MODE";
const ENV_RUN_ID = "HISTORICAL_SALES_COST_REPAIR_RUN_ID";
const ENV_AUDIT_HASH = "HISTORICAL_SALES_COST_REPAIR_AUDIT_HASH";
const ENV_COMPANY_IDS = "HISTORICAL_SALES_COST_REPAIR_COMPANY_IDS";
const ENV_TARGET_HASH = "HISTORICAL_SALES_COST_REPAIR_TARGET_HASH";
const ENV_PARTIAL_CONFIRMATION = "HISTORICAL_SALES_COST_REPAIR_PARTIAL_CONFIRMATION";
const ENV_ROLLBACK_CONFIRMATION = "HISTORICAL_SALES_COST_REPAIR_ROLLBACK_CONFIRMATION";

// Explicitly named modes for the proven-rows-only partial apply. They are
// separate from "apply", which still requires a ready run with zero blockers.
const MODE_PARTIAL_APPLY = "partial-apply-proven-rows-only";
const MODE_PARTIAL_ROLLBACK = "partial-apply-rollback";

function hscrStartupError(code: string): Error {
  const error = new Error();
  error.message = code;
  return error;
}

function parseCompanyIds(raw: string | undefined): number[] | undefined {
  if (!raw?.trim()) return undefined;
  const ids = [...new Set(raw.split(",").map((value) => Number(value.trim())))];
  if (ids.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw hscrStartupError(`HSCR_ENV_COMPANY_IDS_INVALID:${ENV_COMPANY_IDS}`);
  }
  return ids;
}

export async function maybeRunHistoricalSalesCostRepairFromEnv(): Promise<void> {
  const mode = String(process.env.HISTORICAL_SALES_COST_REPAIR_MODE ?? "")
    .trim()
    .toLowerCase();
  if (!mode || mode === "off" || mode === "disabled") return;

  if (mode === "dry-run") {
    let result: Awaited<ReturnType<typeof buildHistoricalSalesCostRepairDryRun>>;
    try {
      result = await buildHistoricalSalesCostRepairDryRun({
        createdBy: "render-startup-env",
        companyIds: parseCompanyIds(process.env.HISTORICAL_SALES_COST_REPAIR_COMPANY_IDS),
      });
    } catch (error) {
      // Nothing was written; keep the deploy healthy and report the refusal.
      if (error instanceof Error && error.message.startsWith("HSCR_DRY_RUN_REFUSED_ACTIVE_PARTIAL_APPLY")) {
        logger.error("HISTORICAL_SALES_COST_REPAIR_DRY_RUN_REFUSED", {
          module: "historical-sales-cost-repair",
          action: "startup-dry-run",
          code: error.message,
        });
        return;
      }
      throw error;
    }
    logger.info("HISTORICAL_SALES_COST_REPAIR_DRY_RUN_RESULT", {
      module: "historical-sales-cost-repair",
      action: "startup-dry-run",
      ...result,
    });
    return;
  }

  if (mode === "apply") {
    const runId = Number(process.env.HISTORICAL_SALES_COST_REPAIR_RUN_ID);
    const auditHash = String(process.env.HISTORICAL_SALES_COST_REPAIR_AUDIT_HASH ?? "")
      .trim()
      .toLowerCase();
    if (!Number.isSafeInteger(runId) || runId <= 0) {
      throw hscrStartupError(`HSCR_ENV_RUN_ID_INVALID:${ENV_RUN_ID}:${ENV_MODE}`);
    }
    if (!/^[a-f0-9]{64}$/.test(auditHash)) {
      throw hscrStartupError(`HSCR_ENV_AUDIT_HASH_INVALID:${ENV_AUDIT_HASH}:${ENV_MODE}`);
    }

    const existing = await getHistoricalSalesCostRepairRun(runId);
    if (!existing) throw hscrStartupError(`HSCR_RUN_NOT_FOUND:${runId}`);
    if (String(existing.audit_hash ?? "").toLowerCase() !== auditHash) {
      throw hscrStartupError(`HSCR_ENV_AUDIT_HASH_MISMATCH:${runId}:${ENV_AUDIT_HASH}`);
    }
    if (existing.status === "applied") {
      logger.info("HISTORICAL_SALES_COST_REPAIR_ALREADY_APPLIED", {
        module: "historical-sales-cost-repair",
        action: "startup-apply",
        runId,
        auditHash,
      });
      return;
    }

    const result = await applyHistoricalSalesCostRepair({
      runId,
      auditHash,
      appliedBy: "render-startup-env",
    });
    logger.info("HISTORICAL_SALES_COST_REPAIR_APPLY_RESULT", {
      module: "historical-sales-cost-repair",
      action: "startup-apply",
      ...result,
    });
    return;
  }

  if (mode === MODE_PARTIAL_APPLY || mode === MODE_PARTIAL_ROLLBACK) {
    const runId = Number(process.env.HISTORICAL_SALES_COST_REPAIR_RUN_ID);
    const auditHash = String(process.env.HISTORICAL_SALES_COST_REPAIR_AUDIT_HASH ?? "")
      .trim()
      .toLowerCase();
    if (!Number.isSafeInteger(runId) || runId <= 0) {
      throw hscrStartupError(`HSCR_ENV_RUN_ID_INVALID:${ENV_RUN_ID}:${ENV_MODE}`);
    }
    if (!/^[a-f0-9]{64}$/.test(auditHash)) {
      throw hscrStartupError(`HSCR_ENV_AUDIT_HASH_INVALID:${ENV_AUDIT_HASH}:${ENV_MODE}`);
    }

    if (mode === MODE_PARTIAL_ROLLBACK) {
      const result = await rollbackHistoricalSalesCostPartial({
        runId,
        auditHash,
        confirmation: String(process.env.HISTORICAL_SALES_COST_REPAIR_ROLLBACK_CONFIRMATION ?? "").trim(),
        rolledBackBy: "render-startup-env",
      });
      const verification = await verifyHistoricalSalesCostPartialApply(runId);
      logger.info("HISTORICAL_SALES_COST_REPAIR_PARTIAL_ROLLBACK_RESULT", {
        module: "historical-sales-cost-repair",
        action: "startup-partial-rollback",
        confirmationEnv: ENV_ROLLBACK_CONFIRMATION,
        ...result,
        verificationOk: verification.ok,
        rowsAtOriginal: verification.rowsAtOriginal,
      });
      return;
    }

    const targetHash = String(process.env.HISTORICAL_SALES_COST_REPAIR_TARGET_HASH ?? "")
      .trim()
      .toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(targetHash)) {
      throw hscrStartupError(`HSCR_ENV_TARGET_HASH_INVALID:${ENV_TARGET_HASH}:${ENV_MODE}`);
    }
    const preview = await previewHistoricalSalesCostPartialApply(runId);
    logger.info("HISTORICAL_SALES_COST_REPAIR_PARTIAL_PREVIEW", {
      module: "historical-sales-cost-repair",
      action: "startup-partial-apply",
      runId,
      targetRows: preview.targetRows,
      targetHash: preview.targetHash,
      liveTargetDrift: preview.liveTargetDrift.count,
      reconciliation: preview.reconciliation.target,
    });
    const result = await applyHistoricalSalesCostPartial({
      runId,
      auditHash,
      targetHash,
      mode: HISTORICAL_SALES_COST_PARTIAL_APPLY_MODE,
      confirmation: String(process.env.HISTORICAL_SALES_COST_REPAIR_PARTIAL_CONFIRMATION ?? "").trim(),
      appliedBy: "render-startup-env",
    });
    const verification = await verifyHistoricalSalesCostPartialApply(runId);
    logger.info("HISTORICAL_SALES_COST_REPAIR_PARTIAL_APPLY_RESULT", {
      module: "historical-sales-cost-repair",
      action: "startup-partial-apply",
      confirmationEnv: ENV_PARTIAL_CONFIRMATION,
      runId: result.runId,
      partialApplyId: result.partialApplyId,
      appliedRows: result.appliedRows,
      alreadyApplied: result.alreadyApplied,
      verificationOk: verification.ok,
      rowsAtProposed: verification.rowsAtProposed,
      cogs: verification.cogs,
      profit: verification.profit,
    });
    return;
  }

  throw hscrStartupError(`HSCR_ENV_MODE_INVALID:${ENV_MODE}`);
}

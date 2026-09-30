import { logger } from "../../lib/logger";
import {
  applyHistoricalSalesCostRepair,
  buildHistoricalSalesCostRepairDryRun,
  getHistoricalSalesCostRepairRun,
} from "./historicalSalesCostRepair";

const ENV_MODE = "HISTORICAL_SALES_COST_REPAIR_MODE";
const ENV_RUN_ID = "HISTORICAL_SALES_COST_REPAIR_RUN_ID";
const ENV_AUDIT_HASH = "HISTORICAL_SALES_COST_REPAIR_AUDIT_HASH";
const ENV_COMPANY_IDS = "HISTORICAL_SALES_COST_REPAIR_COMPANY_IDS";

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
  const mode = String(process.env.HISTORICAL_SALES_COST_REPAIR_MODE ?? "").trim().toLowerCase();
  if (!mode || mode === "off" || mode === "disabled") return;

  if (mode === "dry-run") {
    const result = await buildHistoricalSalesCostRepairDryRun({
      createdBy: "render-startup-env",
      companyIds: parseCompanyIds(process.env.HISTORICAL_SALES_COST_REPAIR_COMPANY_IDS),
    });
    logger.info("HISTORICAL_SALES_COST_REPAIR_DRY_RUN_RESULT", {
      module: "historical-sales-cost-repair",
      action: "startup-dry-run",
      ...result,
    });
    return;
  }

  if (mode === "apply") {
    const runId = Number(process.env.HISTORICAL_SALES_COST_REPAIR_RUN_ID);
    const auditHash = String(process.env.HISTORICAL_SALES_COST_REPAIR_AUDIT_HASH ?? "").trim().toLowerCase();
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

  throw hscrStartupError(`HSCR_ENV_MODE_INVALID:${ENV_MODE}`);
}

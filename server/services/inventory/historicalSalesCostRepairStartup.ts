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

function parseCompanyIds(raw: string | undefined): number[] | undefined {
  if (!raw?.trim()) return undefined;
  const ids = [...new Set(raw.split(",").map((value) => Number(value.trim())))];
  if (ids.some((value) => !Number.isInteger(value) || value <= 0)) {
    throw new Error(`${ENV_COMPANY_IDS} must be a comma-separated list of positive integer company IDs`);
  }
  return ids;
}

export async function maybeRunHistoricalSalesCostRepairFromEnv(): Promise<void> {
  const mode = String(process.env[ENV_MODE] ?? "").trim().toLowerCase();
  if (!mode || mode === "off" || mode === "disabled") return;

  if (mode === "dry-run") {
    const result = await buildHistoricalSalesCostRepairDryRun({
      createdBy: "render-startup-env",
      companyIds: parseCompanyIds(process.env[ENV_COMPANY_IDS]),
    });
    logger.info("HISTORICAL_SALES_COST_REPAIR_DRY_RUN_RESULT", {
      module: "historical-sales-cost-repair",
      action: "startup-dry-run",
      ...result,
    });
    return;
  }

  if (mode === "apply") {
    const runId = Number(process.env[ENV_RUN_ID]);
    const auditHash = String(process.env[ENV_AUDIT_HASH] ?? "").trim().toLowerCase();
    if (!Number.isSafeInteger(runId) || runId <= 0) {
      throw new Error(`${ENV_RUN_ID} must be a positive integer when ${ENV_MODE}=apply`);
    }
    if (!/^[a-f0-9]{64}$/.test(auditHash)) {
      throw new Error(`${ENV_AUDIT_HASH} must be the reviewed 64-character dry-run hash when ${ENV_MODE}=apply`);
    }

    const existing = await getHistoricalSalesCostRepairRun(runId);
    if (!existing) throw new Error(`Historical sales cost repair run ${runId} does not exist`);
    if (String(existing.audit_hash ?? "").toLowerCase() !== auditHash) {
      throw new Error(`Historical sales cost repair run ${runId} audit hash does not match ${ENV_AUDIT_HASH}`);
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

  throw new Error(`${ENV_MODE} must be one of: disabled, dry-run, apply`);
}

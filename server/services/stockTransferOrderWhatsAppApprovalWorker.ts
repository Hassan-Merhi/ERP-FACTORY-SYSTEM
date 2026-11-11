/**
 * Durable Phase 4 decision processor.
 *
 * Phase 3 writes immutable DONE/DECLINE event evidence before acknowledging
 * GREEN API. This worker replays every still-requested decision after crashes,
 * restarts or network failures. Cross-worker safety is enforced by PostgreSQL
 * row locks and one terminal batch status, not process-local memory.
 */
import { pool } from "../db";
import { logger } from "../lib/logger";
import { readFactoryEdgeConfiguration, shouldStartEdgeBackgroundJobs } from "../edge/edgeRuntimePolicy.mjs";
import { runWithDatabaseMaintenanceScope } from "./security/databaseScopeRuntimeContext";
import { executeStockTransferOrderWaBatch } from "./stockTransferOrderWhatsAppBatchExecution";

const SWEEP_INTERVAL_MS = 20_000;
const MAX_PER_SWEEP = 15;
let timer: NodeJS.Timeout | null = null;
let sweepRunning = false;
const backoffUntil = new Map<number, number>();

export function stockTransferOrderWaExecutionEnabled(): boolean {
  return process.env.STO_WA_APPROVAL_EXECUTION_ENABLED !== "false" &&
    process.env.ENABLE_SCHEDULERS !== "false" &&
    shouldStartEdgeBackgroundJobs(readFactoryEdgeConfiguration());
}

async function processOne(batchId: number): Promise<void> {
  if (!stockTransferOrderWaExecutionEnabled()) return;
  try {
    const result = await executeStockTransferOrderWaBatch(batchId);
    backoffUntil.delete(batchId);
    if (result.outcome === "approved" || result.outcome === "declined") {
      logger.info("[STO WA] Full verified decision executed", {
        batchId,
        outcome: result.outcome,
        orders: result.orderCount,
        revisions: result.revisionCount,
        superseded: result.supersededRevisions,
      });
    }
  } catch (error) {
    // Retry transient failures, but never retry a partially-committed batch:
    // a PostgreSQL transaction makes partial commits impossible. The durable
    // decision is still pending in the DB and is safe to replay.
    backoffUntil.set(batchId, Date.now() + 60_000);
    logger.error("[STO WA] Verified decision execution deferred; will retry", {
      batchId,
      error: error instanceof Error ? error.message : "unknown_error",
    });
  }
}

export function queueStockTransferOrderWaDecision(batchId: number): void {
  if (!stockTransferOrderWaExecutionEnabled() || !Number.isSafeInteger(batchId) || batchId <= 0) return;
  // Fast path after HTTP webhook ACK. The sweep remains the durable path if
  // the process disappears before this callback is reached.
  setImmediate(() => { void processOne(batchId); });
}

export async function sweepStockTransferOrderWaDecisions(): Promise<number> {
  if (!stockTransferOrderWaExecutionEnabled() || sweepRunning) return 0;
  sweepRunning = true;
  try {
    return await runWithDatabaseMaintenanceScope("sto_whatsapp_decision_worker_scan", async () => {
      const results = await pool.query<{ id: string | number }>(
        "SELECT b.id FROM stock_transfer_order_approval_batches b " +
        "WHERE b.status='requested' AND EXISTS (" +
        "SELECT 1 FROM stock_transfer_order_approval_events e " +
        "WHERE e.company_id=b.company_id AND e.batch_id=b.id " +
        "AND e.event_type IN ('done_received','decline_received')) " +
        "ORDER BY b.id ASC LIMIT $1",
        [MAX_PER_SWEEP * 8]
      );
      let processed = 0;
      for (const item of results.rows) {
        if (processed >= MAX_PER_SWEEP) break;
        const id = Number(item.id);
        if (!Number.isSafeInteger(id) || id <= 0 || (backoffUntil.get(id) ?? 0) > Date.now()) {
          continue;
        }
        await processOne(id);
        processed++;
      }
      return processed;
    });
  } catch (error) {
    logger.error("[STO WA] Durable decision scan failed", {
      error: error instanceof Error ? error.message : "unknown_error",
    });
    return 0;
  } finally {
    sweepRunning = false;
  }
}

export function startStockTransferOrderWaApprovalWorker(): void {
  if (timer || !stockTransferOrderWaExecutionEnabled()) return;
  timer = setInterval(() => { void sweepStockTransferOrderWaDecisions(); }, SWEEP_INTERVAL_MS);
  timer.unref();
  void sweepStockTransferOrderWaDecisions();
  logger.info("[STO WA] Durable full-batch decision processor started", {
    intervalMs: SWEEP_INTERVAL_MS,
  });
}

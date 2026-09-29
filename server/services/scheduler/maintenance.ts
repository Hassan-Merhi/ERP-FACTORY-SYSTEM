import type { PoolClient } from "pg";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { fetchAllCompanies } from "../export-data";
import { pool } from "../../db";
import {} from "../whatsappService";
import { buildFullExportZip } from "../../helpers/buildFullExportZip";
import { retryAsync, isWaConfigError } from "../../helpers/retryAsync";
import { createExportRun, updateExportRun, finishExportRun } from "../../helpers/exportRunTracker";
import { getExportAttachmentSize } from "../../helpers/exportAttachmentSource";

import { getTodayLabel, runDailyExport } from "./daily-export";
import { runDailyWhatsAppSend } from "./whatsapp-send";
import {
  beginScheduledWhatsAppAttachmentAttempt,
  claimRetryableScheduledWhatsAppOccurrence,
  claimScheduledWhatsAppOccurrence,
  finalizeScheduledWhatsAppOccurrence,
  finishScheduledWhatsAppAttachmentAttempt,
  logScheduledWhatsAppAttachmentResult,
  recordScheduledWhatsAppAttachmentPreparationFailure,
  recordScheduledWhatsAppAttachmentUncertain,
} from "./scheduledWhatsAppDelivery";

type MixBatchPurgeCandidate = {
  id: number;
  company_id: number;
  batch_code: string | null;
};

type MixBatchReferenceCounts = {
  own_sources: number;
  downstream_sources: number;
  daily_usages: number;
  carry_forward_children: number;
  pressing_batches: number;
  bales: number;
  waste_entries: number;
};

type DatabaseErrorMetadata = {
  code?: string;
  constraint?: string;
  table?: string;
  column?: string;
  detail?: string;
};

const PURGE_SAVEPOINT = "soft_delete_purge_unit";
const MIX_BATCH_PURGE_SAVEPOINT = "soft_delete_purge_mix_batch";

function extractDatabaseErrorMetadata(error: unknown): DatabaseErrorMetadata {
  const metadata: DatabaseErrorMetadata = {};
  let current: unknown = error;
  const seen = new Set<object>();

  for (let depth = 0; depth < 6; depth += 1) {
    if (typeof current !== "object" || current === null || seen.has(current)) break;
    seen.add(current);
    const record = current as Record<string, unknown>;

    for (const field of ["code", "constraint", "table", "column", "detail"] as const) {
      const value = record[field];
      if (typeof value === "string" && value.length > 0) metadata[field] = value;
    }

    current = record.cause;
  }

  return metadata;
}

function mixBatchReferenceTotal(references: MixBatchReferenceCounts): number {
  return Object.values(references).reduce((total, count) => total + Number(count || 0), 0);
}

async function runIsolatedPurgeUnit(client: PoolClient, label: string, action: () => Promise<void>): Promise<boolean> {
  await client.query(`SAVEPOINT ${PURGE_SAVEPOINT}`);
  try {
    await action();
    await client.query(`RELEASE SAVEPOINT ${PURGE_SAVEPOINT}`);
    return true;
  } catch (err: unknown) {
    await client.query(`ROLLBACK TO SAVEPOINT ${PURGE_SAVEPOINT}`);
    await client.query(`RELEASE SAVEPOINT ${PURGE_SAVEPOINT}`);
    const databaseError = extractDatabaseErrorMetadata(err);
    logger.error("[Purge] Isolated purge unit failed; retained its rows and continuing.", {
      label,
      error: getErrorMessage(err),
      dbErrorCode: databaseError.code,
      dbConstraint: databaseError.constraint,
      dbTable: databaseError.table,
      dbColumn: databaseError.column,
      dbDetail: databaseError.detail,
    });
    return false;
  }
}

/**
 * Mix batches carry costing and production history. Automatic retention cleanup
 * must never erase that history simply to satisfy an FK. A batch is therefore
 * permanently removed only when none of the known production/history links
 * still reference it. Unknown/schema-drifted FK blockers are caught per batch,
 * rolled back to a savepoint, logged with the batch identity, and retained.
 * Explicit Delete Forever remains the separate workflow for destructive cleanup.
 */
async function purgeOldFactoryMixBatches(client: PoolClient, cutoff: string): Promise<void> {
  const candidates = await client.query<MixBatchPurgeCandidate>(
    `SELECT id, company_id, batch_code
       FROM factory_mix_batches
      WHERE deleted_at IS NOT NULL
        AND deleted_at < $1
      ORDER BY deleted_at ASC, id ASC`,
    [cutoff]
  );

  let deletedCount = 0;
  let protectedCount = 0;
  let failedCount = 0;
  const protectedSamples: Array<{
    mixBatchId: number;
    companyId: number;
    batchCode: string | null;
    references: MixBatchReferenceCounts;
  }> = [];

  for (const candidate of candidates.rows) {
    await client.query(`SAVEPOINT ${MIX_BATCH_PURGE_SAVEPOINT}`);
    try {
      const referenceResult = await client.query<MixBatchReferenceCounts>(
        `SELECT
           (SELECT COUNT(*)::int FROM factory_mix_batch_sources WHERE mix_batch_id = $1) AS own_sources,
           (SELECT COUNT(*)::int
              FROM factory_mix_batch_sources
             WHERE source_batch_id = $1
                OR (source_type = 'BATCH' AND source_id = $1)) AS downstream_sources,
           (SELECT COUNT(*)::int FROM factory_daily_usages WHERE mix_batch_id = $1 AND company_id = $2) AS daily_usages,
           (SELECT COUNT(*)::int FROM factory_mix_batches WHERE carry_forward_from_id = $1 AND company_id = $2) AS carry_forward_children,
           (SELECT COUNT(*)::int FROM factory_pressing_batches WHERE mix_batch_id = $1 AND company_id = $2) AS pressing_batches,
           (SELECT COUNT(*)::int FROM factory_bales WHERE mix_batch_id = $1 AND company_id = $2) AS bales,
           (SELECT COUNT(*)::int FROM factory_waste_entries WHERE mix_batch_id = $1 AND company_id = $2) AS waste_entries`,
        [candidate.id, candidate.company_id]
      );

      const references = referenceResult.rows[0];
      if (!references) {
        throw new Error("mix_batch_reference_inspection_failed");
      }

      if (mixBatchReferenceTotal(references) > 0) {
        protectedCount += 1;
        if (protectedSamples.length < 20) {
          protectedSamples.push({
            mixBatchId: candidate.id,
            companyId: candidate.company_id,
            batchCode: candidate.batch_code,
            references,
          });
        }
        await client.query(`RELEASE SAVEPOINT ${MIX_BATCH_PURGE_SAVEPOINT}`);
        continue;
      }

      const removed = await client.query(
        `DELETE FROM factory_mix_batches
          WHERE id = $1
            AND company_id = $2
            AND deleted_at IS NOT NULL
            AND deleted_at < $3`,
        [candidate.id, candidate.company_id, cutoff]
      );
      deletedCount += removed.rowCount ?? 0;
      await client.query(`RELEASE SAVEPOINT ${MIX_BATCH_PURGE_SAVEPOINT}`);
    } catch (err: unknown) {
      await client.query(`ROLLBACK TO SAVEPOINT ${MIX_BATCH_PURGE_SAVEPOINT}`);
      await client.query(`RELEASE SAVEPOINT ${MIX_BATCH_PURGE_SAVEPOINT}`);
      failedCount += 1;
      const databaseError = extractDatabaseErrorMetadata(err);
      logger.error("[Purge] Mix batch could not be safely purged; retained it and continuing.", {
        mixBatchId: candidate.id,
        companyId: candidate.company_id,
        batchCode: candidate.batch_code,
        error: getErrorMessage(err),
        dbErrorCode: databaseError.code,
        dbConstraint: databaseError.constraint,
        dbTable: databaseError.table,
        dbColumn: databaseError.column,
        dbDetail: databaseError.detail,
      });
    }
  }

  if (deletedCount > 0) {
    logger.info(`[Purge] Permanently deleted ${deletedCount} unreferenced factory mix batch(es) older than 30 days.`);
  }
  if (protectedCount > 0) {
    logger.info(
      "[Purge] Retained soft-deleted factory mix batches because production/history references still exist.",
      {
        protectedCount,
        samples: protectedSamples,
      }
    );
  }
  if (failedCount > 0) {
    logger.warn("[Purge] Some factory mix batches were retained after isolated purge errors.", { failedCount });
  }
}

export async function purgeOldSoftDeletes(): Promise<void> {
  const client = await pool.connect();
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    await client.query("BEGIN");

    // ── Stock Items (must clear FK children first) ──────────────────────────
    await runIsolatedPurgeUnit(client, "stock_items", async () => {
      const oldStockItems = await client.query<{ id: number }>(
        `SELECT id FROM stock_items WHERE deleted_at IS NOT NULL AND deleted_at < $1`,
        [cutoff]
      );
      if (oldStockItems.rows.length === 0) return;

      const ids = oldStockItems.rows.map((r) => r.id);
      const placeholders = ids.map((_, i) => `$${i + 1}`).join(",");
      await client.query(`DELETE FROM sales_items                       WHERE stock_item_id IN (${placeholders})`, ids);
      await client.query(`DELETE FROM stock_adjustment_items            WHERE stock_item_id IN (${placeholders})`, ids);
      await client.query(`DELETE FROM stock_transfer_items              WHERE stock_item_id IN (${placeholders})`, ids);
      await client.query(`DELETE FROM stock_transfer_revision_items     WHERE stock_item_id IN (${placeholders})`, ids);
      await client.query(`DELETE FROM po_line_items                     WHERE stock_item_id IN (${placeholders})`, ids);
      await client.query(`DELETE FROM container_offload_items           WHERE stock_item_id IN (${placeholders})`, ids);
      await client.query(`DELETE FROM credit_note_items                 WHERE stock_item_id IN (${placeholders})`, ids);
      await client.query(`DELETE FROM inventory                         WHERE stock_item_id IN (${placeholders})`, ids);
      await client.query(`DELETE FROM waste_dispatch_items              WHERE stock_item_id IN (${placeholders})`, ids);
      await client.query(
        `DELETE FROM stock_group_location_archive_items WHERE stock_item_id IN (${placeholders})`,
        ids
      );
      await client.query(`DELETE FROM stock_item_code_aliases           WHERE stock_item_id IN (${placeholders})`, ids);
      await client.query(`DELETE FROM stock_item_location_prices        WHERE stock_item_id IN (${placeholders})`, ids);
      await client.query(`DELETE FROM stock_items WHERE id IN (${placeholders})`, ids);
      logger.info(`[Purge] Permanently deleted ${ids.length} stock item(s) older than 30 days.`);
    });

    // Mix batches are not a simple purge target: their sources/usages are historical
    // factory records and must not be silently deleted by the automatic scheduler.
    await purgeOldFactoryMixBatches(client, cutoff);

    // ── Other soft-delete tables ─────────────────────────────────────────────
    // Each table is isolated so a restrictive FK/schema-drift issue in one table
    // does not roll back unrelated cleanup completed by the same scheduled run.
    const simplePurges: Array<{ table: string; col: string }> = [
      { table: "stock_groups", col: "deleted_at" },
      { table: "locations", col: "deleted_at" },
      { table: "ledger_accounts", col: "deleted_at" },
      { table: "employees", col: "deleted_at" },
      { table: "customers", col: "deleted_at" },
      { table: "suppliers", col: "deleted_at" },
      { table: "bank_accounts", col: "deleted_at" },
      { table: "factory_categories", col: "deleted_at" },
      { table: "factory_bale_products", col: "deleted_at" },
      { table: "factory_containers", col: "deleted_at" },
      { table: "factory_raw_stock", col: "deleted_at" },
      { table: "factory_raw_material_adjustments", col: "deleted_at" },
      { table: "factory_bales", col: "deleted_at" },
      { table: "customer_proformas", col: "deleted_at" },
      { table: "customer_orders", col: "deleted_at" },
    ];

    for (const { table, col } of simplePurges) {
      await runIsolatedPurgeUnit(client, table, async () => {
        const result = await client.query(`DELETE FROM ${table} WHERE ${col} IS NOT NULL AND ${col} < $1`, [cutoff]);
        if (result.rowCount && result.rowCount > 0) {
          logger.info(`[Purge] Permanently deleted ${result.rowCount} ${table} row(s) older than 30 days.`);
        }
      });
    }

    await client.query("COMMIT");
    logger.info("[Purge] 30-day soft-delete purge complete.");
  } catch (err: unknown) {
    await client.query("ROLLBACK").catch(() => {});
    logger.error("[Purge] Fatal error during soft-delete purge (transaction rolled back):", {
      error: getErrorMessage(err),
    });
    throw err;
  } finally {
    client.release();
  }
}

// ── Containers WhatsApp scheduled send ────────────────────────────────────────

export async function checkAndRunContainersWhatsApp(): Promise<void> {
  try {
    const { getContainersWaSettings, sendWhatsAppFileToChatId, markContainersWaSent } =
      await import("../whatsappService");
    const settings = await getContainersWaSettings();

    if (!settings?.scheduleEnabled || !settings?.groupChatId) return;
    if (!settings?.instanceId || !settings?.apiToken || !settings?.enabled) return;

    const recipientKey = `group:${settings.groupChatId}`;
    let claim = await claimRetryableScheduledWhatsAppOccurrence({
      jobType: "containers_report",
      recipientKey,
      recipientChatId: settings.groupChatId,
    });

    if (!claim) {
      const nowInNewYork = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
      if (nowInNewYork.getHours() !== settings.scheduleHour) return;

      // Preserve the existing 12-hour duplicate-suppression rule for successful sends.
      if (settings.lastSentAt) {
        const hoursSince = (Date.now() - new Date(settings.lastSentAt).getTime()) / (1000 * 60 * 60);
        if (hoursSince < 12) {
          logger.info("[ContainersWA] Already sent within 12 h — skipping.");
          return;
        }
      }

      const localDate = [
        nowInNewYork.getFullYear(),
        String(nowInNewYork.getMonth() + 1).padStart(2, "0"),
        String(nowInNewYork.getDate()).padStart(2, "0"),
      ].join("-");

      claim = await claimScheduledWhatsAppOccurrence({
        jobType: "containers_report",
        recipientKey,
        recipientChatId: settings.groupChatId,
        scheduledLocalDate: localDate,
        scheduledLocalHour: settings.scheduleHour,
        attachmentKeys: ["pdf"],
      });
    }

    if (!claim?.acquired) {
      if (claim) {
        logger.info("[ContainersWA] Occurrence already owned or completed — skipping.", {
          occurrenceKey: claim.occurrenceKey,
          recipient: recipientKey,
          result: claim.status,
        });
      }
      return;
    }

    const pdfState = claim.attachments.find((attachment) => attachment.key === "pdf");
    if (pdfState?.status !== "sent") {
      let generated: Awaited<
        ReturnType<(typeof import("../../helpers/generateContainersPdf"))["generateContainersPdf"]>
      > | null = null;
      try {
        const { generateContainersPdf } = await import("../../helpers/generateContainersPdf");
        generated = await generateContainersPdf();
      } catch (error) {
        const attempt = await recordScheduledWhatsAppAttachmentPreparationFailure({
          claim,
          attachmentKey: "pdf",
          error,
        });
        if (attempt) {
          await logScheduledWhatsAppAttachmentResult({
            claim,
            recipient: recipientKey,
            attachment: "pdf",
            attempt,
            success: false,
            error,
          });
        }
      }

      if (generated) {
        const attempt = await beginScheduledWhatsAppAttachmentAttempt(claim, "pdf");
        if (attempt) {
          const fileName = `Containers_${claim.scheduledLocalDate}.pdf`;
          let result: Awaited<ReturnType<typeof sendWhatsAppFileToChatId>> | null = null;
          try {
            result = await sendWhatsAppFileToChatId(
              settings.groupChatId,
              generated.buffer,
              fileName,
              "",
              "application/pdf"
            );
          } catch (error) {
            await finishScheduledWhatsAppAttachmentAttempt({
              claim,
              attachmentKey: "pdf",
              success: false,
              error: getErrorMessage(error),
            });
            await logScheduledWhatsAppAttachmentResult({
              claim,
              recipient: recipientKey,
              attachment: "pdf",
              attempt,
              success: false,
              error,
            });
          }

          if (result) {
            if (result.deliveryOutcome === "uncertain") {
              await recordScheduledWhatsAppAttachmentUncertain({
                claim,
                attachmentKey: "pdf",
                error: result.error,
              });
              await logScheduledWhatsAppAttachmentResult({
                claim,
                recipient: recipientKey,
                attachment: "pdf",
                attempt,
                success: false,
                error: result.error,
              });
            } else {
              await finishScheduledWhatsAppAttachmentAttempt({
                claim,
                attachmentKey: "pdf",
                success: result.success,
                error: result.error,
              });
              await logScheduledWhatsAppAttachmentResult({
                claim,
                recipient: recipientKey,
                attachment: "pdf",
                attempt,
                success: result.success,
                error: result.error,
              });
              if (result.success) {
                logger.info("[ContainersWA] PDF sent.", {
                  occurrenceKey: claim.occurrenceKey,
                  recipient: recipientKey,
                  attachment: "pdf",
                  attempt,
                  result: "sent",
                  rowCount: generated.rowCount,
                });
              }
            }
          }
        }
      }
    }

    const final = await finalizeScheduledWhatsAppOccurrence(claim);
    if (final.allSent) {
      await markContainersWaSent();
      logger.info("[ContainersWA] Occurrence complete — last sent timestamp updated.", {
        occurrenceKey: claim.occurrenceKey,
        recipient: recipientKey,
        result: "sent",
      });
    } else {
      logger.warn("[ContainersWA] Occurrence incomplete — known failures may retry; uncertain sends stay blocked.", {
        occurrenceKey: claim.occurrenceKey,
        recipient: recipientKey,
        result: final.status,
        error: final.error,
      });
    }
  } catch (err: unknown) {
    logger.error("[ContainersWA] Error:", { error: getErrorMessage(err) });
  }
}

/** Manually trigger the daily ZIP → WhatsApp send (bypasses the dailyAutoSend schedule toggle).
 *  Pass fromDate / toDate (YYYY-MM-DD) to scope the export; omit for full history.
 *  Retries up to 3 times (30 s between attempts) on actual send failures.
 *  Records the attempt in daily_export_runs.
 *  Throws an Error with a human-readable message if WhatsApp is not configured or the send fails.
 */
export async function triggerDailyWhatsAppSendNow(fromDate?: string, toDate?: string): Promise<{ message: string }> {
  const runId = await createExportRun("manual_whatsapp");
  logger.info(`[ManualWhatsApp] Run id=${runId} started.`);

  const companies = await fetchAllCompanies();
  if (!companies || companies.length === 0) {
    await finishExportRun(runId, { status: "failed", skippedReason: "No companies found." });
    throw new Error("No companies found.");
  }

  const today = getTodayLabel();
  let zip: Buffer, names: string[], skipped: string[];
  try {
    ({ zip, names, skipped } = await buildFullExportZip(companies, fromDate, toDate));
  } catch (err: unknown) {
    await finishExportRun(runId, { status: "failed", skippedReason: getErrorMessage(err) });
    throw err;
  }

  await updateExportRun(runId, {
    companiesCount: companies.length,
    companyFilesCount: names.length,
    zipSizeBytes: getExportAttachmentSize(zip),
    skippedCompanies: skipped.join(", ") || null,
    whatsappAttempted: true,
  });

  const rangeLabel = fromDate || toDate ? ` (${fromDate || "start"} → ${toDate || "today"})` : " (full history)";
  const skippedNote = skipped.length > 0 ? ` (${skipped.length} skipped)` : "";

  // Retry up to 3× with 30-second delays (manual trigger is interactive — shorter delay)
  const waRes = await retryAsync({
    label: "ManualWhatsApp",
    attempts: 3,
    delayMs: 30 * 1000,
    fn: () => runDailyWhatsAppSend(zip, today, companies, { bypassAutoSendCheck: true }),
    isSuccess: (r) => r.sent,
    shouldRetry: (r) => !r.skipped && (!r.error || !isWaConfigError(r.error)),
    onAttempt: (n) => logger.info(`[ManualWhatsApp] Attempt ${n}/3...`),
  });

  const result = waRes.result;

  if (result.skipped) {
    await finishExportRun(runId, {
      status: "failed",
      whatsappSuccess: false,
      whatsappError: result.skipReason,
      whatsappAttempts: waRes.attempts,
    });
    throw new Error(
      `WhatsApp not configured or not ready: ${result.skipReason}. ` +
        `Please enable WhatsApp and select a Daily Export recipient in WhatsApp settings.`
    );
  }

  if (!result.sent) {
    await finishExportRun(runId, {
      status: "failed",
      whatsappSuccess: false,
      whatsappError: result.error || "Unknown error",
      whatsappAttempts: waRes.attempts,
    });
    throw new Error(`WhatsApp send failed after ${waRes.attempts} attempt(s): ${result.error || "Unknown error"}`);
  }

  await finishExportRun(runId, {
    status: "success",
    whatsappSuccess: true,
    whatsappAttempts: waRes.attempts,
  });

  logger.info(`[ManualWhatsApp] Run ${runId} succeeded (attempt ${waRes.attempts}).`);
  return { message: `Daily ZIP sent to WhatsApp — ${names.length} companies${rangeLabel}${skippedNote}.` };
}

export { runDailyExport };

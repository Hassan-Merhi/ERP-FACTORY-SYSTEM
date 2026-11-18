import { pool } from "../../db";
import type { PostOffloadHistoricalReplayResult } from "./postOffloadHistoricalReplay";
import {
  POST_OFFLOAD_REPORT_QUERY_KEYS,
  closeEnough,
  errorMessage,
  loadDaybook,
  metadata,
  parseDecimal,
  reconcileActiveVoucher,
  uniqueIssues,
  verifyOriginalDaybook,
  type ChargeRow,
  type PostOffloadReconciliationResult,
  type PostOffloadReconciliationStatus,
  type ReconciliationQueryClient,
} from "./postOffloadReconciliationReconcileActiveVoucher";
export { POST_OFFLOAD_REPORT_QUERY_KEYS } from "./postOffloadReconciliationReconcileActiveVoucher";
export type {
  PostOffloadReconciliationResult,
  PostOffloadReconciliationStatus,
} from "./postOffloadReconciliationReconcileActiveVoucher";

async function verifyDeletedCharge(params: {
  client: ReconciliationQueryClient;
  companyId: number;
  containerId: number;
  charge: ChargeRow;
  accountingIssues: string[];
}): Promise<{ voucherChecked: boolean; reversalChecked: boolean; daybookChecked: boolean }> {
  const { client, companyId, containerId, charge, accountingIssues } = params;
  let voucherChecked = false;

  if (charge.voucher_id) {
    const voucherResult = await client.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM vouchers WHERE id = $1 FOR UPDATE`,
      [charge.voucher_id]
    );
    voucherChecked = true;
    if (!voucherResult.rows[0]) {
      accountingIssues.push(`charge ${charge.id}: deleted charge voucher is missing`);
    } else if (!voucherResult.rows[0].deleted_at) {
      accountingIssues.push(`charge ${charge.id}: deleted charge still has an active voucher`);
    }
  }

  const original = await loadDaybook(client, charge.daybook_entry_id);
  verifyOriginalDaybook({ row: original, companyId, containerId, charge, issues: accountingIssues });
  const reversal = await loadDaybook(client, charge.reversal_daybook_entry_id);
  if (!reversal) {
    accountingIssues.push(`charge ${charge.id}: deleted charge has no reversing daybook entry`);
    return { voucherChecked, reversalChecked: false, daybookChecked: Boolean(original) };
  }
  if (!original) {
    return { voucherChecked, reversalChecked: true, daybookChecked: false };
  }

  const reversalMeta = metadata(reversal.meta_json);
  if (
    reversal.company_id !== companyId ||
    reversal.reference_id !== containerId ||
    reversal.tx_type !== "OTHER_CHARGE" ||
    reversalMeta.sourceType !== "POST_OFFLOAD_ADDITIONAL_REVERSAL" ||
    Number(reversalMeta.chargeId) !== charge.id ||
    Number(reversalMeta.reversesDaybookEntryId) !== original.id
  ) {
    accountingIssues.push(`charge ${charge.id}: reversing daybook scope or metadata is invalid`);
  }
  if (!closeEnough(parseDecimal(reversal.amount_currency), parseDecimal(original.amount_currency).negated(), "0.01")) {
    accountingIssues.push(`charge ${charge.id}: reversing transaction amount does not negate the original`);
  }
  if (!closeEnough(parseDecimal(reversal.amount_usd), parseDecimal(original.amount_usd).negated(), "0.01")) {
    accountingIssues.push(`charge ${charge.id}: reversing USD amount does not negate the original`);
  }

  return { voucherChecked, reversalChecked: true, daybookChecked: true };
}

export async function reconcilePostOffloadMutation(params: {
  companyId: number;
  containerId: number;
  chargeId?: number | null;
  mutationAction: "CREATE" | "EDIT" | "UNDO" | "LEGACY_REBUILD";
  userId: string;
  username?: string | null;
  historicalReplay?: PostOffloadHistoricalReplayResult | null;
}): Promise<PostOffloadReconciliationResult> {
  const {
    companyId,
    containerId,
    chargeId = null,
    mutationAction,
    userId,
    username = null,
    historicalReplay = null,
  } = params;
  const client = (await pool.connect()) as unknown as ReconciliationQueryClient & { release(): void };
  let transactionStarted = false;

  const accountingIssues: string[] = [];
  const inventoryIssues: string[] = [];
  const undoIssues: string[] = [];
  let chargesChecked = 0;
  let activeVouchersChecked = 0;
  let voucherEntriesNormalized = 0;
  let daybookEntriesChecked = 0;
  let reversalsChecked = 0;
  let rawStockRowsChecked = 0;
  let containerCostPerKgUsd: string | null = null;
  let undoLogId: number | null = null;
  let undoFingerprint: string | null = null;
  let undoAlreadyUndone = false;

  try {
    await client.query("BEGIN");
    transactionStarted = true;
    await client.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    await client.query("SELECT pg_advisory_xact_lock(9004, $1)", [companyId]);

    const containerResult = await client.query<{
      id: number;
      rate_per_kg_usd: string | null;
    }>(
      `SELECT id, rate_per_kg_usd
       FROM factory_containers
       WHERE id = $1 AND company_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [containerId, companyId]
    );
    const container = containerResult.rows[0];
    if (!container) throw new Error("Post-offload reconciliation container was not found in the selected company.");
    containerCostPerKgUsd = container.rate_per_kg_usd;

    const chargeResult = await client.query<ChargeRow>(
      `SELECT id, amount, currency_code, fx_rate_to_usd, ledger_account_id,
              supplier_id, voucher_id, daybook_entry_id,
              reversal_daybook_entry_id, deleted_at
       FROM factory_offload_additional_charges
       WHERE company_id = $1 AND container_id = $2
       ORDER BY id
       FOR UPDATE`,
      [companyId, containerId]
    );
    chargesChecked = chargeResult.rows.length;
    if (chargesChecked === 0) {
      accountingIssues.push("container has no post-offload charge rows to reconcile");
    }

    for (const charge of chargeResult.rows) {
      if (charge.deleted_at) {
        const checked = await verifyDeletedCharge({
          client,
          companyId,
          containerId,
          charge,
          accountingIssues,
        });
        if (checked.voucherChecked) activeVouchersChecked += 1;
        if (checked.daybookChecked) daybookEntriesChecked += 1;
        if (checked.reversalChecked) reversalsChecked += 1;
        continue;
      }

      const originalDaybook = await loadDaybook(client, charge.daybook_entry_id);
      verifyOriginalDaybook({
        row: originalDaybook,
        companyId,
        containerId,
        charge,
        issues: accountingIssues,
      });
      if (originalDaybook) daybookEntriesChecked += 1;

      const voucher = await reconcileActiveVoucher({ client, charge, accountingIssues });
      if (voucher.voucherChecked) activeVouchersChecked += 1;
      voucherEntriesNormalized += voucher.entriesNormalized;
    }

    const rawStockResult = await client.query<{
      id: number;
      cost_per_kg_usd: string | null;
    }>(
      `SELECT id, cost_per_kg_usd
       FROM factory_raw_stock
       WHERE company_id = $1 AND container_id = $2
       ORDER BY id
       FOR UPDATE`,
      [companyId, containerId]
    );
    rawStockRowsChecked = rawStockResult.rows.length;
    if (rawStockRowsChecked === 0) {
      inventoryIssues.push("container has no linked raw-stock row");
    }

    const expectedContainerRate = parseDecimal(container.rate_per_kg_usd);
    for (const row of rawStockResult.rows) {
      if (!closeEnough(parseDecimal(row.cost_per_kg_usd), expectedContainerRate, "0.000001")) {
        inventoryIssues.push(`raw-stock ${row.id}: cost per kg does not match the container canonical USD rate`);
      }
    }
    if (!historicalReplay) {
      inventoryIssues.push("historical replay result is missing from the post-offload response");
    } else if (historicalReplay.status === "blocked" || historicalReplay.status === "failed") {
      inventoryIssues.push(
        `historical supplier-cost replay ${historicalReplay.status}: ${historicalReplay.reason || "repair required"}`
      );
    }

    const undoRequired = historicalReplay?.status === "applied";
    if (undoRequired) {
      const replayRecordId = chargeId ?? containerId;
      const auditResult = await client.query<{
        fingerprint: string | null;
      }>(
        `SELECT changes::jsonb ->> 'fingerprint' AS fingerprint
         FROM audit_log
         WHERE company_id = $1
           AND action = 'post_offload_historical_replay_applied'
           AND table_name = 'factory_offload_additional_charges'
           AND record_id = $2
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
        [companyId, replayRecordId]
      );
      undoFingerprint = auditResult.rows[0]?.fingerprint ?? null;
      if (!undoFingerprint) {
        undoIssues.push("historical replay audit fingerprint is missing");
      } else {
        const undoResult = await client.query<{
          id: number;
          undone_at: Date | null;
        }>(
          `SELECT id, undone_at
           FROM factory_recalc_undo_log
           WHERE company_id = $1
             AND operation_type = 'HISTORICAL_REPLAY_EXACT'
             AND scope_fingerprint = $2
           ORDER BY applied_at DESC NULLS LAST, id DESC
           LIMIT 1`,
          [companyId, undoFingerprint]
        );
        undoLogId = undoResult.rows[0]?.id ?? null;
        undoAlreadyUndone = Boolean(undoResult.rows[0]?.undone_at);
        if (!undoLogId) undoIssues.push("exact historical replay undo snapshot is missing");
        if (undoAlreadyUndone) undoIssues.push("exact historical replay undo snapshot has already been used");
      }
    }

    const allIssues = uniqueIssues([...accountingIssues, ...inventoryIssues, ...undoIssues]);
    const status: PostOffloadReconciliationStatus = allIssues.length === 0 ? "reconciled" : "repair_required";
    const result: PostOffloadReconciliationResult = {
      status,
      companyId,
      containerId,
      chargeId,
      accounting: {
        chargesChecked,
        activeVouchersChecked,
        voucherEntriesNormalized,
        daybookEntriesChecked,
        reversalsChecked,
        issues: uniqueIssues(accountingIssues),
      },
      inventory: {
        rawStockRowsChecked,
        containerCostPerKgUsd,
        issues: uniqueIssues(inventoryIssues),
      },
      reports: {
        serverReadCacheInvalidated: true,
        derivedFromLiveCostTables: true,
        queryKeys: POST_OFFLOAD_REPORT_QUERY_KEYS,
      },
      undo: {
        required: undoRequired,
        available: Boolean(undoLogId) && !undoAlreadyUndone,
        undoLogId,
        fingerprint: undoFingerprint,
        alreadyUndone: undoAlreadyUndone,
        issues: uniqueIssues(undoIssues),
      },
      issues: allIssues,
    };

    await client.query(
      `INSERT INTO audit_log
         (user_id, username, company_id, action, table_name, record_id,
          record_identifier, changes, created_at)
       VALUES ($1, $2, $3, 'post_offload_reconciliation_completed',
               'factory_offload_additional_charges', $4, $5, $6::jsonb, NOW())`,
      [
        userId || null,
        username,
        companyId,
        chargeId ?? containerId,
        `post-offload ${mutationAction.toLowerCase()} reconciliation — container ${containerId}`,
        JSON.stringify({
          mutationAction,
          historicalReplayStatus: historicalReplay?.status ?? null,
          status,
          accounting: result.accounting,
          inventory: result.inventory,
          reports: result.reports,
          undo: result.undo,
        }),
      ]
    );

    await client.query("COMMIT");
    transactionStarted = false;
    return result;
  } catch (error) {
    if (transactionStarted) await client.query("ROLLBACK");
    const issue = errorMessage(error);
    return {
      status: "failed",
      companyId,
      containerId,
      chargeId,
      accounting: {
        chargesChecked,
        activeVouchersChecked,
        voucherEntriesNormalized,
        daybookEntriesChecked,
        reversalsChecked,
        issues: uniqueIssues([...accountingIssues, issue]),
      },
      inventory: {
        rawStockRowsChecked,
        containerCostPerKgUsd,
        issues: uniqueIssues(inventoryIssues),
      },
      reports: {
        serverReadCacheInvalidated: true,
        derivedFromLiveCostTables: true,
        queryKeys: POST_OFFLOAD_REPORT_QUERY_KEYS,
      },
      undo: {
        required: historicalReplay?.status === "applied",
        available: false,
        undoLogId,
        fingerprint: undoFingerprint,
        alreadyUndone: undoAlreadyUndone,
        issues: uniqueIssues(undoIssues),
      },
      issues: uniqueIssues([...accountingIssues, ...inventoryIssues, ...undoIssues, issue]),
    };
  } finally {
    client.release();
  }
}

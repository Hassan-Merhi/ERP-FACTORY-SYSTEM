// Full offline mode (Phase A3): keeps a PC's local database equal to the cloud.
//
// One run of syncOnce():
//   1. First time only: ask the cloud for a start cursor, refuse if the cloud's
//      schema version differs from the PC's, and list the tables to copy.
//   2. Copy every table not copied yet, page by page. Each page and its
//      progress commit together, so a PC switched off mid-copy resumes there.
//   3. Replay the change feed from the cursor until up to date, applying a
//      change to a row only when its seq is higher than the last one applied.
//      A TRUNCATE in the feed empties that table and copies it again.
// The cloud decides which companies the signed-in user may hold; the PC never
// asks for a company.

import bcrypt from "bcryptjs";
import {
  applyCopiedRow,
  applyFeedChange,
  inApplyTransaction,
  localSchemaVersion,
  readLocalState,
  restoreLocalLogins,
} from "./localStore.mjs";

export class PcSyncAgentError extends Error {
  /** @param {string} code @param {Record<string, unknown>} [detail] */
  constructor(code, detail = {}) {
    super(code);
    this.name = "PcSyncAgentError";
    this.code = code;
    this.detail = detail;
  }
}

/** Hours without a completed sync before the PC warns, and before it stops new entries. */
export const PC_SYNC_WARN_AFTER_HOURS = 24;
export const PC_SYNC_BLOCK_AFTER_HOURS = 48;

/**
 * How current the PC is. `blockNewEntries` follows the owner's rule: 2 days
 * without a completed sync stops new entries; reading always works.
 */
export function pcSyncFreshness(lastSyncAt, now = new Date()) {
  if (!lastSyncAt) return { level: "never", hours: null, warn: true, blockNewEntries: true };
  const hours = (now.getTime() - new Date(lastSyncAt).getTime()) / 3_600_000;
  return {
    level: hours >= PC_SYNC_BLOCK_AFTER_HOURS ? "blocked" : hours >= PC_SYNC_WARN_AFTER_HOURS ? "warn" : "current",
    hours,
    warn: hours >= PC_SYNC_WARN_AFTER_HOURS,
    blockNewEntries: hours >= PC_SYNC_BLOCK_AFTER_HOURS,
  };
}

async function cloudGet(cloud, path, query) {
  const res = await cloud.get(path, query);
  if (res.status !== 200) {
    throw new PcSyncAgentError(res.body?.code || "PC_SYNC_CLOUD_REFUSED", { status: res.status, path });
  }
  return res.body;
}

/**
 * @param {{ query: Function }} local a client of the PC's local database
 * @param {{ get(path: string, query?: Record<string, unknown>): Promise<{ status: number, body: any }> }} cloud
 * @param {{ pageSize?: number, maxPages?: number }} [options]
 */
export async function syncOnce(local, cloud, { pageSize, maxPages = 10_000 } = {}) {
  let pages = 0;
  const report = { copiedRows: 0, appliedChanges: 0, skippedChanges: 0, upToDate: false };
  let state = await readLocalState(local);

  if (!state.cursor) {
    const start = await cloudGet(cloud, "/api/offline/pc-sync/snapshot/start");
    const mine = await localSchemaVersion(local);
    if (start.schemaVersion !== mine) {
      throw new PcSyncAgentError("PC_LOCAL_SCHEMA_MISMATCH", { cloud: start.schemaVersion, local: mine });
    }
    await inApplyTransaction(local, async () => {
      await local.query(
        "UPDATE pc_local.state SET cursor = $1, schema_version = $2, tables = $3, copy_complete = false, updated_at = now() WHERE id = 1",
        [start.cursor, start.schemaVersion, start.tables]
      );
      await local.query("DELETE FROM pc_local.copy_progress");
      await local.query(
        "INSERT INTO pc_local.copy_progress (table_name) SELECT unnest($1::text[])",
        [start.tables]
      );
    });
    state = await readLocalState(local);
  }
  else {
    // Every run, not only the first: after a cloud migration the PC must stop
    // (and be updated) rather than apply rows of a schema it does not have.
    const start = await cloudGet(cloud, "/api/offline/pc-sync/snapshot/start");
    const mine = await localSchemaVersion(local);
    if (start.schemaVersion !== state.schema_version || start.schemaVersion !== mine) {
      throw new PcSyncAgentError("PC_LOCAL_SCHEMA_MISMATCH", { cloud: start.schemaVersion, local: mine });
    }
  }
  const synced = new Set(state.tables);

  for (;;) {
    // Copy whatever is not copied yet (everything the first time, a truncated table later).
    const { rows: pending } = await local.query(
      "SELECT table_name, after FROM pc_local.copy_progress WHERE NOT done ORDER BY table_name"
    );
    for (const { table_name: table, after: startAfter } of pending) {
      let after = startAfter;
      for (;;) {
        if (pages++ >= maxPages) return report;
        const page = await cloudGet(cloud, "/api/offline/pc-sync/snapshot", {
          table,
          ...(after ? { after } : {}),
          ...(pageSize ? { limit: pageSize } : {}),
        });
        await inApplyTransaction(local, async () => {
          for (const { key, row } of page.rows) await applyCopiedRow(local, table, key, row);
          await local.query("UPDATE pc_local.copy_progress SET after = $2, done = $3 WHERE table_name = $1", [
            table,
            page.after,
            page.after == null,
          ]);
        });
        report.copiedRows += page.rows.length;
        after = page.after;
        if (after == null) break;
      }
    }
    await local.query("UPDATE pc_local.state SET copy_complete = true, updated_at = now() WHERE id = 1");

    // Replay the feed. Stop after a page that truncated a table so it is copied again first.
    let recopy = false;
    let cursor = (await readLocalState(local)).cursor;
    while (!recopy) {
      if (pages++ >= maxPages) return report;
      const page = await cloudGet(cloud, "/api/offline/pc-sync/changes", {
        cursor,
        ...(pageSize ? { limit: pageSize } : {}),
      });
      await inApplyTransaction(local, async () => {
        for (const change of page.changes) {
          if (!synced.has(change.table)) continue;
          if (change.op === "T") {
            await local.query("SELECT pc_local.clear_table($1)", [change.table]);
            await local.query(
              "UPDATE pc_local.copy_progress SET after = NULL, done = false WHERE table_name = $1",
              [change.table]
            );
            recopy = true;
            continue;
          }
          if (await applyFeedChange(local, change)) report.appliedChanges += 1;
          else report.skippedChanges += 1;
        }
        await restoreLocalLogins(local);
        await local.query(
          `UPDATE pc_local.state SET cursor = $1, updated_at = now(),
                  last_sync_at = CASE WHEN $2 THEN now() ELSE last_sync_at END
            WHERE id = 1`,
          [page.cursor, page.upToDate && !recopy]
        );
      });
      cursor = page.cursor;
      if (page.upToDate && !recopy) {
        report.upToDate = true;
        return report;
      }
    }
  }
}

/**
 * Remembers the password of someone who just signed in to the cloud on this PC,
 * so they can sign in to the local copy while offline. Stored as a bcrypt hash.
 */
export async function rememberLocalLogin(local, userId, password) {
  if (typeof userId !== "string" || !userId || userId.length > 200 || typeof password !== "string" || !password) {
    throw new PcSyncAgentError("PC_LOCAL_LOGIN_INVALID");
  }
  const hash = await bcrypt.hash(password, 12);
  await local.query(
    `INSERT INTO pc_local.local_logins (user_id, password_hash) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET password_hash = EXCLUDED.password_hash, updated_at = now()`,
    [userId, hash]
  );
  await restoreLocalLogins(local);
}

/**
 * Binds this PC's copy to the cloud account that just connected. The copy holds
 * that account's companies, so a different account starts again from an empty
 * copy instead of keeping the previous account's rows. Returns true when the
 * copy was reset.
 */
export async function bindCloudAccount(local, userId) {
  const state = await readLocalState(local);
  if (state.cloud_user_id === userId) return false;
  const reset = state.cloud_user_id != null && state.cloud_user_id !== userId;
  await inApplyTransaction(local, async () => {
    if (reset) {
      for (const table of state.tables) await local.query("SELECT pc_local.clear_table($1)", [table]);
      await local.query("DELETE FROM pc_local.copy_progress");
      await local.query("DELETE FROM pc_local.applied");
      await local.query(
        `UPDATE pc_local.state SET cursor = NULL, schema_version = NULL, tables = '{}', copy_complete = false,
                last_sync_at = NULL WHERE id = 1`
      );
    }
    await local.query("UPDATE pc_local.state SET cloud_user_id = $1, updated_at = now() WHERE id = 1", [userId]);
  });
  return reset;
}

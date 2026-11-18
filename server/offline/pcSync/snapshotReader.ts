/**
 * Full offline mode (Phase A2): the initial full copy a new PC downloads.
 *
 * 1. startPcSyncSnapshot: the feed cursor at the current watermark, the synced
 *    tables and the cloud's schema version (a PC with a different schema must
 *    refuse to load).
 * 2. readPcSyncSnapshotPage: one table at a time, in key order, only rows of
 *    the companies the signed-in user may open, secret columns removed.
 * 3. The PC then replays the change feed from the start cursor. A row changed
 *    while the copy was being read is repaired by the feed's apply rule (apply
 *    only a higher seq; copied rows count as seq 0).
 */
import type { PoolClient } from "pg";
import { PC_SYNC_START, encodePcSyncCursor } from "./changeFeedReader";

export const PC_SYNC_SNAPSHOT_PAGE_DEFAULT = 500;

export interface PcSyncSnapshotStart {
  /** Feed cursor to replay from once every table is loaded. */
  cursor: string;
  tables: string[];
  schemaVersion: string | null;
}

export interface PcSyncSnapshotPage {
  table: string;
  rows: Array<{ key: Record<string, unknown>; row: Record<string, unknown> }>;
  /** Pass back as `after` for the next page; null when the table is done. */
  after: string | null;
}

export class PcSyncSnapshotRefusal extends Error {
  constructor(code: "OFFLINE_PC_SYNC_TABLE_NOT_SYNCED" | "OFFLINE_PC_SYNC_AFTER_INVALID") {
    super(code);
    this.name = "PcSyncSnapshotRefusal";
  }
}

const TABLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export function encodePcSyncSnapshotAfter(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}

/** The key the previous page ended on: a flat object of at most 8 scalar values. */
export function decodePcSyncSnapshotAfter(value: unknown): Record<string, unknown> | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || value.length > 1000)
    throw new PcSyncSnapshotRefusal("OFFLINE_PC_SYNC_AFTER_INVALID");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new PcSyncSnapshotRefusal("OFFLINE_PC_SYNC_AFTER_INVALID");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new PcSyncSnapshotRefusal("OFFLINE_PC_SYNC_AFTER_INVALID");
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (
    entries.length === 0 ||
    entries.length > 8 ||
    entries.some(
      ([name, cell]) =>
        !TABLE_NAME.test(name) || !(typeof cell === "string" || typeof cell === "number" || typeof cell === "boolean")
    )
  ) {
    throw new PcSyncSnapshotRefusal("OFFLINE_PC_SYNC_AFTER_INVALID");
  }
  return parsed as Record<string, unknown>;
}

export async function pcSyncSnapshotInstalled(client: Pick<PoolClient, "query">): Promise<boolean> {
  const { rows } = await client.query(
    "SELECT to_regprocedure('pc_sync.snapshot_page(text, integer[], jsonb, integer)') IS NOT NULL AS installed"
  );
  return rows[0]?.installed === true;
}

export async function startPcSyncSnapshot(client: Pick<PoolClient, "query">): Promise<PcSyncSnapshotStart> {
  // The watermark first: everything below it is already committed, so every
  // page read afterwards includes it, and everything from it on is in the feed.
  const watermark = String((await client.query("SELECT pc_sync.watermark() AS watermark")).rows[0].watermark);
  const tables = (await client.query("SELECT t AS table_name FROM pc_sync.snapshot_tables() AS t")).rows.map((row) =>
    String(row.table_name)
  );
  const version = (await client.query("SELECT pc_sync.schema_version() AS version")).rows[0]?.version;
  return {
    cursor: encodePcSyncCursor({ ...PC_SYNC_START, from: watermark }),
    tables,
    schemaVersion: version == null ? null : String(version),
  };
}

export async function readPcSyncSnapshotPage(
  client: Pick<PoolClient, "query">,
  companyIds: readonly number[],
  table: unknown,
  after: Record<string, unknown> | null,
  limit: number = PC_SYNC_SNAPSHOT_PAGE_DEFAULT
): Promise<PcSyncSnapshotPage> {
  if (typeof table !== "string" || !TABLE_NAME.test(table)) {
    throw new PcSyncSnapshotRefusal("OFFLINE_PC_SYNC_TABLE_NOT_SYNCED");
  }
  const pageSize = Math.min(Math.max(Math.trunc(limit) || PC_SYNC_SNAPSHOT_PAGE_DEFAULT, 1), 1000);
  const companies = [...new Set(companyIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  let result;
  try {
    result = await client.query(
      "SELECT row_key, row_data FROM pc_sync.snapshot_page($1, $2::integer[], $3::jsonb, $4)",
      [table, companies, after == null ? null : JSON.stringify(after), pageSize]
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("PC_SYNC_TABLE_NOT_SYNCED"))
      throw new PcSyncSnapshotRefusal("OFFLINE_PC_SYNC_TABLE_NOT_SYNCED");
    throw error;
  }
  const rows = result.rows.map((row) => ({
    key: row.row_key as Record<string, unknown>,
    row: row.row_data as Record<string, unknown>,
  }));
  const last = rows.at(-1);
  return {
    table,
    rows,
    after: rows.length === pageSize && last ? encodePcSyncSnapshotAfter(last.key) : null,
  };
}

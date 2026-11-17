/**
 * Full offline mode (Phase A): reading the cloud change feed, one page at a time.
 *
 * A PC keeps its local copy current by asking for every change since its
 * cursor. The cursor is a window of transaction ids: only transactions below
 * the database's watermark (every older transaction has finished) are read, so
 * a transaction that commits late can never be skipped. Inside a window the
 * changes come in transaction order, and the cursor remembers the last one
 * returned so a large window is read in pages.
 *
 * The companies come from the signed-in user, never from the PC. A row that
 * now belongs to another company comes back as a removal with its key only.
 */
import type { PoolClient } from "pg";

export const PC_SYNC_PAGE_DEFAULT = 500;
export const PC_SYNC_PAGE_MAX = 1000;

export interface PcSyncCursor {
  /** Lowest transaction id of the window (inclusive). */
  from: string;
  /** Watermark closing the window (exclusive); null = take the current one. */
  to: string | null;
  /** Last change returned inside the window. */
  afterTxid: string;
  afterSeq: number;
}

export interface PcSyncChange {
  seq: number;
  txid: string;
  table: string;
  op: "I" | "U" | "D" | "T";
  key: Record<string, unknown> | null;
  row: Record<string, unknown> | null;
}

export interface PcSyncPage {
  changes: PcSyncChange[];
  cursor: string;
  /** True when this page reached the watermark: the PC is current as of now. */
  upToDate: boolean;
}

export class PcSyncCursorInvalid extends Error {
  constructor() {
    super("OFFLINE_PC_SYNC_CURSOR_INVALID");
    this.name = "PcSyncCursorInvalid";
  }
}

const TXID = /^(0|[1-9][0-9]{0,19})$/;
export const PC_SYNC_START: PcSyncCursor = { from: "0", to: null, afterTxid: "0", afterSeq: 0 };

export function encodePcSyncCursor(cursor: PcSyncCursor): string {
  return Buffer.from(JSON.stringify([cursor.from, cursor.to, cursor.afterTxid, cursor.afterSeq])).toString("base64url");
}

export function decodePcSyncCursor(value: unknown): PcSyncCursor {
  if (value == null || value === "") return PC_SYNC_START;
  if (typeof value !== "string" || value.length > 200) throw new PcSyncCursorInvalid();
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new PcSyncCursorInvalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw new PcSyncCursorInvalid();
  const [from, to, afterTxid, afterSeq] = parsed;
  if (typeof from !== "string" || !TXID.test(from)) throw new PcSyncCursorInvalid();
  if (to !== null && (typeof to !== "string" || !TXID.test(to) || BigInt(to) < BigInt(from))) {
    throw new PcSyncCursorInvalid();
  }
  if (typeof afterTxid !== "string" || !TXID.test(afterTxid)) throw new PcSyncCursorInvalid();
  if (!Number.isSafeInteger(afterSeq) || afterSeq < 0) throw new PcSyncCursorInvalid();
  return { from, to, afterTxid, afterSeq };
}

export async function pcSyncInstalled(client: Pick<PoolClient, "query">): Promise<boolean> {
  const { rows } = await client.query(
    "SELECT to_regprocedure('pc_sync.read_changes(text, text, text, bigint, integer[], integer)') IS NOT NULL AS installed"
  );
  return rows[0]?.installed === true;
}

export async function readPcSyncPage(
  client: Pick<PoolClient, "query">,
  companyIds: readonly number[],
  cursor: PcSyncCursor,
  limit: number = PC_SYNC_PAGE_DEFAULT
): Promise<PcSyncPage> {
  const pageSize = Math.min(Math.max(Math.trunc(limit) || PC_SYNC_PAGE_DEFAULT, 1), PC_SYNC_PAGE_MAX);
  const companies = [...new Set(companyIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
  const to = cursor.to ?? String((await client.query("SELECT pc_sync.watermark() AS watermark")).rows[0].watermark);

  const { rows } = await client.query(
    "SELECT seq, txid, table_name, op, row_key, row_data FROM pc_sync.read_changes($1, $2, $3, $4, $5::integer[], $6)",
    [cursor.from, to, cursor.afterTxid, cursor.afterSeq, companies, pageSize + 1]
  );
  const more = rows.length > pageSize;
  const changes: PcSyncChange[] = rows.slice(0, pageSize).map((row) => ({
    seq: Number(row.seq),
    txid: String(row.txid),
    table: String(row.table_name),
    op: row.op as PcSyncChange["op"],
    key: (row.row_key as Record<string, unknown> | null) ?? null,
    row: (row.row_data as Record<string, unknown> | null) ?? null,
  }));
  const last = changes.at(-1);
  const next: PcSyncCursor =
    more && last
      ? { from: cursor.from, to, afterTxid: last.txid, afterSeq: last.seq }
      : { from: to, to: null, afterTxid: "0", afterSeq: 0 };
  return { changes, cursor: encodePcSyncCursor(next), upToDate: !more };
}

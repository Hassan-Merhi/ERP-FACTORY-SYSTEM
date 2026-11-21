/**
 * The stored record of one balance-repair apply run.
 *
 * Apply writes one audit_log event per run (table "balance_repair_runs",
 * action "repair") in the same transaction as its repairs. The event holds
 * what undo needs, taken from the database at apply time: the ledger and
 * deposit values it replaced, the voucher lines it added, the vouchers it
 * un-deleted or retired, and the full inter_company_transfers rows it deleted.
 * It also holds a fingerprint of the snapshot apply returned to the client.
 *
 * Undo identifies the run by that event's id and rebuilds everything from the
 * stored event. The client snapshot only has to match the fingerprint; none
 * of its content is written. An undo writes a "reverse" event for the run, so
 * a second undo of the same run is refused.
 */
import { createHash, randomUUID } from "node:crypto";
import type { Request } from "express";
import { sql } from "drizzle-orm";
import type { DatabaseOrTransaction } from "../../db";
import { resultRows } from "../../lib/queryResult";
import { sanitizeAuditChanges, writeAuditEvent } from "../../services/audit";
import type { AuditChanges } from "../../services/audit/auditService";
import type { ApplySnapshot } from "./_helpers";

export const REPAIR_RUN_TABLE = "balance_repair_runs";

/** A full inter_company_transfers row as apply deleted it (numeric and date columns as text). */
export interface StoredTransferRow {
  id: number;
  transfer_type: string;
  from_company_id: number;
  to_company_id: number;
  transfer_date: string;
  amount: string;
  from_ledger_account_id: number;
  to_ledger_account_id: number;
  from_voucher_id: number | null;
  to_voucher_id: number | null;
  description: string | null;
  source_payment_id: number | null;
  created_at: string;
}

/** What undo reverts, as the stored run recorded it. */
export interface StoredRepairRun {
  ledger: { id: number; oldPaid: number }[];
  entriesAdded: number[];
  vouchersUndeleted: number[];
  orphanedVouchers: { id: number; voucherNumber: string }[];
  transfers: StoredTransferRow[];
  deposits: { contractId: number; oldFlag: boolean; oldPostedAmount: number }[];
}

type RunItem =
  | { kind: "ledger"; id: number; oldPaid: number }
  | { kind: "entry"; id: number }
  | { kind: "undeleted"; id: number }
  | { kind: "orphan"; id: number; voucherNumber: string }
  | { kind: "transfer"; row: StoredTransferRow }
  | { kind: "deposit"; contractId: number; oldFlag: boolean; oldPostedAmount: number };

export type RepairRunRefusalCode =
  | "REPAIR_SNAPSHOT_MISSING"
  | "REPAIR_RUN_NOT_FOUND"
  | "REPAIR_RUN_INVALID"
  | "REPAIR_SNAPSHOT_MISMATCH"
  | "REPAIR_RUN_ALREADY_UNDONE";

/** An undo refused because of the stored run; answered with 409. */
export class RepairRunRefusal extends Error {
  constructor(
    readonly code: RepairRunRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "RepairRunRefusal";
  }
}

/** Apply refused because its run cannot be recorded in full; answered with 422. */
export class RepairRunNotRecordableError extends Error {
  constructor() {
    super(
      "This repair cannot be recorded in full for undo (a value is too long for the audit record), so it was not applied"
    );
    this.name = "RepairRunNotRecordableError";
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])])
    );
  }
  return value;
}

/** SHA-256 of the snapshot's canonical JSON (sorted keys), as the client receives it. */
export function snapshotFingerprint(snapshot: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(snapshot)) ?? "")
    .digest("hex");
}

/** Read the full transfer row before apply deletes it. */
export async function loadTransferRow(exec: DatabaseOrTransaction, transferId: number): Promise<StoredTransferRow> {
  const [row] = resultRows<Record<string, unknown>>(
    await exec.execute(sql`
      SELECT id, transfer_type, from_company_id, to_company_id, transfer_date::text AS transfer_date,
             amount::text AS amount, from_ledger_account_id, to_ledger_account_id, from_voucher_id,
             to_voucher_id, description, source_payment_id, created_at::text AS created_at
        FROM inter_company_transfers WHERE id = ${transferId}
    `)
  );
  const optional = (value: unknown) => (value === null || value === undefined ? null : Number(value));
  return {
    id: Number(row.id),
    transfer_type: String(row.transfer_type),
    from_company_id: Number(row.from_company_id),
    to_company_id: Number(row.to_company_id),
    transfer_date: String(row.transfer_date),
    amount: String(row.amount),
    from_ledger_account_id: Number(row.from_ledger_account_id),
    to_ledger_account_id: Number(row.to_ledger_account_id),
    from_voucher_id: optional(row.from_voucher_id),
    to_voucher_id: optional(row.to_voucher_id),
    description: row.description === null || row.description === undefined ? null : String(row.description),
    source_payment_id: optional(row.source_payment_id),
    created_at: String(row.created_at),
  };
}

/**
 * Write the run's audit event and return its id (the run id undo takes).
 * Refuses (throws) when the audit write would shorten anything, so a run is
 * never applied without a complete undo record.
 */
export async function recordRepairRun(
  exec: DatabaseOrTransaction,
  req: Request,
  companyId: number,
  snapshot: ApplySnapshot,
  transferRows: StoredTransferRow[]
): Promise<number> {
  const items: RunItem[] = [
    ...snapshot.ledgerSnapshots.map((s): RunItem => ({ kind: "ledger", id: s.id, oldPaid: s.oldPaid })),
    ...snapshot.voucherEntriesAdded.map((id): RunItem => ({ kind: "entry", id })),
    ...snapshot.vouchersUndeleted.map((v): RunItem => ({ kind: "undeleted", id: v.id })),
    ...snapshot.orphanedVouchersDeleted.map((v): RunItem => ({
      kind: "orphan",
      id: v.id,
      voucherNumber: v.voucherNumber,
    })),
    ...transferRows.map((row): RunItem => ({ kind: "transfer", row })),
    ...snapshot.depositSnapshots.map((s): RunItem => ({
      kind: "deposit",
      contractId: s.contractId,
      oldFlag: s.oldFlag,
      oldPostedAmount: s.oldPostedAmount,
    })),
  ];
  const changes: AuditChanges = {
    fingerprint: { new: snapshotFingerprint(snapshot) },
    items: { new: items },
  };
  if (JSON.stringify(sanitizeAuditChanges(changes)) !== JSON.stringify(changes)) {
    throw new RepairRunNotRecordableError();
  }
  const runKey = randomUUID();
  await writeAuditEvent(
    {
      userId: req.session.userId ?? "unknown",
      username: req.session.username || "unknown",
      companyId,
      action: "repair",
      tableName: REPAIR_RUN_TABLE,
      recordIdentifier: runKey,
      changes,
      reason: "balance-repair-apply",
    },
    exec
  );
  const [row] = resultRows<{ id: number }>(
    await exec.execute(sql`
      SELECT id FROM audit_log
       WHERE table_name = ${REPAIR_RUN_TABLE} AND action = 'repair'
         AND company_id = ${companyId} AND record_identifier = ${runKey}
    `)
  );
  return Number(row.id);
}

const isId = (value: unknown): value is number => Number.isInteger(value) && (value as number) > 0;
const isNum = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const isText = (value: unknown): value is string => typeof value === "string";
const isOptionalId = (value: unknown) => value === null || isId(value);

function isTransferRow(row: unknown): row is StoredTransferRow {
  if (!row || typeof row !== "object") return false;
  const r = row as Record<string, unknown>;
  return (
    isId(r.id) &&
    isText(r.transfer_type) &&
    isId(r.from_company_id) &&
    isId(r.to_company_id) &&
    isText(r.transfer_date) &&
    isText(r.amount) &&
    isId(r.from_ledger_account_id) &&
    isId(r.to_ledger_account_id) &&
    isOptionalId(r.from_voucher_id) &&
    isOptionalId(r.to_voucher_id) &&
    (r.description === null || isText(r.description)) &&
    isOptionalId(r.source_payment_id) &&
    isText(r.created_at)
  );
}

function parseItems(items: unknown): StoredRepairRun {
  const invalid = () =>
    new RepairRunRefusal("REPAIR_RUN_INVALID", "The stored record of this repair is incomplete; it cannot be undone");
  if (!Array.isArray(items)) throw invalid();
  const run: StoredRepairRun = {
    ledger: [],
    entriesAdded: [],
    vouchersUndeleted: [],
    orphanedVouchers: [],
    transfers: [],
    deposits: [],
  };
  for (const raw of items as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== "object") throw invalid();
    if (raw.kind === "ledger" && isId(raw.id) && isNum(raw.oldPaid))
      run.ledger.push({ id: raw.id, oldPaid: raw.oldPaid });
    else if (raw.kind === "entry" && isId(raw.id)) run.entriesAdded.push(raw.id);
    else if (raw.kind === "undeleted" && isId(raw.id)) run.vouchersUndeleted.push(raw.id);
    else if (raw.kind === "orphan" && isId(raw.id) && isText(raw.voucherNumber))
      run.orphanedVouchers.push({ id: raw.id, voucherNumber: raw.voucherNumber });
    else if (raw.kind === "transfer" && isTransferRow(raw.row)) run.transfers.push(raw.row);
    else if (
      raw.kind === "deposit" &&
      isId(raw.contractId) &&
      typeof raw.oldFlag === "boolean" &&
      isNum(raw.oldPostedAmount)
    )
      run.deposits.push({ contractId: raw.contractId, oldFlag: raw.oldFlag, oldPostedAmount: raw.oldPostedAmount });
    else throw invalid();
  }
  return run;
}

/**
 * Load the run undo was asked for, locked for this transaction, and check the
 * client snapshot against it. Refuses (409) a missing id, a run that does not
 * exist or is another company's, a snapshot that does not match, and a run
 * already undone. Returns only what the stored record says.
 */
export async function loadRunForUndo(
  exec: DatabaseOrTransaction,
  companyId: number,
  repairRunId: unknown,
  snapshot: unknown
): Promise<StoredRepairRun> {
  const runId = Number(repairRunId);
  const notFound = new RepairRunRefusal(
    "REPAIR_RUN_NOT_FOUND",
    "No stored record of this repair was found for the active company. Repairs applied before undo records were kept cannot be undone"
  );
  if (repairRunId === undefined || repairRunId === null || repairRunId === "" || !isId(runId)) throw notFound;
  const [row] = resultRows<{ company_id: number | null; changes: unknown }>(
    await exec.execute(sql`
      SELECT company_id, changes FROM audit_log
       WHERE id = ${runId} AND table_name = ${REPAIR_RUN_TABLE} AND action = 'repair'
       FOR UPDATE
    `)
  );
  if (!row || Number(row.company_id) !== companyId) throw notFound;

  const changes = (row.changes ?? {}) as Record<string, { new?: unknown } | undefined>;
  const fingerprint = changes.fingerprint?.new;
  if (!isText(fingerprint)) {
    throw new RepairRunRefusal(
      "REPAIR_RUN_INVALID",
      "The stored record of this repair is incomplete; it cannot be undone"
    );
  }
  const run = parseItems(changes.items?.new);
  if (snapshotFingerprint(snapshot) !== fingerprint) {
    throw new RepairRunRefusal(
      "REPAIR_SNAPSHOT_MISMATCH",
      "The undo snapshot does not match the stored record of this repair"
    );
  }

  const undone = resultRows(
    await exec.execute(sql`
      SELECT 1 FROM audit_log
       WHERE table_name = ${REPAIR_RUN_TABLE} AND action = 'reverse'
         AND record_id = ${runId} AND company_id = ${companyId}
       LIMIT 1
    `)
  );
  if (undone.length > 0) {
    throw new RepairRunRefusal("REPAIR_RUN_ALREADY_UNDONE", "This repair has already been undone");
  }
  return run;
}

/** Record that the run was undone (refuses any later undo of it). */
export async function markRunUndone(
  exec: DatabaseOrTransaction,
  req: Request,
  companyId: number,
  repairRunId: number
): Promise<void> {
  await writeAuditEvent(
    {
      userId: req.session.userId ?? "unknown",
      username: req.session.username || "unknown",
      companyId,
      action: "reverse",
      tableName: REPAIR_RUN_TABLE,
      recordId: repairRunId,
      changes: { undone: { new: true } },
      reason: "balance-repair-undo",
    },
    exec
  );
}

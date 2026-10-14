import { createHash } from "node:crypto";

export interface FinancialAuditEventInput {
  companyId: number;
  actorUserId?: number | null;
  eventType: string;
  entityType: string;
  entityId: string | number;
  reason?: string | null;
  payload?: Record<string, unknown>;
  eventAt?: Date;
}

interface QueryResult<Row> {
  rows: Row[];
}

export interface SqlExecutor {
  query<Row = Record<string, unknown>>(text: string, params?: unknown[]): Promise<QueryResult<Row>>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function buildFinancialAuditHash(input: FinancialAuditEventInput, previousHash: string | null): string {
  return createHash("sha256")
    .update(canonicalJson({
      companyId: input.companyId,
      actorUserId: input.actorUserId ?? null,
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: String(input.entityId),
      eventAt: (input.eventAt ?? new Date(0)).toISOString(),
      reason: input.reason ?? null,
      payload: input.payload ?? {},
      previousHash,
    }))
    .digest("hex");
}

export async function appendFinancialAuditEventTx(tx: SqlExecutor, input: FinancialAuditEventInput): Promise<string> {
  const eventAt = input.eventAt ?? new Date();
  const previous = await tx.query<{ event_hash: string }>(
    `SELECT event_hash FROM immutable_financial_audit_events
     WHERE company_id = $1 ORDER BY id DESC LIMIT 1 FOR UPDATE`,
    [input.companyId],
  );
  const previousHash = previous.rows[0]?.event_hash ?? null;
  const eventHash = buildFinancialAuditHash({ ...input, eventAt }, previousHash);

  await tx.query(
    `INSERT INTO immutable_financial_audit_events
      (company_id, actor_user_id, event_type, entity_type, entity_id, event_at, reason, payload, previous_hash, event_hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)`,
    [
      input.companyId,
      input.actorUserId ?? null,
      input.eventType,
      input.entityType,
      String(input.entityId),
      eventAt,
      input.reason ?? null,
      JSON.stringify(input.payload ?? {}),
      previousHash,
      eventHash,
    ],
  );
  return eventHash;
}

export async function assertFinancialDateOpenTx(tx: SqlExecutor, companyId: number, postingDate: string): Promise<void> {
  const result = await tx.query<{ id: string }>(
    `SELECT id FROM financial_periods
     WHERE company_id = $1 AND status = 'CLOSED' AND $2::date BETWEEN period_start AND period_end
     LIMIT 1`,
    [companyId, postingDate],
  );
  if (result.rows.length > 0) throw new Error("FINANCIAL_PERIOD_CLOSED");
}

export async function closeFinancialPeriodTx(
  tx: SqlExecutor,
  input: { companyId: number; periodStart: string; periodEnd: string; actorUserId: number; reason: string },
): Promise<void> {
  if (!input.reason.trim()) throw new Error("CLOSE_REASON_REQUIRED");
  await tx.query(
    `INSERT INTO financial_periods
      (company_id, period_start, period_end, status, closed_at, closed_by, close_reason)
     VALUES ($1,$2,$3,'CLOSED',NOW(),$4,$5)
     ON CONFLICT (company_id, period_start, period_end) DO UPDATE SET
       status='CLOSED', closed_at=NOW(), closed_by=EXCLUDED.closed_by,
       close_reason=EXCLUDED.close_reason, updated_at=NOW()`,
    [input.companyId, input.periodStart, input.periodEnd, input.actorUserId, input.reason],
  );
  await appendFinancialAuditEventTx(tx, {
    companyId: input.companyId,
    actorUserId: input.actorUserId,
    eventType: "FINANCIAL_PERIOD_CLOSED",
    entityType: "financial-period",
    entityId: `${input.periodStart}:${input.periodEnd}`,
    reason: input.reason,
    payload: { periodStart: input.periodStart, periodEnd: input.periodEnd },
  });
}

export async function reopenFinancialPeriodTx(
  tx: SqlExecutor,
  input: { companyId: number; periodStart: string; periodEnd: string; actorUserId: number; reason: string },
): Promise<void> {
  if (!input.reason.trim()) throw new Error("REOPEN_REASON_REQUIRED");
  const updated = await tx.query<{ id: string }>(
    `UPDATE financial_periods SET status='REOPENED', reopened_at=NOW(), reopened_by=$4,
       reopen_reason=$5, updated_at=NOW()
     WHERE company_id=$1 AND period_start=$2 AND period_end=$3 AND status='CLOSED'
     RETURNING id`,
    [input.companyId, input.periodStart, input.periodEnd, input.actorUserId, input.reason],
  );
  if (updated.rows.length === 0) throw new Error("CLOSED_PERIOD_NOT_FOUND");
  await appendFinancialAuditEventTx(tx, {
    companyId: input.companyId,
    actorUserId: input.actorUserId,
    eventType: "FINANCIAL_PERIOD_REOPENED",
    entityType: "financial-period",
    entityId: `${input.periodStart}:${input.periodEnd}`,
    reason: input.reason,
    payload: { periodStart: input.periodStart, periodEnd: input.periodEnd },
  });
}

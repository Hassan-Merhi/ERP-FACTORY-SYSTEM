import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";

import { db, type DbTransaction } from "../../db";

const MAX_OPERATION_NAME = 160;
const MAX_IDEMPOTENCY_KEY = 180;
const MAX_FINGERPRINT = 64;

export type DurableFinancialOperationInput = {
  companyId: number;
  operationName: string;
  idempotencyKey: string;
  requestFingerprint: string;
};

export type DurableFinancialOperationResult<T> = {
  value: T;
  replayed: boolean;
  resultReference: string | null;
};

type StoredRequest<T> = {
  operationName: string;
  requestFingerprint: string;
  state: "processing" | "completed" | "failed";
  resultReference: string | null;
  resultStatus: number | null;
  resultBody: T | null;
};

export class DurableFinancialOperationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "DurableFinancialOperationError";
    this.code = code;
  }
}

function requiredText(value: unknown, field: string, maxLength: number): string {
  const normalized = String(value ?? "").trim();
  if (!normalized) {
    throw new DurableFinancialOperationError("FINANCIAL_OPERATION_ID_REQUIRED", `${field} is required`);
  }
  if (normalized.length > maxLength) {
    throw new DurableFinancialOperationError(
      "FINANCIAL_OPERATION_ID_INVALID",
      `${field} must be ${maxLength} characters or fewer`
    );
  }
  return normalized;
}

function validateInput(input: DurableFinancialOperationInput): DurableFinancialOperationInput {
  const companyId = Number(input.companyId);
  if (!Number.isSafeInteger(companyId) || companyId <= 0) {
    throw new DurableFinancialOperationError("FINANCIAL_OPERATION_COMPANY_INVALID", "A valid companyId is required");
  }

  const requestFingerprint = requiredText(input.requestFingerprint, "requestFingerprint", MAX_FINGERPRINT);
  if (!/^[a-f0-9]{64}$/i.test(requestFingerprint)) {
    throw new DurableFinancialOperationError(
      "FINANCIAL_OPERATION_FINGERPRINT_INVALID",
      "requestFingerprint must be a SHA-256 hexadecimal digest"
    );
  }

  return {
    companyId,
    operationName: requiredText(input.operationName, "operationName", MAX_OPERATION_NAME),
    idempotencyKey: requiredText(input.idempotencyKey, "idempotencyKey", MAX_IDEMPOTENCY_KEY),
    requestFingerprint: requestFingerprint.toLowerCase(),
  };
}

function jsonFingerprint(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value ?? null))
    .digest("hex");
}

export function financialOperationFingerprint(value: unknown): string {
  return jsonFingerprint(value);
}

async function readStoredRequest<T>(
  tx: DbTransaction,
  input: DurableFinancialOperationInput
): Promise<StoredRequest<T> | null> {
  const result = await tx.execute(sql`
    SELECT
      operation_name AS "operationName",
      request_fingerprint AS "requestFingerprint",
      state,
      result_reference AS "resultReference",
      result_status AS "resultStatus",
      result_body AS "resultBody"
    FROM financial_operation_requests
    WHERE company_id = ${input.companyId}
      AND operation_name = ${input.operationName}
      AND idempotency_key = ${input.idempotencyKey}
    FOR UPDATE
  `);
  return (result.rows[0] as StoredRequest<T> | undefined) ?? null;
}

function assertCompatible<T>(input: DurableFinancialOperationInput, stored: StoredRequest<T>): void {
  if (stored.operationName !== input.operationName || stored.requestFingerprint !== input.requestFingerprint) {
    throw new DurableFinancialOperationError(
      "FINANCIAL_OPERATION_IDEMPOTENCY_CONFLICT",
      "This request identity was already used for a different operation or financial payload"
    );
  }
}

/**
 * Reserves a logical financial operation inside the caller's transaction.
 *
 * The unique constraint serializes concurrent inserts. If the first transaction
 * commits, the second transaction reads the completed row and replays it. If
 * the first transaction rolls back, PostgreSQL allows the second insert to
 * become the owner. A processing row that exists independently is fail-closed:
 * it is never executed a second time.
 */
export async function reserveFinancialOperationTx<T>(
  tx: DbTransaction,
  rawInput: DurableFinancialOperationInput
): Promise<
  | { kind: "owner"; input: DurableFinancialOperationInput }
  | { kind: "replay"; input: DurableFinancialOperationInput; stored: StoredRequest<T> }
  | { kind: "uncertain"; input: DurableFinancialOperationInput }
> {
  const input = validateInput(rawInput);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext(${`financial-operation:${input.companyId}:${input.operationName}:${input.idempotencyKey}`}))`
  );

  const inserted = await tx.execute(sql`
    INSERT INTO financial_operation_requests
      (company_id, operation_name, idempotency_key, request_fingerprint, state)
    VALUES
      (${input.companyId}, ${input.operationName}, ${input.idempotencyKey}, ${input.requestFingerprint}, 'processing')
    ON CONFLICT (company_id, operation_name, idempotency_key) DO NOTHING
    RETURNING id
  `);

  if (inserted.rows.length > 0) return { kind: "owner", input };

  const stored = await readStoredRequest<T>(tx, input);
  if (!stored) {
    throw new DurableFinancialOperationError(
      "FINANCIAL_OPERATION_STATE_UNAVAILABLE",
      "The durable financial operation state could not be read"
    );
  }
  assertCompatible(input, stored);

  if (stored.state === "completed" && stored.resultBody !== null) {
    return { kind: "replay", input, stored };
  }

  return { kind: "uncertain", input };
}

export async function completeFinancialOperationTx<T>(
  tx: DbTransaction,
  rawInput: DurableFinancialOperationInput,
  result: T,
  resultReference: string | number | null = null,
  resultStatus: number | null = null
): Promise<void> {
  const input = validateInput(rawInput);
  const updated = await tx.execute(sql`
    UPDATE financial_operation_requests
    SET
      state = 'completed',
      result_reference = ${resultReference === null ? null : String(resultReference)},
      result_status = ${resultStatus},
      result_body = CAST(${JSON.stringify(result ?? null)} AS jsonb),
      completed_at = NOW()
    WHERE company_id = ${input.companyId}
      AND operation_name = ${input.operationName}
      AND idempotency_key = ${input.idempotencyKey}
      AND request_fingerprint = ${input.requestFingerprint}
      AND state = 'processing'
  `);

  if (updated.rowCount !== 1) {
    throw new DurableFinancialOperationError(
      "FINANCIAL_OPERATION_COMPLETION_FAILED",
      "The financial operation result could not be recorded"
    );
  }
}

/**
 * Transaction-owned convenience wrapper for new posting writers.
 *
 * The callback must use the supplied transaction for every business effect
 * that the request represents. A thrown error rolls back the marker and all
 * financial writes together, making a later retry eligible to run again.
 */
export async function withDurableFinancialOperation<T>(
  rawInput: DurableFinancialOperationInput,
  operation: (
    tx: DbTransaction
  ) => Promise<{ value: T; resultReference?: string | number | null; resultStatus?: number }>
): Promise<DurableFinancialOperationResult<T>> {
  return db.transaction(async (tx) => {
    const claim = await reserveFinancialOperationTx<T>(tx, rawInput);
    if (claim.kind === "replay") {
      return {
        value: claim.stored.resultBody as T,
        replayed: true,
        resultReference: claim.stored.resultReference,
      };
    }
    if (claim.kind === "uncertain") {
      throw new DurableFinancialOperationError(
        "FINANCIAL_OPERATION_OUTCOME_UNCERTAIN",
        "The original financial operation may still have committed; it was not executed again"
      );
    }

    const result = await operation(tx);
    await completeFinancialOperationTx(
      tx,
      claim.input,
      result.value,
      result.resultReference ?? null,
      result.resultStatus ?? null
    );
    return {
      value: result.value,
      replayed: false,
      resultReference: result.resultReference == null ? null : String(result.resultReference),
    };
  });
}

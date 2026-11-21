// Extracted from ./databasePostingDependencies.ts
import type { DbTransaction } from "../../db";
import { and, eq, inArray } from "drizzle-orm";
import { voucherEntries, vouchers } from "@shared/schema";
import type { PostedVoucherWithEntries, VoucherEntryInsertFields } from "./accountingTypes";
import { PostingValidationError, type PostingActor, type PostingSourceIdentity } from "./centralPostingEngine";
import type { CompanyScopedTable } from "../../types/companyScopedTable";
import { currentAuditActor } from "../audit/auditActorContext";

export const LEGACY_IDEMPOTENCY_TABLE = "accounting_posting_idempotency";

export const POSTING_AUDIT_TABLE = "accounting_postings";

export const SERVER_NUMBERED_RETRY_SOURCES = new Set(["manual-journal", "payment-receipt"]);

const TARGET_FIELDS = [
  "ledgerAccountId",
  "bankAccountId",
  "fixedAssetId",
  "supplierId",
  "employeeId",
  "customerId",
  "factorySupplierId",
] as const;

type TargetField = (typeof TARGET_FIELDS)[number];

export type PostingTargetIds = Record<TargetField, number[]>;

type StoredPostingIdentity = {
  sourceType: string;
  sourceId: string;
  requestFingerprint: string;
  voucherId: number;
};

export function positiveId(value: unknown, label: string): number {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) {
    throw new PostingValidationError("POSTING_TARGET_ID_INVALID", `${label} must be a positive integer`);
  }
  return id;
}

export function collectPostingTargetIds(entries: VoucherEntryInsertFields[]): PostingTargetIds {
  const grouped: PostingTargetIds = {
    ledgerAccountId: [],
    bankAccountId: [],
    fixedAssetId: [],
    supplierId: [],
    employeeId: [],
    customerId: [],
    factorySupplierId: [],
  };

  for (const entry of entries) {
    for (const field of TARGET_FIELDS) {
      if (entry[field] == null) continue;
      grouped[field].push(positiveId(entry[field], field));
    }
  }

  for (const field of TARGET_FIELDS) {
    grouped[field] = [...new Set(grouped[field])];
  }

  return grouped;
}

export async function assertCompanyOwnedIds(input: {
  tx: DbTransaction;
  companyId: number;
  ids: number[];
  table: CompanyScopedTable;
  label: string;
}) {
  const { tx, companyId, ids, table, label } = input;
  if (ids.length === 0) return;

  const rows = await tx
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.companyId, companyId), inArray(table.id, ids)));
  const found = new Set(rows.map((row) => Number(row.id)));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new PostingValidationError(
      "POSTING_TARGET_NOT_OWNED",
      `${label} ${missing.join(", ")} not found in company ${companyId}`
    );
  }
}

// Phase 21 (A), AT4: a posting without an explicit actor (or with "unknown")
// is the request's or job's actor (auditActorContext.ts); the engine's own name
// only when there is none.
export function contextActor(): { userId: string; username: string } {
  return currentAuditActor({ userId: "system", username: "central-posting-engine" });
}

export function actorUserId(actor: PostingActor): string {
  const value = String(actor.userId ?? "").trim();
  return value && value !== "unknown" ? value : contextActor().userId;
}

export function actorUsername(actor: PostingActor): string {
  const value = String(actor.username ?? "").trim();
  return value && String(actor.userId ?? "").trim() !== "unknown" ? value : contextActor().username;
}

export function sourceChanges(source: PostingSourceIdentity) {
  return {
    sourceType: { new: source.sourceType },
    sourceId: { new: source.sourceId },
    idempotencyKey: { new: source.idempotencyKey },
  };
}

export function auditChangeValue(changes: unknown, field: string): string {
  if (!changes || typeof changes !== "object") return "";
  const raw = (changes as Record<string, unknown>)[field];
  if (!raw || typeof raw !== "object") return "";
  return String((raw as Record<string, unknown>).new ?? "").trim();
}

export function assertStoredIdentityMatches(input: {
  source: PostingSourceIdentity;
  requestFingerprint: string;
  stored: StoredPostingIdentity;
  allowFingerprintMismatch?: boolean;
}) {
  const { source, requestFingerprint, stored, allowFingerprintMismatch = false } = input;
  if (stored.sourceType !== source.sourceType || stored.sourceId !== source.sourceId) {
    throw new PostingValidationError(
      "POSTING_IDEMPOTENCY_CONFLICT",
      `Idempotency key ${source.idempotencyKey} is already bound to ${stored.sourceType}:${stored.sourceId}`
    );
  }
  if (!allowFingerprintMismatch && stored.requestFingerprint !== requestFingerprint) {
    throw new PostingValidationError(
      "POSTING_IDEMPOTENCY_CONFLICT",
      `Idempotency key ${source.idempotencyKey} was already used for a different posting payload`
    );
  }
}

export async function loadVoucherWithEntries(input: {
  tx: DbTransaction;
  companyId: number;
  voucherId: number;
  idempotencyKey: string;
}): Promise<PostedVoucherWithEntries> {
  const { tx, companyId, voucherId, idempotencyKey } = input;
  if (!Number.isInteger(voucherId) || voucherId <= 0) {
    throw new PostingValidationError(
      "POSTING_IDEMPOTENCY_CORRUPT",
      `Idempotency marker ${idempotencyKey} has no valid voucher reference`
    );
  }

  const [voucher] = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.id, voucherId), eq(vouchers.companyId, companyId)))
    .limit(1);
  if (!voucher) {
    throw new PostingValidationError(
      "POSTING_IDEMPOTENCY_CORRUPT",
      `Idempotency marker ${idempotencyKey} references a missing voucher`
    );
  }

  const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, voucherId));
  return { voucher, entries };
}

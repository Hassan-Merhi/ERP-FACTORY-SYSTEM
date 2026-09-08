import type { DbTransaction } from "../../db";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  accountingPostingRequests,
  auditLog,
  bankAccounts,
  customers,
  employees,
  factorySuppliers,
  fixedAssets,
  ledgerAccounts,
  locations,
  voucherEntries,
  vouchers,
} from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import type { VoucherEntryInsertFields, VoucherWithEntries } from "./accountingTypes";
import {
  PostingValidationError,
  type CentralPostingDependencies,
  type PostingActor,
  type PostingSourceIdentity,
} from "./centralPostingEngine";
import { assertCustomerLinkedLedgerPairs } from "./customerLinkedLedgerValidation";
import type { CompanyScopedTable } from "../../types/companyScopedTable";

const LEGACY_IDEMPOTENCY_TABLE = "accounting_posting_idempotency";
const POSTING_AUDIT_TABLE = "accounting_postings";

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

function positiveId(value: unknown, label: string): number {
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

async function assertCompanyOwnedIds(input: {
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

function actorUserId(actor: PostingActor): string {
  const value = String(actor.userId ?? "system").trim();
  return value || "system";
}

function actorUsername(actor: PostingActor): string {
  const value = String(actor.username ?? "central-posting-engine").trim();
  return value || "central-posting-engine";
}

function sourceChanges(source: PostingSourceIdentity) {
  return {
    sourceType: { new: source.sourceType },
    sourceId: { new: source.sourceId },
    idempotencyKey: { new: source.idempotencyKey },
  };
}

function auditChangeValue(changes: unknown, field: string): string {
  if (!changes || typeof changes !== "object") return "";
  const raw = (changes as Record<string, unknown>)[field];
  if (!raw || typeof raw !== "object") return "";
  return String((raw as Record<string, unknown>).new ?? "").trim();
}

function assertStoredIdentityMatches(input: {
  source: PostingSourceIdentity;
  requestFingerprint: string;
  stored: StoredPostingIdentity;
}) {
  const { source, requestFingerprint, stored } = input;
  if (stored.sourceType !== source.sourceType || stored.sourceId !== source.sourceId) {
    throw new PostingValidationError(
      "POSTING_IDEMPOTENCY_CONFLICT",
      `Idempotency key ${source.idempotencyKey} is already bound to ${stored.sourceType}:${stored.sourceId}`
    );
  }
  if (stored.requestFingerprint !== requestFingerprint) {
    throw new PostingValidationError(
      "POSTING_IDEMPOTENCY_CONFLICT",
      `Idempotency key ${source.idempotencyKey} was already used for a different posting payload`
    );
  }
}

async function loadVoucherWithEntries(input: {
  tx: DbTransaction;
  companyId: number;
  voucherId: number;
  idempotencyKey: string;
}): Promise<VoucherWithEntries> {
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

/**
 * Database-backed dependencies for the central posting engine.
 *
 * A transaction-scoped advisory lock serializes concurrent requests for the
 * same company/key pair. The accounting_posting_requests unique constraint is
 * the durable database guarantee: even if a caller bypassed normal lookup
 * sequencing, two committed vouchers cannot own the same request identity.
 * Legacy audit_log markers remain readable and are upgraded into the canonical
 * table on their first replay.
 */
export function createDatabasePostingDependencies(): CentralPostingDependencies {
  return {
    ownership: {
      async validateVoucherOwnership({ tx, companyId, voucher, entries }) {
        const targets = collectPostingTargetIds(entries);

        if (voucher.locationId != null) {
          await assertCompanyOwnedIds({
            tx,
            companyId,
            ids: [positiveId(voucher.locationId, "locationId")],
            table: locations,
            label: "Location",
          });
        }

        await Promise.all([
          assertCompanyOwnedIds({
            tx,
            companyId,
            ids: targets.ledgerAccountId,
            table: ledgerAccounts,
            label: "Ledger account",
          }),
          assertCompanyOwnedIds({
            tx,
            companyId,
            ids: targets.bankAccountId,
            table: bankAccounts,
            label: "Bank account",
          }),
          assertCompanyOwnedIds({
            tx,
            companyId,
            ids: targets.fixedAssetId,
            table: fixedAssets,
            label: "Fixed asset",
          }),
          assertCompanyOwnedIds({
            tx,
            companyId,
            ids: targets.supplierId,
            table: companyScopedSuppliers,
            label: "Supplier",
          }),
          assertCompanyOwnedIds({
            tx,
            companyId,
            ids: targets.employeeId,
            table: employees,
            label: "Employee",
          }),
          assertCompanyOwnedIds({
            tx,
            companyId,
            ids: targets.customerId,
            table: customers,
            label: "Customer",
          }),
          assertCompanyOwnedIds({
            tx,
            companyId,
            ids: targets.factorySupplierId,
            table: factorySuppliers,
            label: "Factory supplier",
          }),
        ]);

        await assertCustomerLinkedLedgerPairs({ tx, companyId, entries });
      },
    },

    idempotency: {
      async findExisting({ tx, companyId, source, requestFingerprint }) {
        const lockKey = `accounting-posting:${companyId}:${source.idempotencyKey}`;
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

        const [marker] = await tx
          .select({
            sourceType: accountingPostingRequests.sourceType,
            sourceId: accountingPostingRequests.sourceId,
            requestFingerprint: accountingPostingRequests.requestFingerprint,
            voucherId: accountingPostingRequests.voucherId,
          })
          .from(accountingPostingRequests)
          .where(
            and(
              eq(accountingPostingRequests.companyId, companyId),
              eq(accountingPostingRequests.idempotencyKey, source.idempotencyKey)
            )
          )
          .limit(1);

        if (marker) {
          assertStoredIdentityMatches({
            source,
            requestFingerprint,
            stored: {
              sourceType: marker.sourceType,
              sourceId: marker.sourceId,
              requestFingerprint: marker.requestFingerprint,
              voucherId: Number(marker.voucherId),
            },
          });
          return loadVoucherWithEntries({
            tx,
            companyId,
            voucherId: Number(marker.voucherId),
            idempotencyKey: source.idempotencyKey,
          });
        }

        const [legacyMarker] = await tx
          .select({ voucherId: auditLog.recordId, changes: auditLog.changes })
          .from(auditLog)
          .where(
            and(
              eq(auditLog.companyId, companyId),
              eq(auditLog.tableName, LEGACY_IDEMPOTENCY_TABLE),
              eq(auditLog.recordIdentifier, source.idempotencyKey)
            )
          )
          .orderBy(desc(auditLog.id))
          .limit(1);

        if (!legacyMarker) return null;

        const legacySourceType = auditChangeValue(legacyMarker.changes, "sourceType");
        const legacySourceId = auditChangeValue(legacyMarker.changes, "sourceId");
        if (!legacySourceType || !legacySourceId) {
          throw new PostingValidationError(
            "POSTING_IDEMPOTENCY_CORRUPT",
            `Legacy idempotency marker ${source.idempotencyKey} has no valid source identity`
          );
        }
        if (legacySourceType !== source.sourceType || legacySourceId !== source.sourceId) {
          throw new PostingValidationError(
            "POSTING_IDEMPOTENCY_CONFLICT",
            `Idempotency key ${source.idempotencyKey} is already bound to ${legacySourceType}:${legacySourceId}`
          );
        }

        const voucherId = Number(legacyMarker.voucherId);
        const existing = await loadVoucherWithEntries({
          tx,
          companyId,
          voucherId,
          idempotencyKey: source.idempotencyKey,
        });

        await tx.insert(accountingPostingRequests).values({
          companyId,
          idempotencyKey: source.idempotencyKey,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          requestFingerprint,
          voucherId,
        });

        return existing;
      },

      async record({ tx, companyId, voucherId, source, requestFingerprint }) {
        await tx.insert(accountingPostingRequests).values({
          companyId,
          idempotencyKey: source.idempotencyKey,
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          requestFingerprint,
          voucherId,
        });

        // Keep the legacy marker during migration so older diagnostics and code
        // paths that still inspect audit_log continue to see the posting identity.
        await tx.insert(auditLog).values({
          userId: "system",
          username: "central-posting-engine",
          companyId,
          action: "create",
          tableName: LEGACY_IDEMPOTENCY_TABLE,
          recordId: voucherId,
          recordIdentifier: source.idempotencyKey,
          changes: sourceChanges(source),
        });
      },
    },

    audit: {
      async recordPosting({ tx, companyId, voucherId, source, actor, debitTotal, creditTotal }) {
        await tx.insert(auditLog).values({
          userId: actorUserId(actor),
          username: actorUsername(actor),
          companyId,
          action: "create",
          tableName: POSTING_AUDIT_TABLE,
          recordId: voucherId,
          recordIdentifier: source.idempotencyKey,
          changes: {
            ...sourceChanges(source),
            debitTotal: { new: debitTotal },
            creditTotal: { new: creditTotal },
            reason: { new: actor.reason ?? null },
          },
        });
      },
    },
  };
}

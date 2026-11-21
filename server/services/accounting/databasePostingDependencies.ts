import { and, desc, eq, sql } from "drizzle-orm";
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
} from "@shared/schema";
import { companyScopedSuppliers } from "@shared/schema/supplierCompanyScope";
import { PostingValidationError, type CentralPostingDependencies } from "./centralPostingEngine";
import { assertCustomerLinkedLedgerPairs } from "./customerLinkedLedgerValidation";
import { isRetiredVoucherNumber } from "./voucherRetirement";
import {
  LEGACY_IDEMPOTENCY_TABLE,
  POSTING_AUDIT_TABLE,
  SERVER_NUMBERED_RETRY_SOURCES,
  positiveId,
  collectPostingTargetIds,
  assertCompanyOwnedIds,
  contextActor,
  actorUserId,
  actorUsername,
  sourceChanges,
  auditChangeValue,
  assertStoredIdentityMatches,
  loadVoucherWithEntries,
} from "./databasePostingDependenciesHelpers";
export { collectPostingTargetIds, type PostingTargetIds } from "./databasePostingDependenciesHelpers";

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
            // Before Phase 9, these two routes included their server-generated
            // display voucher number in the stored fingerprint. The logical
            // idempotency key already contains the financial-payload digest, so
            // an exact key match is enough to safely replay those historical
            // markers after the retry-stable fingerprint change.
            allowFingerprintMismatch: SERVER_NUMBERED_RETRY_SOURCES.has(source.sourceType),
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
        // Phase 22 (B): a retired voucher gave up its identity (voucherRetirement
        // releases the canonical marker); its legacy audit marker must not bring
        // the identity back, or a deliberate re-post after a rebuild would
        // "replay" the deleted voucher and post nothing.
        if (existing.voucher.deletedAt && isRetiredVoucherNumber(existing.voucher.voucherNumber)) return null;

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
        const markerActor = contextActor();
        await tx.insert(auditLog).values({
          userId: markerActor.userId,
          username: markerActor.username,
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

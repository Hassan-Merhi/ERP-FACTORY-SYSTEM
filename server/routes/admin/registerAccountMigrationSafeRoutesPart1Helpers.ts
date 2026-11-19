// Extracted from ./registerAccountMigrationSafeRoutesPart1.ts
import { db } from "../../db";
import type { AccountMigrationControlSnapshot } from "./accountMigrationControlReferences";

export const EXECUTE_ACTION = "ACCOUNT_MIGRATION_EXECUTE_SAFE";

export const UNDO_ACTION = "ACCOUNT_MIGRATION_UNDO_SAFE";

export const MAX_BATCH = 200;

export const MIGRATION_CLEARING_SUBTYPE = "account_migration_clearing";

export type AccountMigrationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type AccountMigrationDatabaseScope = {
  activeCompanyId: number;
  authorizedCompanyIds: string;
};

export type SavedMigrationV1 = {
  version: 1;
  migrationId: string;
  srcCompanyId: number;
  destCompanyId: number;
  accountIds: number[];
  movedVoucherIds: number[];
  accounts: Array<{ accountId: number; originalCode: string; finalCode: string }>;
  controls: AccountMigrationControlSnapshot;
};

export type SplitVoucherSnapshot = {
  sourceVoucherId: number;
  destinationVoucherId: number;
  sourceClearingAccountId: number;
  remappedEntries: Array<{ entryId: number; originalLedgerAccountId: number }>;
};

export type SavedMigrationV2 = {
  version: 2;
  migrationId: string;
  srcCompanyId: number;
  destCompanyId: number;
  accountIds: number[];
  movedVoucherIds: number[];
  accounts: Array<{ accountId: number; originalCode: string; finalCode: string }>;
  controls: AccountMigrationControlSnapshot;
  splitVouchers: SplitVoucherSnapshot[];
};

export type SavedMigration = SavedMigrationV1 | SavedMigrationV2;

interface PgErrorLike {
  message?: string;
  code?: string;
  constraint?: string;
  detail?: string;
  cause?: unknown;
}

export function deepestError(error: unknown): PgErrorLike {
  const asPgError = (value: unknown): PgErrorLike => (value && typeof value === "object" ? (value as PgErrorLike) : {});
  let current = asPgError(error);
  const seen = new Set<unknown>();
  while (current.cause && !seen.has(current.cause)) {
    seen.add(current.cause);
    current = asPgError(current.cause);
  }
  return current;
}

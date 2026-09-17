const ACCOUNT_MIGRATION_CLEARING_SUBTYPE = "account_migration_clearing";
const ACCOUNT_MIGRATION_CODE_PREFIXES = ["AM-TO-", "AM-FROM-"];
const ACCOUNT_MIGRATION_NAME_PREFIXES = [
  "account migration clearing - ",
  "account migration clearing to - ",
  "account migration clearing from - ",
];

const GC_OWNER_WITHDRAWAL_CLEARING_SUBTYPE = "gc_owner_withdrawal_clearing";
const GC_OWNER_WITHDRAWAL_CLEARING_CODE = "GC-OWCLR";
const GC_OWNER_WITHDRAWAL_CLEARING_NAME = "gc owner withdrawal clearing";

type LedgerAccountShape = Record<string, unknown>;

function asLedgerAccount(value: unknown): LedgerAccountShape | null {
  return value && typeof value === "object" ? (value as LedgerAccountShape) : null;
}

/**
 * Account-migration clearing ledgers are infrastructure accounts. Older rows
 * pre-date the sub_type marker, so keep the historical name/code conventions
 * as fallbacks instead of exposing those rows in user-facing accounting views.
 */
export function isAccountMigrationClearingAccount(value: unknown): boolean {
  const row = asLedgerAccount(value);
  if (!row) return false;

  const subType = String(row.subType ?? row.sub_type ?? "").trim().toLowerCase();
  if (subType === ACCOUNT_MIGRATION_CLEARING_SUBTYPE) return true;

  const code = String(row.code ?? "").trim().toUpperCase();
  if (ACCOUNT_MIGRATION_CODE_PREFIXES.some((prefix) => code.startsWith(prefix))) return true;

  const name = String(row.name ?? "").trim().toLowerCase();
  return (
    name === "account migration clearing" ||
    ACCOUNT_MIGRATION_NAME_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

export function isSystemOnlyLedgerAccount(value: unknown): boolean {
  const row = asLedgerAccount(value);
  if (!row) return false;
  if (isAccountMigrationClearingAccount(row)) return true;

  const subType = String(row.subType ?? row.sub_type ?? "").trim().toLowerCase();
  const code = String(row.code ?? "").trim().toUpperCase();
  const name = String(row.name ?? "").trim().toLowerCase();

  return (
    subType === GC_OWNER_WITHDRAWAL_CLEARING_SUBTYPE ||
    code === GC_OWNER_WITHDRAWAL_CLEARING_CODE ||
    name === GC_OWNER_WITHDRAWAL_CLEARING_NAME
  );
}

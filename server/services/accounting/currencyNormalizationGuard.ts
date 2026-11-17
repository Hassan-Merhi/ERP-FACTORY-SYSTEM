import type { Pool } from "pg";

/**
 * Voucher-entry currency normalization trigger (accounting audit wave 14,
 * owner decision 4; v2 since wave 17 D).
 *
 * `normalize_voucher_entry_currency_amounts()` and the BEFORE trigger
 * `voucher_entries_normalize_currency_before_write` are defined by the schema
 * migrations (migrations/); nothing is installed at runtime. The version is the
 * COMMENT on the function, read by the integrity diagnostic.
 */

/** Expected version: the comment on normalize_voucher_entry_currency_amounts(). */
export const CURRENCY_NORMALIZATION_GUARD_VERSION = "2026-10-09-001-currency-normalization-v2";

export const CURRENCY_NORMALIZATION_TRIGGER = "voucher_entries_normalize_currency_before_write";
export const CURRENCY_NORMALIZATION_FUNCTION = "normalize_voucher_entry_currency_amounts";

type Queryable = { query: Pool["query"] };

/**
 * The installed version, or null when the trigger is missing, disabled or not
 * bound to the function (a catalogue read).
 */
export async function installedCurrencyNormalizationVersion(client: Queryable): Promise<string | null> {
  const result = await client.query<{ version: string | null }>(
    `SELECT obj_description(p.oid, 'pg_proc') AS version
       FROM pg_trigger t
       JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE t.tgrelid = to_regclass('voucher_entries')
        AND t.tgname = $1
        AND NOT t.tgisinternal
        AND t.tgenabled <> 'D'
        AND p.proname = $2`,
    [CURRENCY_NORMALIZATION_TRIGGER, CURRENCY_NORMALIZATION_FUNCTION]
  );
  return result.rows[0]?.version ?? null;
}

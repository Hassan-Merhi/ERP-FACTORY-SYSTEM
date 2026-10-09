/**
 * Startup schema integrity.
 * ------------------------
 * `startupMigrations` is assembled from ten modules under
 * `server/startup-schema/`. The statements run sequentially against a live
 * database at boot, so order is behaviour: moving a statement between parts, or
 * reordering two within a part, can change the resulting schema or fail outright
 * against production data.
 *
 * This test pins the assembled array so any such change is deliberate. When a
 * migration is genuinely added, update EXPECTED_STATEMENT_COUNT and
 * EXPECTED_CONTENT_HASH in the same commit - the diff then shows reviewers that
 * the array changed on purpose rather than as a side effect of editing a file.
 *
 * The recorded hash is the reviewed value of the composed startup migration
 * array on the current main baseline.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { startupMigrations } from "../server/startup-schema";

/** Statement count of the reviewed composed array. */
/**
 * sha256 of JSON.stringify(startupMigrations) for the reviewed composed array.
 *
 * Re-pinned when the three factory_container_receipts constraints in
 * 010-security-notifications-and-precision.ts gained the DO/duplicate_object
 * guard the rest of that file uses. Unguarded they raised "constraint already
 * exists" on every startup after the first, which the startup-migration ratchet
 * added in the same change would have reported as three failures on every
 * re-run. The statement COUNT is unchanged at 1280 and no statement moved: the
 * three were wrapped in place, so only their text differs.
 *
 * Re-pinned again when the eleven baselined startup-migration failures were
 * fixed: nine seed INSERTs became guarded SELECTs that check their company and
 * ledger account exist, and two foreign keys targeting schema that no longer
 * exists (supplier_containers, bales.erp_location_id) were guarded on the object
 * being present. The count is still 1280 and nothing moved — every statement was
 * guarded in place — and the migration ceiling fell from 11 to 0.
 *
 * Re-pinned again for the canonical stock movement journal
 * (021-canonical-stock-movement-journal.ts): eight appended statements creating
 * the three journal tables and their indexes, taking the count from 1280 to
 * 1288. They are appended last because they reference companies, stock_items
 * and locations, so nothing before them moved.
 *
 * Re-pinned again when the legacy orphan repair stage was added before the
 * foreign-key batch. It archives invalid child rows, preserves nullable
 * references by clearing only the missing parent id, and raises the count
 * from 1285 to 1332.
 *
 * Re-pinned again when the idempotent tenant-control integrity repair stage
 * was appended, taking the count from 1332 to 1335. It deterministically
 * collapses duplicate company roles and removes user-location rows without
 * a matching company role.
 *
 * Re-pinned again when the generic transaction-owned financial operation
 * request table and its two indexes were appended as startup stage 023,
 * taking the count from 1335 to 1338.
 *
 * Re-pinned again when startup stage 024 added five idempotent stock_items
 * catch-up statements for reorder_level, selling_price, active, deleted_at and
 * created_at, taking the count from 1338 to 1343. The five statements were
 * appended after stage 023, so no earlier startup statement moved.
 *
 * Re-pinned again when startup stage 025 added the Insurance monthly-amount
 * table and its two indexes for multi-sheet workbook imports, taking the count
 * from 1343 to 1346.
 *
 * Re-pinned again when stage 024 was expanded with six legacy stock_items
 * catch-up statements for stock_group_id, grade_id, category_id, opening_qty,
 * opening_rate and opening_value. They are ordered before the existing five
 * stage-024 statements, taking the composed array from 1346 to 1352 while
 * preserving the reviewed stage ordering before stage 025.
 *
 * Re-pinned again when the nullable Supplier Partner POS realized-profit
 * baseline date was added, taking the count from 1352 to 1353.
 *
 * Re-pinned again when three VALIDATE statements were removed from
 * 007-schema-catchup-may-2026.ts, taking the count from 1288 to 1285. They
 * validated factory_raw_stock, factory_fx_allocations and
 * factory_container_commissions *_container_id_fkey while those constraints
 * still pointed at `containers`; part 009 drops each one and recreates it
 * against factory_containers, so the validation compared rows against the wrong
 * parent table and raised foreign_key_violation on every boot of a database
 * holding factory rows. Only those three were deleted and no statement moved.
 *
 * Re-pinned again when the guarded HMD KINSHASA → HADI L'SHI parent-company
 * repair was appended as startup stage 026, taking the count from 1353 to
 * 1354, then stage 027 added the Factory staff-tracking table and two indexes,
 * taking the count to 1357. The same stage is also run unconditionally before
 * the bulk startup migration pass because production may disable that pass.
 *
 * Re-pinned again when the guarded stage-026 PO Import parent-company repair
 * was extended from HMD KINSHASA to also cover MALI. The statement count stays
 * 1357 and no statement moved; only the existing repair statement changed.
 *
 * Re-pinned again for stage 028, supplier tracking defaults: the
 * supplier_tracking_defaults table, its unique and company indexes, the
 * apply_supplier_tracking_defaults_to_container() function, and the drop and
 * create of the containers trigger that calls it. Six statements, appended
 * after stage 027, take the count from 1357 to 1363; the first 1357 entries are
 * byte-identical, so nothing moved. The hash also absorbs the MALI edit above,
 * which changed a statement's content without changing the count and so was
 * left unpinned at the time.
 *
 * Re-pinned again for stage 029, user_presence compliance indexes: three
 * CREATE INDEX IF NOT EXISTS statements on last_seen / (company_id, last_seen)
 * / (user_id, last_seen), appended after stage 028, taking the count from 1363
 * to 1366. Nothing before them moved.
 *
 * Re-pinned for stage 030, durable scheduled WhatsApp occurrence and attachment\n * tracking: two tables plus three indexes, appended after stage 029. This takes\n * the composed array from 1371 to 1376 without moving any earlier statement.\n *\n * Re-pinned for the per-user hidden All Daybook rows (2eb4ffd): one
 * ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS
 * hidden_transaction_journal_voucher_ids, added to 001-core-tables-and-columns
 * next to the other user columns, taking the count from 1366 to 1367.
 *
 * Re-pinned for the Wave 5 Factory permission canonicalization, which landed
 * without re-pinning this file. In 001-core-tables-and-columns it narrows the
 * guarded factory-page-key-renames-v1 block so it no longer deletes
 * factory/daybook, factory/create, factory/users or factory/sales/new, and
 * appends four idempotent statements right after that block: the canonical-key
 * INSERT, the stale-key DELETE, the deprecated hidden-tab UPDATE and the
 * 'factory-permission-canonicalization-v2' migrations_log row. That takes the
 * count from 1367 to 1371. Nothing else moved; the rows these statements leave
 * are asserted in tests/factory-permission-canonicalization-migration.test.ts.
 *
 * Re-pinned for stage 031, append-only inventory valuation override evidence:
 * one table plus one index, appended after stage 030 without moving any
 * earlier statement. main already assembled 1378 statements while this file
 * still pinned 1376 (an earlier change landed without re-pinning); with stage
 * 031 the reviewed count is 1380.
 *
 * Re-pinned for the ERP payroll deduction changes (#1976, #1977), which added
 * three statements to 004-post-deploy-tables and
 * 010-security-notifications-and-precision without re-pinning, taking the
 * count from 1380 to 1383.
 *
 * Re-pinned for stage 032, the historical-replay safety tables
 * (factory_recalc_undo_log, factory_replay_consumed_tokens and their indexes,
 * the 17 statements of migrations/0007), appended after stage 031 without
 * moving any earlier statement: 1383 to 1400.
 *
 * Re-pinned for 66c6aa5, which disabled automated container tracking and
 * added five statements forcing the ERP and factory tracking defaults and
 * existing flags off, without re-pinning: 1400 to 1405.
 *
 * Re-pinned when the Sheets & Sacks block in
 * 010-security-notifications-and-precision moved to
 * server/startup/factorySheetsSacksSchema.ts, which 010 now spreads in the
 * same position: the 9 statements became 17 (the kept updated_at column, the
 * guarded convergence of a legacy log and seven legacy index drops, replacing
 * the fss_log_color block), 1405 to 1413. Nothing else moved.
 *
 * Re-pinned when 008-pos-exports-and-dispatch gained the Shipping Containers
 * "anything" column (#2083: the column in the factory_shipping_container_rows
 * CREATE plus its ADD COLUMN) and factory_shipping_availability.details
 * (fe59923), taking the count from 1413 to 1415. Both ADD COLUMN statements sit
 * beside their table's other ADD COLUMNs; nothing else moved.
 *
 * Re-pinned when 004-post-deploy-tables gained customer_orders.booking_info
 * (#2109), taking the count from 1415 to 1416. The ADD COLUMN sits beside the
 * table's other ADD COLUMNs; nothing else moved.
 */
const EXPECTED_STATEMENT_COUNT = 1422;
const EXPECTED_CONTENT_HASH = "798ebd2dc26f8fa89cd2ba79cf84f667ae655c5659f16f2a67ad13ac603735ff";
/**
 * sha256 of JSON.stringify(startupMigrations) for the reviewed composed array.
 *
 * Re-pinned when the three factory_container_receipts constraints in
 * 010-security-notifications-and-precision.ts gained the DO/duplicate_object
 * guard the rest of that file uses. Unguarded they raised "constraint already
 * exists" on every startup after the first, which the startup-migration ratchet
 * added in the same change would have reported as three failures on every
 * re-run. The statement COUNT is unchanged at 1280 and no statement moved: the
 * three were wrapped in place, so only their text differs.
 *
 * Re-pinned again when the eleven baselined startup-migration failures were
 * fixed: nine seed INSERTs became guarded SELECTs that check their company and
 * ledger account exist, and two foreign keys targeting schema that no longer
 * exists (supplier_containers, bales.erp_location_id) were guarded on the object
 * being present. The count is still 1280 and nothing moved — every statement was
 * guarded in place — and the migration ceiling fell from 11 to 0.
 *
 * Re-pinned again for the canonical stock movement journal
 * (021-canonical-stock-movement-journal.ts): eight appended statements creating
 * the three journal tables and their indexes, taking the count from 1280 to
 * 1288. They are appended last because they reference companies, stock_items
 * and locations, so nothing before them moved.
 *
 * Re-pinned again when the legacy orphan repair stage was added before the
 * foreign-key batch. It archives invalid child rows, preserves nullable
 * references by clearing only the missing parent id, and raises the count
 * from 1285 to 1332.
 *
 * Re-pinned again when the idempotent tenant-control integrity repair stage
 * was appended, taking the count from 1332 to 1335. It deterministically
 * collapses duplicate company roles and removes user-location rows without
 * a matching company role.
 *
 * Re-pinned again when the generic transaction-owned financial operation
 * request table and its two indexes were appended as startup stage 023,
 * taking the count from 1335 to 1338.
 *
 * Re-pinned again when startup stage 024 added five idempotent stock_items
 * catch-up statements for reorder_level, selling_price, active, deleted_at and
 * created_at, taking the count from 1338 to 1343. The five statements were
 * appended after stage 023, so no earlier startup statement moved.
 *
 * Re-pinned again when startup stage 025 added the Insurance monthly-amount
 * table and its two indexes for multi-sheet workbook imports, taking the count
 * from 1343 to 1346.
 *
 * Re-pinned again when the nullable Supplier Partner POS realized-profit
 * baseline date was added, taking the count from 1346 to 1347.
 *
 * Re-pinned again when three VALIDATE statements were removed from
 * 007-schema-catchup-may-2026.ts, taking the count from 1288 to 1285. They
 * validated factory_raw_stock, factory_fx_allocations and
 * factory_container_commissions *_container_id_fkey while those constraints
 * still pointed at `containers`; part 009 drops each one and recreates it
 * against factory_containers, so the validation compared rows against the wrong
 * parent table and raised foreign_key_violation on every boot of a database
 * holding factory rows. Only those three were deleted and no statement moved.
 *
 * Re-pinned again (2026-10 accounting audit) when two boot-time steps that
 * rewrote posted history were retired: the GUAR-CASH debit/credit swap in 007
 * and the duplicate-account merge in 009 (re-pointed voucher_entries and
 * hard-deleted ledger accounts on every boot). main had 1415 statements against
 * a stale pin of 1413; with the two removed the array is 1413, and nothing else
 * moved.
 *
 * Re-pinned again (2026-10 accounting audit, wave 11): the orphan repair stage
 * (005) copies rows into its archive tables by column name, not by position,
 * and adds any source column an archive lacks (one statement per archived
 * table, eight in all), because wave 11 added value_moved to
 * stock_transfer_items and an archive created on an earlier boot would no
 * longer line up. 010's inventory company backfill was made a no-op when
 * nothing is mismatched and no longer moves a cut-over company's stock. The
 * count goes from 1413 to 1421.
 *
 * Re-pinned again (2026-10 accounting audit, wave 12): 006 no longer adds
 * audit_log_company_id_fkey and drops it instead. audit_log is append-only and
 * outlives the company it describes, so an empty company's deletion keeps its
 * audit rows; with the RESTRICT key no company could ever be deleted. One
 * statement replaced, so the count is unchanged.
 *
 * Re-pinned again when the 2026-10 accounting audit branch merged main:
 * main's array was 1416 (its notes above, the last being
 * customer_orders.booking_info in 004) and this branch's was 1421 (the audit
 * notes above). The 1413 -> 1415 step main describes (#2083, fe59923) was
 * already in this branch's 1413 base, so the merge adds only main's
 * booking_info ADD COLUMN to this branch's 1421: 1422. Nothing else
 * moved.
 *
 * Re-pinned again (2026-10 accounting audit, wave 16 A) when four boot-time
 * rewrites of posted history were retired in place: 010's
 * orphan-factory-daybook-cleanup-v1 no longer hard-deletes vouchers (only the
 * daybook mirror), 006's two orphan sweeps no longer clear party ids on posted
 * lines (their foreign keys are added NOT VALID instead), and 006's
 * accrued-rent-soft-delete-v1 no longer soft-deletes accounts by name. Every
 * statement was edited in place, so the count is unchanged at 1422.
 */

function contentHash(statements: string[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(statements)).digest("hex");
}

describe("startup schema integrity", () => {
  it("assembles the expected number of statements", () => {
    expect(startupMigrations).toHaveLength(EXPECTED_STATEMENT_COUNT);
  });

  it("preserves statement content and order exactly", () => {
    expect(
      contentHash(startupMigrations),
      "The assembled startup migration array changed. If a migration was added or " +
        "edited on purpose, update EXPECTED_STATEMENT_COUNT and EXPECTED_CONTENT_HASH " +
        "in this file within the same commit. If not, a statement has been reordered " +
        "or moved between parts - order is executed order, so restore it."
    ).toBe(EXPECTED_CONTENT_HASH);
  });

  it("contains only non-empty SQL strings", () => {
    const bad = startupMigrations
      .map((statement, index) => ({ statement, index }))
      .filter(({ statement }) => typeof statement !== "string" || statement.trim() === "");

    expect(bad, `Empty or non-string entries at: ${bad.map((b) => b.index).join(", ")}`).toEqual([]);
  });

  it("keeps the retired single-file module deleted", () => {
    // The split is only a real split if the monolith is gone. A re-appearing
    // startupSchema.ts would mean two sources of truth for boot-time DDL.
    expect(fs.existsSync(path.join(process.cwd(), "server/startupSchema.ts"))).toBe(false);
  });

  it("registers every part module in the composed array", () => {
    // Guards the failure mode where a part is added to the directory but never
    // imported by index.ts, so its statements silently never run.
    const partsDirectory = path.join(process.cwd(), "server/startup-schema");
    const parts = fs
      .readdirSync(partsDirectory)
      .filter((file) => file.endsWith(".ts") && file !== "index.ts")
      .sort();

    const index = fs.readFileSync(path.join(partsDirectory, "index.ts"), "utf8");
    const unregistered = parts.filter((file) => !index.includes(`./${file.replace(/\.ts$/, "")}`));

    expect(
      unregistered,
      `These parts exist but are not imported by server/startup-schema/index.ts:\n${unregistered.join("\n")}`
    ).toEqual([]);
  });

  it("archives legacy FK orphans before the strict FK batch runs", () => {
    const repairStart = startupMigrations.findIndex((statement) =>
      statement.includes("CREATE TABLE IF NOT EXISTS _orphan_archive_customer_order_bale_removals")
    );
    const foreignKeyStart = startupMigrations.findIndex((statement) =>
      statement.includes("customer_order_bale_removals_order_id_fkey")
    );

    expect(repairStart).toBeGreaterThanOrEqual(0);
    expect(foreignKeyStart).toBeGreaterThan(repairStart);

    for (const table of [
      "customer_order_bale_removals",
      "supplier_container_loaded_items",
      "chat_messages",
      "container_offloads",
      "import_logs",
      "inventory",
      "stock_transfer_items",
    ]) {
      expect(startupMigrations.some((statement) => statement.includes(`_orphan_archive_${table}`))).toBe(true);
    }

    expect(
      startupMigrations.filter((statement) => statement.includes("ON CONFLICT (id) DO NOTHING")).length
    ).toBeGreaterThanOrEqual(7);
  });
});

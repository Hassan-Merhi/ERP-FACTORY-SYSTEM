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
 */
const EXPECTED_STATEMENT_COUNT = 1363;
const EXPECTED_CONTENT_HASH = "f57dfca37fee29698356689db921af48c2be0ac6f14ec5f26e31f12996e10ecf";
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

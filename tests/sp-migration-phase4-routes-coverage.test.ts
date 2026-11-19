/**
 * Supplier Partner Phase 4 cutover controls: every refusal the handlers make
 * before they move users or stock, plus the cutover rollback, cancel and
 * target-hold release paths that succeed. Handlers are reached through the
 * route registration (final handler only; the HTTP gate is covered in
 * sp-migration-http-gate-coverage).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { registerSpMigrationPhase4Routes } from "../server/routes/sp/spMigrationPhase4Routes";
import { invalidatePhase4HoldCache } from "../server/routes/sp/phase4WriteGuard";
import {
  captureRouteHandlers,
  cleanupSpMigrationPair,
  createSpMigrationPair,
  insertCutover,
  insertInventory,
  insertLocation,
  insertStockItem,
  insertVoucher,
  pairBody,
  scalar,
  type SpMigrationPair,
} from "./helpers/spMigrationCoverageFixture";

const PREFIX = "spmigcov_p4routes";
let pair: SpMigrationPair;
const { call } = captureRouteHandlers((app) => registerSpMigrationPhase4Routes(app));

async function cutoverRow(id: number) {
  const result = await pool.query(`SELECT * FROM sp_migration_cutovers WHERE id = $1`, [id]);
  return result.rows[0];
}

beforeAll(async () => {
  pair = await createSpMigrationPair(PREFIX);
}, 120000);

beforeEach(async () => {
  await pool.query(`DELETE FROM sp_migration_cutovers WHERE source_company_id = $1 OR target_company_id = $2`, [
    pair.sourceId,
    pair.targetId,
  ]);
  await pool.query(`DELETE FROM gl_inventory_cutovers WHERE company_id = ANY($1)`, [[pair.sourceId, pair.targetId]]);
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1 AND source_module = 'ERP'`, [pair.targetId]);
  invalidatePhase4HoldCache();
});

afterAll(async () => {
  await cleanupSpMigrationPair(PREFIX);
}, 120000);

describe("cutover action dispatcher", () => {
  it("refuses an unknown action", async () => {
    const result = await call("POST /api/sp/migration/cutover", { body: { action: "explode" } });
    expect(result.status).toBe(400);
    expect(result.body.message).toMatch(/action must be prepare, finalize/);
  });

  it.each(["rollback", "cancel", "release-target-hold"])("routes %s and requires a cutoverId", async (action) => {
    const result = await call("POST /api/sp/migration/cutover", { body: { action } });
    expect(result.status).toBe(400);
    expect(result.body.message).toBe("cutoverId is required");
  });

  it.each(["prepare", "finalize"])("routes %s and validates the company pair", async (action) => {
    const result = await call("POST /api/sp/migration/cutover", { body: { action } });
    expect(result.status).toBe(400);
    expect(result.body.message).toBe("sourceCompanyId and targetCompanyId are required");
  });
});

describe("company pair validation (status endpoint)", () => {
  it("refuses identical, unknown and mistyped companies", async () => {
    const same = await call("GET /api/sp/migration/cutover", {
      query: { sourceCompanyId: pair.sourceId, targetCompanyId: pair.sourceId },
    });
    expect(same).toMatchObject({ status: 400, body: { message: "Source and target companies must be different" } });

    const missingSource = await call("GET /api/sp/migration/cutover/status", {
      query: { sourceCompanyId: 2147480001, targetCompanyId: pair.targetId },
    });
    expect(missingSource).toMatchObject({ status: 404, body: { message: "Source company not found" } });

    const missingTarget = await call("GET /api/sp/migration/cutover/status", {
      query: { sourceCompanyId: pair.sourceId, targetCompanyId: 2147480001 },
    });
    expect(missingTarget).toMatchObject({ status: 404, body: { message: "Target company not found" } });

    const reversed = await call("GET /api/sp/migration/cutover/status", {
      query: { sourceCompanyId: pair.targetId, targetCompanyId: pair.sourceId },
    });
    expect(reversed).toMatchObject({ status: 400, body: { message: "Source company must be type 'erp'" } });

    const twoErp = await pool.query(`SELECT id FROM companies WHERE id <> $1 AND company_type = 'erp' LIMIT 1`, [
      pair.sourceId,
    ]);
    const erpTarget = await call("GET /api/sp/migration/final-verification", {
      query: { sourceCompanyId: pair.sourceId, targetCompanyId: twoErp.rows[0].id },
    });
    expect(erpTarget).toMatchObject({
      status: 400,
      body: { message: "Target company must be type 'supplier_partner'" },
    });
  });

  it("reports status and a failing final verification for an unprepared pair", async () => {
    const status = await call("GET /api/sp/migration/cutover", { query: pairBody(pair) });
    expect(status.status).toBe(200);
    expect(status.body.liveCutover).toBeNull();
    expect(status.body.latestCutover).toBeNull();
    expect(status.body.verification).toMatchObject({ overall: "FAIL", canPrepare: false, canFinalize: false });

    const verification = await call("GET /api/sp/migration/final-verification", { query: pairBody(pair) });
    expect(verification.status).toBe(200);
    const codes = verification.body.blockers.map((issue: { code: string }) => issue.code);
    expect(codes).toEqual(
      expect.arrayContaining(["MISSING_GC_STOCK_MASTER", "MISSING_TARGET_ACCOUNTS", "PROFIT_OPENING_MISSING"])
    );
    expect(verification.body.areas.map((area: { area: string }) => area.area)).toEqual([
      "Inventory by location",
      "Historical sales copy",
      "Containers and Goods-OTW",
      "User and POS assignments",
      "Accounting readiness",
    ]);
  });

  it("reports the live cutover and verifies it without requiring an unused target", async () => {
    const id = await insertCutover(pair, "active");
    await insertVoucher({
      companyId: pair.targetId,
      number: `${pair.code}-LIVE-S`,
      type: "Journal",
      sourceModule: "ERP",
    });
    const status = await call("GET /api/sp/migration/cutover/status", { query: pairBody(pair) });
    expect(Number(status.body.liveCutover.id)).toBe(id);
    expect(Number(status.body.latestCutover.id)).toBe(id);
    expect(status.body.verification.counts.targetLiveActivity).toBe(1);
    const codes = status.body.verification.blockers.map((issue: { code: string }) => issue.code);
    expect(codes).not.toContain("TARGET_ALREADY_LIVE");
  });
});

describe("prepare and finalize refusals", () => {
  it("prepare requires the exact confirmation and company name", async () => {
    const wrongPhrase = await call("POST /api/sp/migration/cutover/prepare", {
      body: pairBody(pair, { confirmation: "PREPARE" }),
    });
    expect(wrongPhrase).toMatchObject({ status: 400, body: { message: 'Requires confirmation = "PREPARE CUTOVER"' } });

    const wrongName = await call("POST /api/sp/migration/cutover/prepare", {
      body: pairBody(pair, { confirmation: "PREPARE CUTOVER", companyNameConfirm: 42 }),
    });
    expect(wrongName.status).toBe(400);
    expect(wrongName.body.message).toContain("Company name confirmation must match exactly");
  });

  it("prepare refuses while a live cutover exists and while verification has FAIL items", async () => {
    const liveId = await insertCutover(pair, "prepared");
    const duplicate = await call("POST /api/sp/migration/cutover/prepare", {
      body: pairBody(pair, { confirmation: "PREPARE CUTOVER" }),
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.message).toBe(`Cutover ${liveId} is already prepared.`);

    await pool.query(`DELETE FROM sp_migration_cutovers WHERE id = $1`, [liveId]);
    const blocked = await call("POST /api/sp/migration/cutover/prepare", {
      body: pairBody(pair, { confirmation: "PREPARE CUTOVER" }),
    });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toBe("Cutover preparation is blocked. Resolve all FAIL items first.");
    expect(blocked.body.verification.canPrepare).toBe(false);
    expect(
      await scalar(`SELECT COUNT(*)::int FROM sp_migration_cutovers WHERE target_company_id = $1`, [pair.targetId])
    ).toBe(0);
  });

  it("finalize refuses once either company has a perpetual-inventory cut-over", async () => {
    await pool.query(
      `INSERT INTO gl_inventory_cutovers (company_id, effective_from, opening_plan, applied_by) VALUES ($1, '2026-10-01', '{}'::jsonb, 'test')`,
      [pair.sourceId]
    );
    const refused = await call("POST /api/sp/migration/cutover/finalize", {
      body: pairBody(pair, { confirmation: "FINALIZE CUTOVER" }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "PERPETUAL_INVENTORY_ACTIVE", action: "sp-migration-cutover" });
  });

  it("finalize requires confirmation, a prepared cutover and an unclaimed run", async () => {
    const wrong = await call("POST /api/sp/migration/cutover/finalize", {
      body: pairBody(pair, { confirmation: "MIGRATE" }),
    });
    expect(wrong).toMatchObject({ status: 400, body: { message: 'Requires confirmation = "FINALIZE CUTOVER"' } });

    const unprepared = await call("POST /api/sp/migration/cutover/finalize", {
      body: pairBody(pair, { confirmation: "FINALIZE CUTOVER" }),
    });
    expect(unprepared.status).toBe(409);
    expect(unprepared.body.message).toMatch(/Prepare and lock/);

    const activeId = await insertCutover(pair, "active");
    const active = await call("POST /api/sp/migration/cutover/finalize", {
      body: pairBody(pair, { confirmation: "FINALIZE CUTOVER" }),
    });
    expect(active.status).toBe(409);
    await pool.query(`DELETE FROM sp_migration_cutovers WHERE id = $1`, [activeId]);

    const preparedId = await insertCutover(pair, "prepared");
    await pool.query(`UPDATE sp_migration_cutovers SET finalize_started_at = now() WHERE id = $1`, [preparedId]);
    const claimed = await call("POST /api/sp/migration/cutover/finalize", {
      body: pairBody(pair, { confirmation: "FINALIZE CUTOVER" }),
    });
    expect(claimed.status).toBe(409);
    expect(claimed.body.message).toMatch(/already running or awaiting recovery/);
    expect((await cutoverRow(preparedId)).status).toBe("prepared");
  });
});

describe("rollback", () => {
  const rollback = (cutoverId: unknown, extra: Record<string, unknown> = {}) =>
    call("POST /api/sp/migration/cutover/rollback", {
      body: { cutoverId, confirmation: "ROLLBACK CUTOVER", companyNameConfirm: pair.sourceName, ...extra },
    });

  it("refuses unknown and non-active cutovers", async () => {
    expect((await rollback(2147480001)).status).toBe(404);
    const preparedId = await insertCutover(pair, "prepared");
    const refused = await rollback(preparedId);
    expect(refused).toMatchObject({ status: 409, body: { message: "Only an active cutover can be rolled back." } });
  });

  it("refuses a wrong confirmation and an expired rollback window", async () => {
    const id = await insertCutover(pair, "active", { rollbackDeadlineSql: "now() - interval '1 hour'" });
    const wrongName = await rollback(id, { companyNameConfirm: "Someone else" });
    expect(wrongName.status).toBe(400);
    const expired = await rollback(id);
    expect(expired).toMatchObject({ status: 409, body: { message: "The controlled rollback window has expired." } });
    const noDeadline = await insertCutover({ ...pair }, "rolled_back");
    expect((await rollback(noDeadline)).status).toBe(409);
    expect((await cutoverRow(id)).status).toBe("active");
  });

  it("refuses when the target has genuine post-cutover activity", async () => {
    const id = await insertCutover(pair, "active", {
      rollbackDeadlineSql: "now() + interval '1 day'",
      activatedAtSql: "now() - interval '1 hour'",
    });
    await insertVoucher({
      companyId: pair.targetId,
      number: `${pair.code}-LIVE-1`,
      type: "Journal",
      sourceModule: "ERP",
    });
    const refused = await rollback(id);
    expect(refused.status).toBe(409);
    expect(refused.body.activity).toMatchObject({ vouchers: 1, total: 1 });
    expect((await cutoverRow(id)).status).toBe("active");
  });

  it("rolls an active cutover back and holds the target read-only", async () => {
    const id = await insertCutover(pair, "active", {
      rollbackDeadlineSql: "now() + interval '1 day'",
      activatedAtSql: "now() - interval '1 hour'",
    });
    const result = await rollback(id);
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ success: true, stock: { restored: 0, deleted: 0 } });
    const row = await cutoverRow(id);
    expect(row.status).toBe("rolled_back");
    expect(row.target_write_hold).toBe(true);
    expect(row.rolled_back_by).toBe("spmig-dev");
  });
});

describe("cancel prepared cutover", () => {
  const cancel = (cutoverId: unknown, extra: Record<string, unknown> = {}) =>
    call("POST /api/sp/migration/cutover/cancel", {
      body: { cutoverId, confirmation: "CANCEL CUTOVER", companyNameConfirm: pair.sourceName, ...extra },
    });

  it("refuses unknown, non-prepared and unconfirmed cancellations", async () => {
    expect((await cancel(2147480001)).status).toBe(404);
    const activeId = await insertCutover(pair, "active");
    expect(await cancel(activeId)).toMatchObject({
      status: 409,
      body: { message: "Only a prepared cutover can be cancelled." },
    });
    await pool.query(`DELETE FROM sp_migration_cutovers WHERE id = $1`, [activeId]);
    const preparedId = await insertCutover(pair, "prepared");
    expect((await cancel(preparedId, { confirmation: "CANCEL" })).status).toBe(400);
    expect((await cutoverRow(preparedId)).status).toBe("prepared");
  });

  it("removes both locks when finalization never changed anything", async () => {
    const id = await insertCutover(pair, "prepared");
    const result = await cancel(id);
    expect(result.status).toBe(200);
    expect(result.body.message).toMatch(/both temporary locks were removed/);
    const row = await cutoverRow(id);
    expect(row.status).toBe("cancelled");
    expect(row.target_write_hold).toBe(false);
  });

  it("restores finalized stock and keeps the target held", async () => {
    const id = await insertCutover(pair, "prepared");
    const location = await insertLocation(pair.targetId, `${pair.code}-CXL`, `${PREFIX} cancel loc`);
    const item = await insertStockItem(pair.targetId, `${pair.code}-CXL-ITEM`);
    const createdInv = await insertInventory(pair.targetId, location, item, "5", "2", "10");
    const item2 = await insertStockItem(pair.targetId, `${pair.code}-CXL-ITEM2`);
    const updatedInv = await insertInventory(pair.targetId, location, item2, "9", "3", "27");
    await pool.query(
      `INSERT INTO sp_migration_cutover_stock_deltas
         (cutover_id, delta_key, target_inventory_id, target_stock_item_id, target_location_id, created_target_inventory,
          before_quantity, before_average_rate, before_total_value)
       VALUES ($1, 'k1', $2, $3, $4, true, 0, 0, 0), ($1, 'k2', $5, $6, $4, false, 4, 3, 12),
              ($1, 'k3', NULL, $6, $4, false, 0, 0, 0)`,
      [id, createdInv, item, location, updatedInv, item2]
    );
    const result = await cancel(id);
    expect(result.status).toBe(200);
    expect(result.body.stock).toEqual({ restored: 1, deleted: 1 });
    expect(result.body.message).toMatch(/remains read-only/);
    expect(await scalar(`SELECT COUNT(*)::int FROM inventory WHERE id = $1`, [createdInv])).toBe(0);
    expect(Number(await scalar(`SELECT quantity FROM inventory WHERE id = $1`, [updatedInv]))).toBe(4);
    expect((await cutoverRow(id)).target_write_hold).toBe(true);
    await pool.query(`DELETE FROM inventory WHERE company_id = $1`, [pair.targetId]);
  });
});

describe("release target hold", () => {
  const release = (cutoverId: unknown, extra: Record<string, unknown> = {}) =>
    call("POST /api/sp/migration/cutover/release-target-hold", {
      body: { cutoverId, confirmation: "RELEASE TARGET HOLD", companyNameConfirm: pair.sourceName, ...extra },
    });

  it("refuses unknown, unconfirmed and unheld cutovers", async () => {
    expect((await release(2147480001)).status).toBe(404);
    const activeId = await insertCutover(pair, "active");
    expect((await release(activeId, { confirmation: "RELEASE" })).status).toBe(400);
    expect(await release(activeId)).toMatchObject({
      status: 409,
      body: { message: "This cutover does not currently hold the target read-only." },
    });
    const notHeld = await insertCutover(pair, "cancelled");
    expect((await release(notHeld)).status).toBe(409);
  });

  it("refuses when a newer cutover controls the lock", async () => {
    const older = await insertCutover(pair, "rolled_back", { targetWriteHold: true });
    await insertCutover(pair, "cancelled");
    const result = await release(older);
    expect(result.status).toBe(409);
    expect(result.body.message).toMatch(/newer cutover exists/);
  });

  it("refuses while genuine target transactions exist, then releases", async () => {
    const id = await insertCutover(pair, "failed", { targetWriteHold: true });
    await insertVoucher({
      companyId: pair.targetId,
      number: `${pair.code}-LIVE-2`,
      type: "Journal",
      sourceModule: "ERP",
    });
    const refused = await release(id);
    expect(refused.status).toBe(409);
    expect(refused.body.activity.vouchers).toBe(1);

    await pool.query(`DELETE FROM vouchers WHERE company_id = $1 AND source_module = 'ERP'`, [pair.targetId]);
    const released = await release(id);
    expect(released.status).toBe(200);
    expect(released.body.cutover.target_write_hold).toBe(false);
  });
});

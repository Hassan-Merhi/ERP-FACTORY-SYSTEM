/**
 * The 30-day soft-delete purge against PostgreSQL. The purge opens its own
 * transaction; here every pool and drizzle call is routed to one client whose
 * outer transaction is rolled back, so its BEGIN/COMMIT become savepoints and
 * nothing it removes is really lost.
 */
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../server/lib/logger";
import { purgeOldSoftDeletes } from "../server/services/scheduler/maintenance";
import { withRolledBackPool } from "./helpers/routedPoolClient";

let seq = 0;
const OLD = "NOW() - INTERVAL '40 days'";
const RECENT = "NOW() - INTERVAL '10 days'";

async function id(client: PoolClient, text: string, values: unknown[] = []): Promise<number> {
  return Number((await client.query<{ id: number }>(text, values)).rows[0].id);
}

async function exists(client: PoolClient, table: string, rowId: number): Promise<boolean> {
  return (await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [rowId])).rowCount === 1;
}

async function purgeAudits(client: PoolClient, companyId: number) {
  return (
    await client.query(
      `SELECT table_name, record_id, record_identifier, changes->'reason'->>'new' AS reason,
              changes->'row'->'old'->>'deleted_at' IS NOT NULL AS has_row
         FROM audit_log WHERE company_id = $1 AND username = 'scheduler:soft-delete-purge' ORDER BY id`,
      [companyId]
    )
  ).rows;
}

async function seed(client: PoolClient) {
  const tag = `PRG${process.pid}${++seq}`;
  const companyId = await id(client, "INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [tag, tag]);
  const locationId = await id(client, "INSERT INTO locations(company_id,code,name) VALUES($1,$2,'Shop') RETURNING id", [
    companyId,
    `${tag}-L`,
  ]);
  const item = (code: string, deletedAt: string | null) =>
    id(
      client,
      `INSERT INTO stock_items(company_id,code,name,uom,deleted_at) VALUES($1,$2,$3,'Bale',${deletedAt ?? "NULL"}) RETURNING id`,
      [companyId, `${tag}-${code}`, `${tag}-${code}`]
    );
  return { tag, companyId, locationId, item };
}

beforeEach(() => {
  vi.spyOn(logger, "info").mockImplementation(() => logger);
  vi.spyOn(logger, "warn").mockImplementation(() => logger);
  vi.spyOn(logger, "error").mockImplementation(() => logger);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("purgeOldSoftDeletes", () => {
  it("removes old empty stock items with their empty rows and keeps items with stock", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const empty = await w.item("EMPTY", OLD);
      const stocked = await w.item("STOCKED", OLD);
      const recent = await w.item("RECENT", RECENT);
      const live = await w.item("LIVE", null);
      await client.query("INSERT INTO inventory(company_id,location_id,stock_item_id,quantity) VALUES($1,$2,$3,0)", [
        w.companyId,
        w.locationId,
        empty,
      ]);
      await client.query("INSERT INTO stock_item_code_aliases(company_id,stock_item_id,alias_code) VALUES($1,$2,$3)", [
        w.companyId,
        empty,
        `${w.tag}-ALIAS`,
      ]);
      await client.query(
        "INSERT INTO stock_item_location_prices(stock_item_id,location_id,selling_price) VALUES($1,$2,9)",
        [empty, w.locationId]
      );
      await client.query("INSERT INTO inventory(company_id,location_id,stock_item_id,quantity) VALUES($1,$2,$3,5)", [
        w.companyId,
        w.locationId,
        stocked,
      ]);

      await purgeOldSoftDeletes();

      expect(await exists(client, "stock_items", empty)).toBe(false);
      expect((await client.query("SELECT 1 FROM inventory WHERE stock_item_id=$1", [empty])).rowCount).toBe(0);
      expect(
        (await client.query("SELECT 1 FROM stock_item_code_aliases WHERE stock_item_id=$1", [empty])).rowCount
      ).toBe(0);
      expect(
        (await client.query("SELECT 1 FROM stock_item_location_prices WHERE stock_item_id=$1", [empty])).rowCount
      ).toBe(0);
      for (const kept of [stocked, recent, live]) expect(await exists(client, "stock_items", kept)).toBe(true);

      expect(await purgeAudits(client, w.companyId)).toEqual([
        {
          table_name: "stock_items",
          record_id: empty,
          record_identifier: `${w.tag}-EMPTY`,
          reason: "30-day soft-delete purge",
          has_row: true,
        },
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        "[Purge] Deleted stock items that still hold stock or stock history were retained.",
        { retained: expect.any(Number) }
      );
      expect(logger.info).toHaveBeenCalledWith(
        expect.stringMatching(/^\[Purge\] Permanently deleted \d+ stock item\(s\)/)
      );
      expect(logger.info).toHaveBeenCalledWith("[Purge] 30-day soft-delete purge complete.");
    });
  });

  it("purges unreferenced old mix batches and keeps those with production history", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const batch = (code: string, deletedAt: string) =>
        id(
          client,
          `INSERT INTO factory_mix_batches(company_id,batch_code,cost_per_kg,deleted_at) VALUES($1,$2,1,${deletedAt}) RETURNING id`,
          [w.companyId, `${w.tag}-${code}`]
        );
      const orphan = await batch("ORPHAN", OLD);
      const used = await batch("USED", OLD);
      // Consumed by a later batch while it was live, then deleted.
      const sourced = await batch("SOURCED", "NULL");
      const fresh = await batch("FRESH", RECENT);
      await client.query(
        "INSERT INTO factory_daily_usages(company_id,mix_batch_id,kg_used,used_date) VALUES($1,$2,10,'2026-01-01')",
        [w.companyId, used]
      );
      await client.query(
        "INSERT INTO factory_mix_batch_sources(mix_batch_id,weight_kg,cost_per_kg,total_cost,source_type,source_id,source_batch_id) VALUES($1,1,1,1,'BATCH',$2,$2)",
        [await batch("CONSUMER", "NULL"), sourced]
      );
      await client.query(`UPDATE factory_mix_batches SET deleted_at = ${OLD} WHERE id = $1`, [sourced]);

      await purgeOldSoftDeletes();

      expect(await exists(client, "factory_mix_batches", orphan)).toBe(false);
      for (const kept of [used, sourced, fresh]) expect(await exists(client, "factory_mix_batches", kept)).toBe(true);
      expect((await purgeAudits(client, w.companyId)).map((row) => [row.table_name, row.record_identifier])).toEqual([
        ["factory_mix_batches", `${w.tag}-ORPHAN`],
      ]);
      const retained = vi
        .mocked(logger.info)
        .mock.calls.find(([message]) =>
          String(message).startsWith("[Purge] Retained soft-deleted factory mix batches")
        );
      expect(retained?.[1]).toMatchObject({ protectedCount: expect.any(Number) });
      const samples = (retained?.[1] as { samples: Array<Record<string, unknown>> }).samples;
      expect(samples).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            mixBatchId: used,
            companyId: w.companyId,
            batchCode: `${w.tag}-USED`,
            references: expect.objectContaining({ daily_usages: 1 }),
          }),
        ])
      );
    });
  });

  it("keeps parties and accounts that carry history and audits what it removes", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const customer = (code: string, opening: number) =>
        id(
          client,
          `INSERT INTO customers(company_id,code,legal_name,opening_balance,deleted_at) VALUES($1,$2,$3,$4,${OLD}) RETURNING id`,
          [w.companyId, `${w.tag}-${code}`, `${w.tag}-${code}`, opening]
        );
      const plain = await customer("PLAIN", 0);
      const opening = await customer("OPENING", 25);
      const named = await customer("NAMED", 0);
      const voucherId = await id(
        client,
        "INSERT INTO vouchers(company_id,voucher_number,voucher_type,voucher_date,total_amount,currency) VALUES($1,$2,'Journal','2026-01-01',0,'USD') RETURNING id",
        [w.companyId, `${w.tag}-V`]
      );
      await client.query(
        "INSERT INTO voucher_entries(voucher_id,company_id,customer_id,debit_amount,credit_amount,base_debit_amount,base_credit_amount) VALUES($1,$2,$3,5,0,5,0)",
        [voucherId, w.companyId, named]
      );
      const supplier = await id(
        client,
        `INSERT INTO suppliers(company_id,code,legal_name,email,deleted_at) VALUES($1,$2,'Vendor','v@x.test',${OLD}) RETURNING id`,
        [w.companyId, `${w.tag}-S`]
      );
      const group = await id(
        client,
        `INSERT INTO stock_groups(company_id,code,name,deleted_at) VALUES($1,$2,'Old group',${OLD}) RETURNING id`,
        [w.companyId, `${w.tag}-G`]
      );

      await purgeOldSoftDeletes();

      expect(await exists(client, "customers", plain)).toBe(false);
      expect(await exists(client, "customers", opening)).toBe(true);
      expect(await exists(client, "customers", named)).toBe(true);
      expect(await exists(client, "suppliers", supplier)).toBe(false);
      expect(await exists(client, "stock_groups", group)).toBe(false);
      expect(
        (await purgeAudits(client, w.companyId)).map((row) => [row.table_name, row.record_id, row.record_identifier])
      ).toEqual([
        ["stock_groups", group, `${w.tag}-G`],
        ["customers", plain, `${w.tag}-PLAIN`],
        ["suppliers", supplier, `${w.tag}-S`],
      ]);
      expect(logger.warn).toHaveBeenCalledWith(
        "[Purge] Deleted customers rows with voucher lines or an opening balance were retained.",
        { retained: expect.any(Number) }
      );
    });
  });

  it("isolates a table whose delete is blocked and still finishes the run", async () => {
    await withRolledBackPool(async (client) => {
      const w = await seed(client);
      const blocked = await id(
        client,
        `INSERT INTO locations(company_id,code,name,deleted_at) VALUES($1,$2,'Closed',${OLD}) RETURNING id`,
        [w.companyId, `${w.tag}-CLOSED`]
      );
      await client.query(
        "INSERT INTO vouchers(company_id,voucher_number,voucher_type,voucher_date,total_amount,currency,location_id) VALUES($1,$2,'Journal','2026-01-01',0,'USD',$3)",
        [w.companyId, `${w.tag}-V`, blocked]
      );
      const group = await id(
        client,
        `INSERT INTO stock_groups(company_id,code,name,deleted_at) VALUES($1,$2,'Old group',${OLD}) RETURNING id`,
        [w.companyId, `${w.tag}-G`]
      );

      await purgeOldSoftDeletes();

      expect(await exists(client, "locations", blocked)).toBe(true);
      expect(logger.error).toHaveBeenCalledWith(
        "[Purge] Isolated purge unit failed; retained its rows and continuing.",
        expect.objectContaining({
          label: "locations",
          dbErrorCode: "23503",
          dbTable: expect.any(String),
          dbConstraint: expect.any(String),
        })
      );
      // Units before and after the blocked one still ran.
      expect(await exists(client, "stock_groups", group)).toBe(false);
      expect(logger.info).toHaveBeenCalledWith("[Purge] 30-day soft-delete purge complete.");
    });
  });
});

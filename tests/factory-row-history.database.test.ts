/**
 * Factory row history (server/services/audit/factoryRowHistory.ts), against a
 * real PostgreSQL schema: the install snapshots every existing row once and is
 * a no-op afterwards; inserts, material edits and deletes are recorded, with an
 * edit keeping only the columns it changed; touch-only and carrier-tracking
 * updates are not; the history itself cannot be rewritten.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { pool } from "../server/db";
import { runWithDatabaseMaintenanceScope } from "../server/services/security/databaseScopeRuntimeContext";
import {
  ensureFactoryRowHistory,
  FACTORY_ROW_HISTORY_TABLES,
  FACTORY_ROW_HISTORY_VERSION,
} from "../server/services/audit/factoryRowHistory";

const hasDatabase = Boolean(process.env.DATABASE_URL);
const databaseDescribe = hasDatabase ? describe : describe.skip;

type HistoryRow = {
  op: string;
  company_id: number | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
};

async function history(table: string, recordId: number): Promise<HistoryRow[]> {
  const result = await runWithDatabaseMaintenanceScope("row-history-test-read", () =>
    pool.query<HistoryRow>(
      `SELECT op, company_id, old_values, new_values FROM factory_row_history
      WHERE table_name = $1 AND record_id = $2 ORDER BY id`,
      [table, recordId]
    )
  );
  return result.rows;
}

databaseDescribe("factory row history", () => {
  const suffix = `${process.pid}${Date.now() % 100000}`;
  let companyId = 0;
  let preexistingSupplier = 0;

  beforeAll(async () => {
    const company = await pool.query<{ id: number }>(
      `INSERT INTO companies (code, name, company_type) VALUES ($1, $2, 'factory') RETURNING id`,
      [`RH${suffix}`, `Row history ${suffix}`]
    );
    companyId = company.rows[0].id;
    // Exists before the install, so it must appear in the baseline (unless an
    // earlier run already installed the triggers, in which case it is an insert).
    const supplier = await pool.query<{ id: number }>(
      `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`,
      [companyId, `Before ${suffix}`]
    );
    preexistingSupplier = supplier.rows[0].id;
  }, 60_000);

  afterAll(async () => {
    if (!companyId) return;
    await pool.query(`DELETE FROM factory_containers WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [companyId]);
    await pool.query(`DELETE FROM companies WHERE id = $1`, [companyId]);
  });

  it("installs every tracked table once, with its baseline, and skips it afterwards", async () => {
    const first = await ensureFactoryRowHistory(pool);
    expect(first.failed).toEqual([]);

    const baselines = await pool.query<{ table_name: string; snapshot_rows: number; version: string }>(
      `SELECT table_name, snapshot_rows, version FROM factory_row_history_baselines WHERE table_name = ANY($1::text[])`,
      [FACTORY_ROW_HISTORY_TABLES.map(([table]) => table)]
    );
    const present = await pool.query<{ table_name: string }>(
      `SELECT t AS table_name FROM unnest($1::text[]) AS t WHERE to_regclass('public.' || t) IS NOT NULL`,
      [FACTORY_ROW_HISTORY_TABLES.map(([table]) => table)]
    );
    expect(baselines.rows.map((row) => row.table_name).sort()).toEqual(
      present.rows.map((row) => row.table_name).sort()
    );
    expect(new Set(baselines.rows.map((row) => row.version))).toEqual(new Set([FACTORY_ROW_HISTORY_VERSION]));

    const before = await runWithDatabaseMaintenanceScope("row-history-test-count", () =>
      pool.query<{ n: string }>(`SELECT count(*) AS n FROM factory_row_history WHERE op = 'S'`)
    );
    const second = await ensureFactoryRowHistory(pool);
    expect(second.installed).toEqual([]);
    expect(second.failed).toEqual([]);
    const after = await runWithDatabaseMaintenanceScope("row-history-test-count", () =>
      pool.query<{ n: string }>(`SELECT count(*) AS n FROM factory_row_history WHERE op = 'S'`)
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);

    // In the baseline when this run took it; an insert when an earlier install already recorded it.
    const recorded = await history("factory_suppliers", preexistingSupplier);
    expect(recorded).toHaveLength(1);
    expect(["S", "I"]).toContain(recorded[0].op);
    expect(recorded[0]).toMatchObject({ company_id: companyId, new_values: { name: `Before ${suffix}` } });
  });

  it("records inserts, only the changed columns of an edit, and deletes", async () => {
    const created = await pool.query<{ id: number }>(
      `INSERT INTO factory_suppliers (company_id, name, phone) VALUES ($1, $2, '111') RETURNING id`,
      [companyId, `Tracked ${suffix}`]
    );
    const id = created.rows[0].id;

    await pool.query(`UPDATE factory_suppliers SET phone = '222' WHERE id = $1`, [id]);
    await pool.query(`UPDATE factory_suppliers SET name = name WHERE id = $1`, [id]);
    await pool.query(`UPDATE factory_suppliers SET updated_at = now() + interval '1 minute' WHERE id = $1`, [id]);
    await pool.query(`DELETE FROM factory_suppliers WHERE id = $1`, [id]);

    const rows = await history("factory_suppliers", id);
    expect(rows.map((row) => row.op)).toEqual(["I", "U", "D"]);
    expect(rows[0]).toMatchObject({ company_id: companyId, new_values: { name: `Tracked ${suffix}`, phone: "111" } });
    expect(rows[1].old_values).toEqual({ phone: "111" });
    expect(rows[1].new_values).toEqual({ phone: "222" });
    expect(rows[2]).toMatchObject({ old_values: { id, phone: "222" } });
  });

  it("ignores a container's carrier-tracking refresh but records a rate change", async () => {
    const container = await pool.query<{ id: number }>(
      `INSERT INTO factory_containers (company_id, container_number, total_kg, rate_per_kg, status)
       VALUES ($1, $2, 1000, 0.5, 'PENDING') RETURNING id`,
      [companyId, `RH${suffix}`]
    );
    const id = container.rows[0].id;

    await pool.query(
      `UPDATE factory_containers SET tracking_last_checked_at = now(), tracking_last_status = 'at sea', updated_at = now()
        WHERE id = $1`,
      [id]
    );
    await pool.query(`UPDATE factory_containers SET rate_per_kg = 0.55 WHERE id = $1`, [id]);

    const rows = await history("factory_containers", id);
    expect(rows.map((row) => row.op)).toEqual(["I", "U"]);
    expect(rows[1].old_values).toEqual({ rate_per_kg: 0.5 });
    expect(rows[1].new_values).toEqual({ rate_per_kg: 0.55 });
  });

  it("stamps a change when it is written, not when its transaction began", async () => {
    const client = await pool.connect();
    const { id, began } = await (async () => {
      try {
        await client.query("BEGIN");
        const start = (await client.query<{ at: string }>(`SELECT (now() AT TIME ZONE 'UTC')::text AS at`)).rows[0].at;
        await client.query(`SELECT pg_sleep(0.3)`);
        const created = await client.query<{ id: number }>(
          `INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`,
          [companyId, `Late ${suffix}`]
        );
        await client.query("COMMIT");
        return { id: created.rows[0].id, began: start };
      } finally {
        client.release();
      }
    })();
    const stamped = await runWithDatabaseMaintenanceScope("row-history-test-stamp", () =>
      pool.query<{ late: boolean }>(
        `SELECT recorded_at >= $1::timestamp + interval '250 milliseconds' AS late
         FROM factory_row_history WHERE table_name = 'factory_suppliers' AND record_id = $2 AND op = 'I'`,
        [began, id]
      )
    );
    expect(stamped.rows).toEqual([{ late: true }]);

    const baseline = await runWithDatabaseMaintenanceScope("row-history-test-baseline", () =>
      pool.query<{ aligned: boolean }>(
        `SELECT bool_and(h.recorded_at = b.baseline_at) AS aligned
         FROM factory_row_history h JOIN factory_row_history_baselines b ON b.table_name = h.table_name
        WHERE h.op = 'S'`
      )
    );
    expect(baseline.rows[0].aligned).not.toBe(false);
  });

  it("records an unscoped write under RLS and shows each tenant only its own history", async () => {
    // The superuser test connection bypasses RLS; production's role does not.
    expect((await ensureFactoryRowHistory(pool)).failed).toEqual([]);
    const role = `rh_app_${suffix}`;
    await pool.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await pool.query(`GRANT USAGE ON SCHEMA public TO ${role}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA public TO ${role}`);
    await pool.query(`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO ${role}`);
    const other = await pool.query<{ id: number }>(
      `INSERT INTO companies (code, name, company_type) VALUES ($1, $2, 'factory') RETURNING id`,
      [`RO${suffix}`, `Row history other ${suffix}`]
    );
    const otherCompany = other.rows[0].id;
    const client = await pool.connect();
    try {
      const asRole = async <T>(settings: [string, string][], work: () => Promise<T>): Promise<T> => {
        await client.query("BEGIN");
        try {
          await client.query(`SET LOCAL ROLE ${role}`);
          for (const [name, value] of settings) await client.query(`SELECT set_config($1, $2, true)`, [name, value]);
          const result = await work();
          await client.query("COMMIT");
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        }
      };
      const unscoped: [string, string][] = [
        ["app.company_scope_maintenance", "off"],
        ["app.current_company_id", ""],
      ];
      // An unscoped write to a table without RLS of its own must still succeed.
      const created = await asRole(unscoped, () =>
        client.query<{ id: number }>(`INSERT INTO factory_suppliers (company_id, name) VALUES ($1, $2) RETURNING id`, [
          otherCompany,
          `Unscoped ${suffix}`,
        ])
      );
      const otherSupplier = created.rows[0].id;
      expect(await history("factory_suppliers", otherSupplier)).toMatchObject([{ op: "I", company_id: otherCompany }]);

      const visible = await asRole(
        [
          ["app.company_scope_maintenance", "off"],
          ["app.current_company_id", String(companyId)],
        ],
        () =>
          client.query<{ company_id: number }>(
            `SELECT DISTINCT company_id FROM factory_row_history WHERE company_id = ANY($1::int[])`,
            [[companyId, otherCompany]]
          )
      );
      expect(visible.rows).toEqual([{ company_id: companyId }]);

      // FORCE RLS: the owner role sees a company's saved row images only in that company's scope.
      const countFor = (scopeCompany: number) =>
        asRole(
          [
            ["app.company_scope_maintenance", "off"],
            ["app.current_company_id", String(scopeCompany)],
          ],
          () =>
            client.query<{ n: string }>(
              `SELECT COUNT(*)::text AS n FROM factory_row_history WHERE table_name = 'factory_suppliers' AND record_id = $1`,
              [preexistingSupplier]
            )
        );
      expect(Number((await countFor(companyId)).rows[0].n)).toBeGreaterThan(0);
      expect((await countFor(otherCompany)).rows[0].n).toBe("0");
      const security = await pool.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'factory_row_history'::regclass`
      );
      expect(security.rows[0]).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true });
    } finally {
      client.release();
      await pool.query(`DELETE FROM factory_suppliers WHERE company_id = $1`, [otherCompany]);
      await pool.query(`DELETE FROM companies WHERE id = $1`, [otherCompany]);
      await pool.query(`DROP OWNED BY ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  });

  it("refuses to change, delete or truncate recorded history", async () => {
    for (const statement of [
      `UPDATE factory_row_history SET actor = 'x' WHERE id = (SELECT max(id) FROM factory_row_history)`,
      `DELETE FROM factory_row_history WHERE id = (SELECT max(id) FROM factory_row_history)`,
      `TRUNCATE factory_row_history`,
    ]) {
      await expect(
        runWithDatabaseMaintenanceScope("row-history-test-append-only", () => pool.query(statement))
      ).rejects.toMatchObject({ code: "42501" });
    }
  });
});

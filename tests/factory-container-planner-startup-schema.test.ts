import { getTableColumns, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { ensureFactoryContainerPlannerSchema } from "../server/startup/factoryContainerPlannerSchema";
import {
  factoryContainerPlanAllocations,
  factoryContainerPlanBales,
  factoryContainerPlanContainerEvents,
  factoryContainerPlanContainers,
  factoryContainerPlanDocuments,
  factoryContainerPlanLines,
  factoryContainerPlans,
} from "../shared/schema/factory/container-planner";

// An isolated schema stands in for a production database that predates the
// planner: it has the referenced companies/customers tables but no planner tables.
const SCHEMA = `planner_boot_probe_${process.pid}`;
const plannerTables: PgTable[] = [
  factoryContainerPlans,
  factoryContainerPlanContainers,
  factoryContainerPlanLines,
  factoryContainerPlanBales,
  factoryContainerPlanAllocations,
  factoryContainerPlanContainerEvents,
  factoryContainerPlanDocuments,
];

const scopedPool = {
  async connect() {
    const client = await pool.connect();
    await client.query(`SET search_path TO ${SCHEMA}`);
    return {
      query: client.query.bind(client),
      release: () => {
        void client.query("RESET search_path").finally(() => client.release());
      },
    } as Awaited<ReturnType<typeof pool.connect>>;
  },
};

async function columnsByTable(): Promise<Map<string, Set<string>>> {
  const { rows } = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = $1`,
    [SCHEMA]
  );
  const result = new Map<string, Set<string>>();
  for (const row of rows) {
    if (!result.has(row.table_name)) result.set(row.table_name, new Set());
    result.get(row.table_name)!.add(row.column_name);
  }
  return result;
}

describe("Factory container planner startup schema", () => {
  beforeAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    await pool.query(`CREATE TABLE ${SCHEMA}.companies (id SERIAL PRIMARY KEY)`);
    await pool.query(`CREATE TABLE ${SCHEMA}.customers (id SERIAL PRIMARY KEY)`);
  });

  afterAll(async () => {
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  });

  it("creates every planner table with the columns the application declares", async () => {
    await ensureFactoryContainerPlannerSchema(scopedPool);
    const columns = await columnsByTable();
    for (const table of plannerTables) {
      const declared = Object.values(getTableColumns(table)).map((column) => column.name);
      const created = columns.get(getTableName(table));
      expect(created, getTableName(table)).toBeDefined();
      expect([...created!].sort(), getTableName(table)).toEqual([...declared].sort());
    }
  });

  it("is idempotent and keeps existing plan rows on a second boot", async () => {
    await pool.query(`INSERT INTO ${SCHEMA}.companies DEFAULT VALUES`);
    await pool.query(
      `INSERT INTO ${SCHEMA}.factory_container_plans (company_id, name, capacity_bales) VALUES (1, 'Kept plan', 10)`
    );
    await ensureFactoryContainerPlannerSchema(scopedPool);
    const { rows } = await pool.query(`SELECT name FROM ${SCHEMA}.factory_container_plans`);
    expect(rows).toEqual([{ name: "Kept plan" }]);
  });

  it("rolls back a partial run so boot never leaves half a planner schema", async () => {
    await pool.query(`DROP SCHEMA ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
    // No customers table: the allocations phase must fail and undo earlier phases.
    await pool.query(`CREATE TABLE ${SCHEMA}.companies (id SERIAL PRIMARY KEY)`);
    await expect(ensureFactoryContainerPlannerSchema(scopedPool)).rejects.toThrow(/customers/);
    expect((await columnsByTable()).has("factory_container_plans")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { pool } from "../server/db";
import { containerFreightPayments } from "@shared/schema";
import {
  factoryBaleWasteDispatches,
  factoryPosSales,
  factoryPressingBatches,
  factoryWasteEntries,
  pressingBatches,
} from "@shared/schema";

/**
 * Startup migration 002 converts every `created_by` below from integer to
 * character varying, because the column holds `users.id`, which is a varchar.
 *
 * The Drizzle declarations used to say `integer`. That had two consequences:
 * `drizzle-kit push` against a database where the migration had already run
 * failed with "column created_by cannot be cast automatically to type integer",
 * and route code narrowed the session's string user id to a number, dropping
 * attribution whenever the id was not numeric.
 *
 * This test pins the declaration to the database so the two cannot drift again.
 */
const CREATED_BY_TABLES = [
  ["factory_bale_waste_dispatches", factoryBaleWasteDispatches],
  ["factory_pos_sales", factoryPosSales],
  ["factory_waste_entries", factoryWasteEntries],
  ["factory_pressing_batches", factoryPressingBatches],
  ["pressing_batches", pressingBatches],
  ["container_freight_payments", containerFreightPayments],
] as const;

describe("created_by column contract", () => {
  it.each(CREATED_BY_TABLES.map(([name]) => name))(
    "%s.created_by is a character varying in the database",
    async (tableName) => {
      const { rows } = await pool.query<{ data_type: string }>(
        `SELECT data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1 AND column_name = 'created_by'`,
        [tableName]
      );
      expect(rows).toHaveLength(1);
      expect(rows[0].data_type).toBe("character varying");
    }
  );

  it("declares created_by as a string column in every schema definition", () => {
    for (const [tableName, table] of CREATED_BY_TABLES) {
      const column = table.createdBy;
      expect(column, `${tableName}.createdBy must exist`).toBeDefined();
      expect(column.dataType, `${tableName}.createdBy must be a string column`).toBe("string");
    }
  });
});

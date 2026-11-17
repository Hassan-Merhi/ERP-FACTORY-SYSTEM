import { getTableColumns, getTableName } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import {
  factoryContainerPlanAllocations,
  factoryContainerPlanBales,
  factoryContainerPlanContainerEvents,
  factoryContainerPlanContainers,
  factoryContainerPlanDocuments,
  factoryContainerPlanLines,
  factoryContainerPlans,
} from "../shared/schema/factory/container-planner";
import { hasTable, schemaManifest } from "./helpers/schemaManifest";

// The planner tables used to be created at boot (server/startup/factoryContainerPlannerSchema.ts,
// with retries and rollback). Migrations now define them and startup only
// verifies the schema, so the boot-time idempotence/retry cases no longer apply.
const plannerTables: PgTable[] = [
  factoryContainerPlans,
  factoryContainerPlanContainers,
  factoryContainerPlanLines,
  factoryContainerPlanBales,
  factoryContainerPlanAllocations,
  factoryContainerPlanContainerEvents,
  factoryContainerPlanDocuments,
];

function manifestColumns(table: string): string[] {
  const prefix = `public.${table}.`;
  return (
    schemaManifest()
      .filter((entry) => entry.kind === "column" && entry.identity.startsWith(prefix))
      // Reserved words such as "position" are quoted in the identity.
      .map((entry) => entry.identity.slice(prefix.length).replace(/^"(.*)"$/, "$1"))
  );
}

describe("Factory container planner schema", () => {
  it("migrations define every planner table with the columns the application declares", () => {
    for (const table of plannerTables) {
      const name = getTableName(table);
      const declared = Object.values(getTableColumns(table)).map((column) => column.name);
      expect(hasTable(name), name).toBe(true);
      expect(manifestColumns(name).sort(), name).toEqual([...declared].sort());
    }
  });
});

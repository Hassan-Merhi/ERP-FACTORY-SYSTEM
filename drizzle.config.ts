import { defineConfig } from "drizzle-kit";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./shared/schema";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL, ensure the database is provisioned");
}

// drizzle-kit only manages the tables declared in shared/schema. Many tables
// are still created by runtime startup DDL (server/startup-schema, the
// ensure* services and the preload bridges) and are not declared here; without
// this filter `drizzle-kit push` treats them as obsolete and drops them, data
// included. scripts/audit-runtime-only-tables.mjs tracks that gap.
const declaredTables = Object.values(schema)
  .filter((value): value is PgTable => value instanceof PgTable)
  .map((table) => getTableConfig(table).name);

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  tablesFilter: [...new Set(declaredTables)].sort(),
});

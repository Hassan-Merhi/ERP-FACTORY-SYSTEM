import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  criticalColumns,
  criticalIndexes,
  criticalTables,
  evaluateCriticalSchema,
} from "../server/criticalSchemaReadiness.mjs";
import { columnDefinition } from "./helpers/schemaManifest";

function completeSnapshot() {
  return {
    tables: [...criticalTables],
    columns: criticalColumns.map(([tableName, columnName]) => ({ tableName, columnName })),
    indexes: [...criticalIndexes],
  };
}

describe("critical schema readiness", () => {
  it("reports ready only when all required schema objects exist", () => {
    expect(evaluateCriticalSchema(completeSnapshot())).toEqual({
      ok: true,
      missingTables: [],
      missingColumns: [],
      missingIndexes: [],
    });
  });

  it("reports the exact missing table, column, and index", () => {
    const snapshot = completeSnapshot();
    snapshot.tables = snapshot.tables.filter((tableName) => tableName !== "fiscal_period_closures");
    snapshot.columns = snapshot.columns.filter(
      ({ tableName, columnName }) => !(tableName === "voucher_entries" && columnName === "base_debit_amount")
    );
    snapshot.indexes = snapshot.indexes.filter((indexName) => indexName !== "exchange_rates_company_date_pair_unique");

    expect(evaluateCriticalSchema(snapshot)).toEqual({
      ok: false,
      missingTables: ["fiscal_period_closures"],
      missingColumns: ["voucher_entries.base_debit_amount"],
      missingIndexes: ["exchange_rates_company_date_pair_unique"],
    });
  });

  it("blocks readiness when a factory container JSONCargo column is absent", () => {
    const snapshot = completeSnapshot();
    snapshot.columns = snapshot.columns.filter(
      ({ tableName, columnName }) =>
        !(tableName === "factory_containers" && columnName === "json_cargo_last_checked_at")
    );

    expect(evaluateCriticalSchema(snapshot)).toMatchObject({
      ok: false,
      missingColumns: ["factory_containers.json_cargo_last_checked_at"],
    });
  });

  it("migrations define the factory container JSONCargo columns the gate verifies before the entrypoint", () => {
    const startupPreload = fs.readFileSync(path.resolve(process.cwd(), "server/startupPreload.mjs"), "utf8");
    const packageJson = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"));

    // No preload bridge repairs the schema any more: the read-only schema gate
    // aborts startup when the database does not match the migrations.
    expect(startupPreload).not.toContain("factoryContainerSchemaBridge");
    expect(startupPreload).toContain("await runStartupSchemaGateOnce();");
    expect(packageJson.scripts.start).toContain("--import ./server/startupPreload.mjs");
    expect(columnDefinition("factory_containers", "json_cargo_last_checked_at")?.type).toBe("timestamp with time zone");
    expect(columnDefinition("factory_containers", "json_cargo_tracking_status")?.type).toBe("text");
    expect(columnDefinition("factory_containers", "json_cargo_error")?.type).toBe("text");
  });

  it("keeps Render on the schema-aware readiness endpoint", () => {
    const renderYaml = fs.readFileSync(path.resolve(process.cwd(), "render.yaml"), "utf8");
    const runtimeGuard = fs.readFileSync(path.resolve(process.cwd(), "server/runtimeHealthGuard.mjs"), "utf8");

    expect(renderYaml).toContain("healthCheckPath: /api/health/ready");
    expect(runtimeGuard).toContain("database.schema?.ok === true");
    expect(runtimeGuard).toContain("evaluateCriticalSchema");
  });
});

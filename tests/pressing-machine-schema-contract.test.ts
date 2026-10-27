import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { factoryPressingMachineTrackingSchema } from "../server/startup-schema/037-factory-pressing-machine-tracking";

const ddl = factoryPressingMachineTrackingSchema.join(";\n\n");
const sqlFile = fs.readFileSync(
  path.join(process.cwd(), "migrations/20261027_001_factory_pressing_machine_tracking.sql"),
  "utf8"
);

describe("pressing machine Phase 1 schema contracts", () => {
  it("keeps the production migration identical to the startup schema", () => {
    expect(factoryPressingMachineTrackingSchema).toHaveLength(37);
    expect(sqlFile).toContain(ddl + ";\n");
  });

  it("has complete lifecycle tables without mutating inventory", () => {
    for (const name of [
      "factory_pressing_machines",
      "factory_pressing_assignments",
      "factory_pressing_shifts",
      "factory_pressing_sessions",
      "factory_pressing_confirmations",
      "factory_pressing_downtime",
      "factory_pressing_corrections",
      "factory_pressing_saved_views",
    ]) {
      expect(ddl).toContain("CREATE TABLE IF NOT EXISTS " + name);
    }
    expect(ddl).not.toMatch(/(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:factory_bales|stock_movements|voucher_entries|factory_mix_batches)\b/i);
  });

  it("prevents two active pressing confirmations for one bale across all machines and days", () => {
    expect(ddl).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS factory_pressing_confirmations_one_active_bale_uk ON factory_pressing_confirmations \(company_id, bale_id\) WHERE voided_at IS NULL/
    );
    expect(ddl).toContain("factory_pressing_confirmations_request_uk");
    expect(ddl).toContain("factory_pressing_confirmations_bale_fk");
    expect(ddl).toContain("factory_bales (company_id, id)");
  });

  it("enforces one active machine assignment per operator and same-identity sessions", () => {
    expect(ddl).toContain("factory_pressing_assignments_active_user_uk");
    expect(ddl).toContain("WHERE unassigned_at IS NULL");
    expect(ddl).toContain("factory_pressing_sessions_active_user_uk");
    expect(ddl).toContain("factory_pressing_sessions_assignment_identity_fk");
    expect(ddl).toContain("factory_pressing_confirmations_session_identity_fk");
  });

  it("stores exact instants and retains correction evidence", () => {
    expect(ddl).toContain("confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now()");
    expect(ddl).toContain("device_captured_at TIMESTAMPTZ");
    expect(ddl).toContain("production_date DATE NOT NULL");
    expect(ddl).toContain("factory_pressing_corrections_immutable_trg");
    expect(ddl).toContain("factory_pressing_confirmations_protect_trg");
    expect(ddl).toContain("correction event must be recorded before voiding");
  });
});

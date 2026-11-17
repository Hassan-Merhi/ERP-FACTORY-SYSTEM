import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import {
  columnDefinition,
  functionDefinition,
  hasTable,
  indexDefinition,
  tableConstraints,
  triggerDefinition,
} from "./helpers/schemaManifest";

// The pressing tables used to be created by startup-schema/037 and an identical
// SQL file; migrations now own them, so the contracts are asserted against the
// schema manifest. The archived SQL that introduced them is kept as history.
const archivedSql = fs.readFileSync(
  path.join(process.cwd(), "migrations/archive/legacy/20261027_001_factory_pressing_machine_tracking.sql"),
  "utf8"
);

describe("pressing machine Phase 1 schema contracts", () => {
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
      expect(hasTable(name), name).toBe(true);
    }
    expect(archivedSql).not.toMatch(
      /(?:INSERT INTO|UPDATE|DELETE FROM)\s+(?:factory_bales|stock_movements|voucher_entries|factory_mix_batches)\b/i
    );
  });

  it("prevents two active pressing confirmations for one bale across all machines and days", () => {
    expect(indexDefinition("factory_pressing_confirmations_one_active_bale_uk")).toBe(
      "CREATE UNIQUE INDEX factory_pressing_confirmations_one_active_bale_uk ON public.factory_pressing_confirmations USING btree (company_id, bale_id) WHERE (voided_at IS NULL)"
    );
    expect(indexDefinition("factory_pressing_confirmations_request_uk")).toContain("(company_id, request_id)");
    expect(tableConstraints("factory_pressing_confirmations")).toContain(
      "FOREIGN KEY (company_id, bale_id) REFERENCES factory_bales(company_id, id) ON DELETE RESTRICT"
    );
  });

  it("enforces one active machine assignment per operator and same-identity sessions", () => {
    expect(indexDefinition("factory_pressing_assignments_active_user_uk")).toContain(
      "(company_id, user_id) WHERE (unassigned_at IS NULL)"
    );
    expect(indexDefinition("factory_pressing_sessions_active_user_uk")).toContain(
      "(company_id, user_id) WHERE (ended_at IS NULL)"
    );
    expect(tableConstraints("factory_pressing_sessions")).toContain(
      "FOREIGN KEY (company_id, assignment_id, machine_id, user_id) REFERENCES factory_pressing_assignments(company_id, id, machine_id, user_id) ON DELETE RESTRICT"
    );
    expect(tableConstraints("factory_pressing_confirmations")).toContain(
      "FOREIGN KEY (company_id, session_id, machine_id, assignment_id, user_id) REFERENCES factory_pressing_sessions(company_id, id, machine_id, assignment_id, user_id) ON DELETE RESTRICT"
    );
  });

  it("stores exact instants and retains correction evidence", () => {
    expect(columnDefinition("factory_pressing_confirmations", "confirmed_at")).toMatchObject({
      type: "timestamp with time zone",
      notNull: true,
      default: "now()",
    });
    expect(columnDefinition("factory_pressing_confirmations", "device_captured_at")?.type).toBe(
      "timestamp with time zone"
    );
    expect(columnDefinition("factory_pressing_confirmations", "production_date")).toMatchObject({
      type: "date",
      notNull: true,
    });
    expect(
      triggerDefinition("factory_pressing_corrections", "factory_pressing_corrections_immutable_trg")
    ).toBeDefined();
    expect(
      triggerDefinition("factory_pressing_confirmations", "factory_pressing_confirmations_protect_trg")
    ).toBeDefined();
    expect(functionDefinition("factory_pressing_confirmations_protect")).toContain(
      "correction event must be recorded before voiding"
    );
  });
});

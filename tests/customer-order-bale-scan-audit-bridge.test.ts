/**
 * Customer-order bale scan audit schema.
 *
 * This used to be installed at boot by server/customerOrderBaleScanAuditBridge.mjs;
 * the columns and triggers are now created only by migrations, so the
 * load-bearing properties are asserted against the schema manifest:
 *
 *   - `scanned_at` exists on the live and archive bale tables;
 *   - **No backfill.** Rows scanned before the feature existed have no
 *     trustworthy scan time: the migrations never write one;
 *   - only authenticated scan/import rows are timestamped, and the archive
 *     copies the live row's scan time.
 * (Boot-time idempotence, lock avoidance and rollback described the deleted
 * bridge and have no equivalent: the server no longer changes the schema.)
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { columnDefinition, functionDefinition, triggerDefinition } from "./helpers/schemaManifest";

describe("customer order bale scan audit schema", () => {
  it("defines the audit columns and triggers on the live and archive bale tables", () => {
    for (const table of ["customer_order_bales", "customer_order_bales_history"]) {
      expect(columnDefinition(table, "scanned_at"), table).toMatchObject({
        type: "timestamp with time zone",
        notNull: false,
        default: null,
      });
    }
    expect(triggerDefinition("customer_order_bales", "customer_order_bales_set_scanned_at")).toBe(
      "CREATE TRIGGER customer_order_bales_set_scanned_at BEFORE INSERT ON public.customer_order_bales FOR EACH ROW EXECUTE FUNCTION set_customer_order_bale_scanned_at()"
    );
    expect(triggerDefinition("customer_order_bales_history", "customer_order_bales_history_copy_scanned_at")).toBe(
      "CREATE TRIGGER customer_order_bales_history_copy_scanned_at BEFORE INSERT ON public.customer_order_bales_history FOR EACH ROW EXECUTE FUNCTION copy_customer_order_bale_scanned_at_to_history()"
    );
  });

  it("never backfills a scan time onto rows that predate the feature", () => {
    const migrationsDir = path.join(process.cwd(), "migrations");
    for (const file of fs.readdirSync(migrationsDir).filter((name) => name.endsWith(".sql"))) {
      const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
      expect(sql, file).not.toMatch(/UPDATE\s+(public\.)?customer_order_bales(_history)?\b[^;]*scanned_at\s*=/i);
    }
    // Both triggers fire only on INSERT, so existing rows keep a NULL scan time.
    expect(triggerDefinition("customer_order_bales", "customer_order_bales_set_scanned_at")).toContain(
      "BEFORE INSERT ON"
    );
  });

  it("timestamps only authenticated scan/import rows and preserves unknown recovery rows", () => {
    const setter = functionDefinition("set_customer_order_bale_scanned_at");
    expect(setter).toContain("NEW.scanned_by IS NOT NULL");
    expect(setter).toContain("btrim(NEW.scanned_by) <> ''");
    expect(setter).toContain("NEW.scanned_at := CURRENT_TIMESTAMP");
    expect(setter).toContain("history_has_scanned_at");
    const copier = functionDefinition("copy_customer_order_bale_scanned_at_to_history");
    expect(copier).toContain("IF NEW.scanned_at IS NULL THEN");
    expect(copier).toContain("WHERE cob.id = NEW.original_id");
  });
});

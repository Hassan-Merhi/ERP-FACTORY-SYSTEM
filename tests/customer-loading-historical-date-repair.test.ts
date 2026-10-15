import { afterEach, describe, expect, it, vi } from "vitest";
import { runApprovedCustomerLoadingDateRepair } from "../server/startup/runApprovedCustomerLoadingDateRepair";

const ENV_NAME = "FACTORY_CUSTOMER_LOADING_DATE_REPAIR_20261015";
const previousValue = process.env[ENV_NAME];

afterEach(() => {
  if (previousValue === undefined) delete process.env[ENV_NAME];
  else process.env[ENV_NAME] = previousValue;
});

describe("one-time historical loading date repair", () => {
  it("never touches the database unless explicitly approved", async () => {
    delete process.env[ENV_NAME];
    const connect = vi.fn();
    await runApprovedCustomerLoadingDateRepair({ connect } as never);
    expect(connect).not.toHaveBeenCalled();
  });

  it("backs up and verifies all 15 dates atomically using first-submission evidence", async () => {
    process.env[ENV_NAME] = "approved-company-12-15-orders";
    const calls: string[] = [];
    const query = vi.fn(async (statement: string) => {
      calls.push(statement);
      if (statement.startsWith("SELECT order_id FROM factory_customer_loading_date_repair_audit")) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes("SELECT o.id") && statement.includes("FOR UPDATE OF o")) {
        return { rowCount: 15, rows: [] };
      }
      if (statement.includes("RETURNING order_id")) return { rowCount: 15, rows: [] };
      if (statement.includes("RETURNING o.id")) return { rowCount: 15, rows: [] };
      if (statement.includes("SELECT count(*)::int AS count")) {
        return { rowCount: 1, rows: [{ count: 15 }] };
      }
      return { rowCount: 0, rows: [] };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };

    await runApprovedCustomerLoadingDateRepair(pool as never);

    const log = calls.join("\n");
    expect(log).toContain("SELECT set_config('app.current_company_id', '12', true)");
    expect(log).toContain("older.created_at, older.id");
    expect(log).toContain("fde.tx_date = p.selected_date");
    expect(log).toContain("old_loading_finalized_at");
    expect(log).toContain("SET loading_finalized_at = a.new_loading_finalized_at");
    expect(log).not.toContain("SET verified_at");
    expect(log).not.toContain("SET finalized_at");
    expect(calls[0]).toBe("BEGIN");
    expect(calls.at(-1)).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back completely if any old date or source entry fails validation", async () => {
    process.env[ENV_NAME] = "approved-company-12-15-orders";
    const calls: string[] = [];
    const query = vi.fn(async (statement: string) => {
      calls.push(statement);
      if (statement.startsWith("SELECT order_id FROM factory_customer_loading_date_repair_audit")) {
        return { rowCount: 0, rows: [] };
      }
      if (statement.includes("SELECT o.id") && statement.includes("FOR UPDATE OF o")) {
        return { rowCount: 14, rows: [] };
      }
      return { rowCount: 0, rows: [] };
    });
    const pool = { connect: vi.fn(async () => ({ query, release: vi.fn() })) };

    await expect(runApprovedCustomerLoadingDateRepair(pool as never)).rejects.toThrow("14/15");
    expect(calls).toContain("ROLLBACK");
    expect(calls.join("\n")).not.toContain("SET loading_finalized_at =");
  });
});

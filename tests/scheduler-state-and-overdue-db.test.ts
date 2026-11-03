/**
 * Scheduler state probes and the overdue-customer query against PostgreSQL,
 * each inside a rolled-back transaction that every pool and drizzle call is
 * routed to. The full daily export itself is replaced by a stub.
 */
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const exportRun = vi.hoisted(() => vi.fn());
vi.mock("../server/services/scheduler/daily-export", () => ({ runDailyExport: () => exportRun() }));

import { logger } from "../server/lib/logger";
import {
  checkAndRecoverDailyExport,
  hasTodayExportSucceeded,
  isTodayExportRunning,
} from "../server/services/scheduler/daily-export-state";
import { loadOverdueCustomerBalances } from "../server/services/scheduler/overdueCustomerQuery";

let seq = 0;

/** A `date` column as YYYY-MM-DD (node-pg returns local-midnight Dates). */
function day(value: string | Date | null): string | null {
  if (!(value instanceof Date)) return value ? String(value).slice(0, 10) : null;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
}

beforeEach(() => {
  exportRun.mockReset().mockResolvedValue(true);
  vi.spyOn(logger, "info").mockImplementation(() => logger);
  vi.spyOn(logger, "error").mockImplementation(() => logger);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function run(client: PoolClient, runType: string, status: string, startedAt = "NOW() - INTERVAL '1 hour'") {
  await client.query(`INSERT INTO daily_export_runs(run_type,status,started_at) VALUES($1,$2,${startedAt})`, [
    runType,
    status,
  ]);
}

async function schedule(client: PoolClient, enabled: boolean, hour: number, tz: string) {
  await client.query(
    `INSERT INTO export_settings(id,schedule_enabled,schedule_hour,schedule_timezone) VALUES(1,$1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET schedule_enabled=$1, schedule_hour=$2, schedule_timezone=$3`,
    [enabled, hour, tz]
  );
}

describe("daily export state probes", () => {
  it("only counts today's scheduled runs", async () => {
    await withRolledBackPool(async (client) => {
      await client.query("DELETE FROM daily_export_runs");
      await run(client, "manual_whatsapp", "success");
      await run(client, "scheduled", "success", "NOW() - INTERVAL '24 hours'");
      await run(client, "scheduled", "failed");
      expect(await hasTodayExportSucceeded()).toBe(false);
      expect(await isTodayExportRunning()).toBe(false);

      await run(client, "scheduled", "partial_failed");
      await run(client, "scheduled", "running");
      expect(await hasTodayExportSucceeded()).toBe(true);
      expect(await isTodayExportRunning()).toBe(true);
    });
  });

  it("reads errors as false", async () => {
    await withRolledBackPool(async (client) => {
      // Hide the table inside a savepoint so the probe's query fails, then undo it.
      await client.query("SAVEPOINT probe");
      await client.query("ALTER TABLE daily_export_runs RENAME TO daily_export_runs_hidden");
      expect(await hasTodayExportSucceeded()).toBe(false);
      await client.query("ROLLBACK TO SAVEPOINT probe");
      await client.query("SAVEPOINT probe");
      await client.query("ALTER TABLE daily_export_runs RENAME TO daily_export_runs_hidden");
      expect(await isTodayExportRunning()).toBe(false);
      await client.query("ROLLBACK TO SAVEPOINT probe");
    });
  });
});

describe("checkAndRecoverDailyExport (state module)", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 16:30 in New York (EDT).
    vi.setSystemTime(new Date("2026-10-20T20:30:00Z"));
  });

  it("reruns a missed export once the scheduled hour has passed", async () => {
    await withRolledBackPool(async (client) => {
      await client.query("DELETE FROM daily_export_runs");
      await schedule(client, true, 16, "America/New_York");
      await checkAndRecoverDailyExport();
      expect(exportRun).toHaveBeenCalledTimes(1);
      expect(logger.info).toHaveBeenCalledWith(
        "[DailyExport] Recovery check: re-running today's failed/missed export..."
      );
    });
  });

  it("skips when disabled, too early, done or still running", async () => {
    await withRolledBackPool(async (client) => {
      await client.query("DELETE FROM daily_export_runs");
      await client.query("DELETE FROM export_settings");
      await checkAndRecoverDailyExport();

      await schedule(client, false, 1, "");
      await checkAndRecoverDailyExport();
      expect(logger.info).toHaveBeenCalledWith("[DailyExport] Recovery check: schedule is disabled — skipping.");

      await schedule(client, true, 18, "");
      await checkAndRecoverDailyExport();
      expect(logger.info).toHaveBeenCalledWith(
        "[DailyExport] Recovery check: current hour (16:xx America/New_York) is before scheduled hour (18:00) — skipping."
      );

      await schedule(client, true, 20, "UTC");
      await run(client, "scheduled", "running");
      await checkAndRecoverDailyExport();
      expect(logger.info).toHaveBeenCalledWith("[DailyExport] Recovery check: export is currently running — skipping.");

      await run(client, "scheduled", "success");
      await checkAndRecoverDailyExport();
      expect(logger.info).toHaveBeenCalledWith(
        "[DailyExport] Recovery check: today's export already succeeded — nothing to do."
      );
      expect(exportRun).not.toHaveBeenCalled();
    });
  });

  it("logs a failed recovery", async () => {
    await withRolledBackPool(async (client) => {
      await client.query("DELETE FROM daily_export_runs");
      await schedule(client, true, 0, "UTC");
      exportRun.mockRejectedValue(new Error("export crashed"));
      await expect(checkAndRecoverDailyExport()).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith("[DailyExport] Recovery check error:", { error: "export crashed" });
    });
  });
});

describe("loadOverdueCustomerBalances", () => {
  it("returns customers with terms who owe money, with their first charge date", async () => {
    await withRolledBackPool(async (client) => {
      const tag = `OVD${process.pid}${++seq}`;
      const companyId = Number(
        (await client.query("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [tag, tag])).rows[0].id
      );
      const customer = async (
        code: string,
        terms: number | null,
        extra: { active?: boolean; opening?: number; side?: string | null } = {}
      ) =>
        Number(
          (
            await client.query(
              `INSERT INTO customers(company_id,code,legal_name,payment_terms_days,active,opening_balance,opening_balance_side)
               VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
              [
                companyId,
                `${tag}-${code}`,
                `${code} Ltd`,
                terms,
                extra.active ?? true,
                extra.opening ?? 0,
                extra.side ?? null,
              ]
            )
          ).rows[0].id
        );
      const line = async (
        customerId: number,
        date: string,
        debit: number,
        credit: number,
        voucher: { optional?: boolean } = {}
      ) => {
        const voucherId = Number(
          (
            await client.query(
              `INSERT INTO vouchers(company_id,voucher_number,voucher_type,voucher_date,total_amount,currency,optional)
               VALUES($1,$2,'Journal',$3,0,'USD',$4) RETURNING id`,
              [companyId, `${tag}-V${++seq}`, date, voucher.optional ?? false]
            )
          ).rows[0].id
        );
        await client.query(
          `INSERT INTO voucher_entries(voucher_id,company_id,customer_id,debit_amount,credit_amount,base_debit_amount,base_credit_amount)
           VALUES($1,$2,$3,$4,$5,$4,$5)`,
          [voucherId, companyId, customerId, debit, credit]
        );
      };
      const cached = (customerId: number, date: string, debit: number) =>
        client.query(
          `INSERT INTO customer_balances(company_id,customer_id,transaction_date,transaction_type,debit_amount,credit_amount,balance)
           VALUES($1,$2,$3,'invoice',$4,0,$4)`,
          [companyId, customerId, date, debit]
        );

      const owing = await customer("Owing", 30);
      await line(owing, "2026-02-01", 100, 0);
      await line(owing, "2026-01-10", 20, 0, { optional: true });
      await line(owing, "2026-03-01", 0, 30);
      // An earlier prepayment is not a charge.
      await line(owing, "2026-01-15", 0, 10);
      await cached(owing, "2026-02-15", 100);

      const settled = await customer("Settled", 15);
      await line(settled, "2026-01-05", 50, 0);
      await line(settled, "2026-01-20", 0, 50);

      const opening = await customer("Opening", 10, { opening: 40 });
      await cached(opening, "2026-01-03", 40);

      const credit = await customer("Credit", 10, { opening: 20, side: "Cr" });
      const noTerms = await customer("NoTerms", null);
      await line(noTerms, "2026-01-01", 10, 0);
      const inactive = await customer("Inactive", 10, { active: false });
      await line(inactive, "2026-01-01", 10, 0);

      const rows = (await loadOverdueCustomerBalances()).filter((row) => row.company_id === companyId);
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect([...byId.keys()].sort()).toEqual([owing, opening].sort());
      expect(byId.get(owing)).toMatchObject({
        legal_name: "Owing Ltd",
        payment_terms_days: 30,
        net_balance: "60.00",
      });
      // The optional January voucher does not count; the posted February one does.
      expect(day(byId.get(owing)!.earliest_invoice_date)).toBe("2026-02-01");
      expect(byId.get(opening)).toMatchObject({ net_balance: "40.00" });
      expect(day(byId.get(opening)!.earliest_invoice_date)).toBe("2026-01-03");
      expect(byId.has(settled)).toBe(false);
      expect(byId.has(credit)).toBe(false);
    });
  });
});

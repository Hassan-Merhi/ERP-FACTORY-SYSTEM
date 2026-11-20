/**
 * The automatic FX revaluation guard used by assertVoucherEditableTx reads
 * under the voucher's own company scope and then restores the transaction's:
 * an intercompany edit that checks its counterpart in another company must
 * not leave the rest of the edit running under that company.
 */
import { afterAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/node-postgres";
import { pool, type DbTransaction } from "../server/db";
import { isAutomaticFxRevaluationVoucherInOwnScopeTx } from "../server/services/accounting/automaticFxVoucherGuard";

afterAll(async () => {
  await pool.end().catch(() => undefined);
});

describe("automatic FX guard company scope", () => {
  it("restores the transaction's company scope after checking another company's voucher", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.current_company_id', '41', true)");
      const tx = drizzle(client) as unknown as DbTransaction;
      expect(await isAutomaticFxRevaluationVoucherInOwnScopeTx(tx, 42, 987654321)).toBe(false);
      const after = await client.query("SELECT current_setting('app.current_company_id', true) AS value");
      expect(after.rows[0].value).toBe("41");
    } finally {
      await client.query("ROLLBACK");
      client.release();
    }
  });
});

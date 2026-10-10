/**
 * Rental auto-transfers write the receiving side in another company. Under
 * row-level security a request is pinned to its own company, so the receiving
 * company's clearing account was invisible, the fallback insert hit the existing
 * row, and every transfer after the policies tightened failed silently. This
 * runs the transfer as a non-superuser role with RLS forced, the way production
 * does, inside a request scoped to the paying company.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const databaseUrl = process.env.DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;
const roleName = "rental_auto_transfer_rls_probe";
const rolePassword = "rental-auto-transfer-probe";
const PREFIX = "ratscope";

describeDatabase("rental auto-transfer under company-scope RLS", () => {
  let admin: Client;
  let companyA: number;
  let companyB: number;
  let outsiderCompany: number;
  let userId: string;
  let cashAccountA: number;
  let receivingAccountB: number;

  type Modules = {
    maybeRunAutoTransfer: typeof import("../server/routes/rental/shared/auto-transfer").maybeRunAutoTransfer;
    reverseAutoTransfersTx: typeof import("../server/routes/rental/shared/auto-transfer").reverseAutoTransfersTx;
    runWithAutoTransferCounterparties: typeof import("../server/services/rental/autoTransferScope").runWithAutoTransferCounterparties;
    db: typeof import("../server/db").db;
    pool: typeof import("../server/db").pool;
    inRequest: <T>(companyId: number, run: () => Promise<T>) => Promise<T>;
  };
  let mods: Modules;

  async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
    const result = await admin.query(sql, params);
    return result.rows[0] as T;
  }

  beforeAll(async () => {
    admin = new Client({ connectionString: databaseUrl });
    await admin.connect();
    const migration = await readFile(
      path.join(process.cwd(), "migrations/0016_company_scope_rls_readiness.sql"),
      "utf8"
    );
    await admin.query(migration);

    await admin.query(`DROP OWNED BY ${roleName}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${roleName}`);
    await admin.query(
      `CREATE ROLE ${roleName} LOGIN PASSWORD '${rolePassword}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS`
    );
    await admin.query(`GRANT USAGE ON SCHEMA public TO ${roleName}`);
    await admin.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${roleName}`);
    await admin.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${roleName}`);

    const company = async (suffix: string) =>
      (
        await scalar<{ id: number }>(`INSERT INTO companies (code, name) VALUES ($1, $2) RETURNING id`, [
          `${PREFIX}${suffix}`.toUpperCase().slice(0, 12),
          `${PREFIX} company ${suffix}`,
        ])
      ).id;
    companyA = await company("a");
    companyB = await company("b");
    outsiderCompany = await company("x");

    userId = (
      await scalar<{ id: string }>(`INSERT INTO users (username, password) VALUES ($1, 'x') RETURNING id`, [
        `${PREFIX}_user_${Date.now()}`,
      ])
    ).id;
    for (const companyId of [companyA, companyB]) {
      await admin.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [
        userId,
        companyId,
      ]);
    }

    const account = async (companyId: number, code: string, type: string) =>
      (
        await scalar<{ id: number }>(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES ($1, $2, $3, $4) RETURNING id`,
          [companyId, code, code, type]
        )
      ).id;
    cashAccountA = await account(companyA, `${PREFIX}-CASH`, "Cash");
    receivingAccountB = await account(companyB, `${PREFIX}-RECV`, "Cash");
    // Both companies already own a clearing account: the old code could not see
    // B's from A's scope and tried to insert a duplicate.
    await account(companyA, "TRANSFER-CLEARING", "Equity");
    await account(companyB, "TRANSFER-CLEARING", "Equity");

    await admin.query(
      `INSERT INTO rental_auto_transfer_configs (company_id, module, dest_company_id, dest_ledger_account_id, enabled)
       VALUES ($1, 'PROPERTIES', $2, $3, true)`,
      [companyA, companyB, receivingAccountB]
    );

    // Load the application against the RLS-bound role, as production runs.
    const url = new URL(databaseUrl!);
    url.username = roleName;
    url.password = rolePassword;
    process.env.DATABASE_URL = url.toString();
    vi.resetModules();
    const transfer = await import("../server/routes/rental/shared/auto-transfer");
    const scope = await import("../server/services/rental/autoTransferScope");
    const dbModule = await import("../server/db");
    const requestContext = await import("../server/services/security/companyRequestRuntimeContext");
    const databaseScope = await import("../server/services/security/databaseScopeRuntimeContext");
    mods = {
      maybeRunAutoTransfer: transfer.maybeRunAutoTransfer,
      reverseAutoTransfersTx: transfer.reverseAutoTransfersTx,
      runWithAutoTransferCounterparties: scope.runWithAutoTransferCounterparties,
      db: dbModule.db,
      pool: dbModule.pool,
      inRequest: (companyId, run) =>
        requestContext.runWithCompanyRequestRuntimeContext(
          { userId, companyId, role: "Admin", method: "POST", path: "/test", developerBypass: false },
          () =>
            databaseScope.runWithDatabaseScopeRuntimeContext(
              databaseScope.createTenantDatabaseScope(companyId, [], "active-company"),
              run
            )
        ),
    };
  }, 60_000);

  afterAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    await mods?.pool.end().catch(() => {});
    if (!admin) return;
    const ids = [companyA, companyB, outsiderCompany].filter(Boolean);
    await admin.query(`DELETE FROM inter_company_transfers WHERE from_company_id = ANY($1)`, [ids]);
    await admin.query(
      `DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = ANY($1))`,
      [ids]
    );
    await admin.query(`DELETE FROM vouchers WHERE company_id = ANY($1)`, [ids]);
    await admin.query(`DELETE FROM rental_auto_transfer_configs WHERE company_id = ANY($1)`, [ids]);
    await admin.query(`DELETE FROM ledger_accounts WHERE company_id = ANY($1)`, [ids]);
    await admin.query(`DELETE FROM user_company_roles WHERE company_id = ANY($1)`, [ids]);
    await admin.query(`DELETE FROM users WHERE id = $1`, [userId]);
    await admin.query(`DELETE FROM companies WHERE id = ANY($1)`, [ids]);
    await admin.query(`DROP OWNED BY ${roleName}`).catch(() => {});
    await admin.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => {});
    await admin.end();
  }, 60_000);

  async function transferRows(paymentId: number) {
    const result = await admin.query(
      `SELECT t.id, t.to_voucher_id, t.from_voucher_id,
              tv.company_id AS to_company, tv.deleted_at AS to_deleted, fv.deleted_at AS from_deleted,
              (SELECT string_agg(ve.ledger_account_id || ':' || ve.debit_amount || '/' || ve.credit_amount, ' ' ORDER BY ve.id)
                 FROM voucher_entries ve WHERE ve.voucher_id = t.to_voucher_id) AS to_lines
         FROM inter_company_transfers t
         JOIN vouchers tv ON tv.id = t.to_voucher_id
         JOIN vouchers fv ON fv.id = t.from_voucher_id
        WHERE t.source_payment_id = $1`,
      [paymentId]
    );
    return result.rows;
  }

  it("posts the receiving side in the destination company, once per payment", async () => {
    const paymentId = 900_000_001;
    await mods.inRequest(companyA, () =>
      mods.maybeRunAutoTransfer(companyA, "PROPERTIES", cashAccountA, "1250.00", "2026-10-02", "Unit 7", paymentId)
    );
    // A repeated call for the same payment posts nothing more.
    await mods.inRequest(companyA, () =>
      mods.maybeRunAutoTransfer(companyA, "PROPERTIES", cashAccountA, "1250.00", "2026-10-02", "Unit 7", paymentId)
    );

    const rows = await transferRows(paymentId);
    expect(rows).toHaveLength(1);
    expect(rows[0].to_company).toBe(companyB);
    expect(rows[0].to_lines).toContain(`${receivingAccountB}:1250.00/0.00`);
  });

  it("reverses both sides, including the receiving company's voucher", async () => {
    const paymentId = 900_000_002;
    await mods.inRequest(companyA, () =>
      mods.maybeRunAutoTransfer(companyA, "PROPERTIES", cashAccountA, "300.00", "2026-10-03", "Unit 8", paymentId)
    );
    const [posted] = await transferRows(paymentId);
    expect(posted).toBeDefined();

    await mods.inRequest(companyA, () =>
      mods.runWithAutoTransferCounterparties([companyB], () =>
        mods.db.transaction((tx) => mods.reverseAutoTransfersTx(tx, [paymentId]))
      )
    );

    const vouchers = await admin.query(`SELECT id, deleted_at FROM vouchers WHERE id = ANY($1)`, [
      [posted.from_voucher_id, posted.to_voucher_id],
    ]);
    expect(vouchers.rows).toHaveLength(2);
    for (const voucher of vouchers.rows) expect(voucher.deleted_at).not.toBeNull();
    expect(await transferRows(paymentId)).toHaveLength(0);
  });

  it("refuses to widen the scope to a company the user does not belong to", async () => {
    await expect(
      mods.inRequest(companyA, () => mods.runWithAutoTransferCounterparties([outsiderCompany], async () => "ran"))
    ).rejects.toThrow(/No access to transfer company/);
  });
});

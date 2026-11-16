/**
 * SQL injection regression tests for the sites remediated by the raw SQL audit
 * (docs/security/raw-sql-audit.md). Two layers:
 *
 *  - rendering: the remediated builders must put hostile input into bound
 *    parameters (or reject it) — never into the SQL text;
 *  - database (only with DATABASE_URL, i.e. the disposable CI/test database):
 *    hostile payloads executed through the same patterns cannot read or modify
 *    another company's rows, cannot run a second statement, and the guarded
 *    production helpers reject them before any SQL is sent.
 *
 * Nothing here runs against production; the database layer creates and drops
 * its own temporary tables.
 */
import { sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { assertBindPlaceholder, assertSqlAlias, assertSqlColumnRef, ownKey } from "../server/lib/sqlTextGuards";
import { reversalPairSql } from "../server/routes/costCenterReportingRoutes";
import {
  customerOwnedLinePredicate,
  liveVoucherPredicate,
  noNonCustomerTarget,
} from "../server/services/accounting/balances/partyLineRules";
import { buildPaginationIntegrityConditions } from "../server/services/factory/daybookSourceIntegrity";
import { stockItemHistorySqlText } from "../server/services/inventory/stockItemHistory";
import { consolidatedHadiRentLedgerPredicate } from "../server/services/rental/hadiRentExpenseConsolidation";
import { countAccountLines, lockAccountRow } from "../server/services/accounting/accountHistoryPolicy";
import { assertExportDate, invalidExportDateRange } from "../server/services/export-excel/workbook";
import { netPositionLegacyScanKnown } from "../server/services/factory/netPositionAsOf";
import {
  applyFactoryBilingualSnapshotBackfillForScope,
  buildFactoryBilingualSnapshotPlan,
  propagateFactoryArabicCatalogChange,
} from "../server/services/factoryBilingualSnapshotService";

const dialect = new PgDialect();
const render = (fragment: SQL) => dialect.sqlToQuery(fragment);

const PAYLOADS = [
  "' OR '1'='1",
  "1; DROP TABLE customers; --",
  "company_id DESC; DELETE FROM vouchers; --",
  '"; DROP TABLE vouchers; --',
  "1 /* comment */ OR 1=1",
  "1 -- trailing comment",
  "ʼ OR ʼ1ʼ=ʼ1", // Unicode modifier apostrophes
  "1\u0000; SELECT pg_sleep(1)",
  "x' UNION SELECT password FROM users --",
];

/** Executor double that records the SQL it is asked to run. */
function recordingExecutor() {
  const seen: SQL[] = [];
  const executor = {
    execute: async (query: SQL) => {
      seen.push(query);
      return { rows: [{ live: 0, any: 0, id: 1 }] };
    },
  };
  return { seen, executor: executor as unknown as Parameters<typeof lockAccountRow>[0] };
}

describe("remediated SQL builders keep hostile input out of SQL text", () => {
  it("export date range: rejects every injection payload, malformed and impossible dates", () => {
    for (const payload of [
      ...PAYLOADS,
      "2024-13-01",
      "2024-02-30",
      "24-01-01",
      "2024-01-01T00:00:00",
      " 2024-01-01",
      "",
    ]) {
      if (payload === "") {
        expect(invalidExportDateRange(payload, undefined)).toBeNull(); // empty = no filter
        continue;
      }
      expect(() => assertExportDate(payload, "fromDate")).toThrow(/Invalid fromDate/);
      expect(invalidExportDateRange(payload, "2024-01-31")).toMatch(/Invalid fromDate/);
      expect(invalidExportDateRange("2024-01-01", payload)).toMatch(/Invalid toDate/);
    }
    expect(invalidExportDateRange("2024-01-01", "2024-01-31")).toBeNull();
    expect(invalidExportDateRange(undefined, null)).toBeNull();
    expect(invalidExportDateRange(20240101, undefined)).toMatch(/Invalid fromDate/); // numeric coercion
  });

  it("account history: untrusted column names and non-integer ids are rejected before SQL", async () => {
    const { seen, executor } = recordingExecutor();
    for (const payload of PAYLOADS) {
      await expect(countAccountLines(executor, [[payload as "ledger_account_id", 1]])).rejects.toThrow(
        "account_history_invalid_target"
      );
      await expect(lockAccountRow(executor, payload, 1)).rejects.toThrow("account_history_invalid_lock");
    }
    for (const badId of [Number.NaN, 1.5, Number.MAX_SAFE_INTEGER + 2, Infinity]) {
      await expect(countAccountLines(executor, [["ledger_account_id", badId]])).rejects.toThrow(
        "account_history_invalid_target"
      );
      await expect(lockAccountRow(executor, "customers", badId)).rejects.toThrow("account_history_invalid_lock");
    }
    expect(seen).toHaveLength(0);
  });

  it("account history: allowlisted column / table render as quoted identifiers with bound ids", async () => {
    const { seen, executor } = recordingExecutor();
    await countAccountLines(executor, [
      ["ledger_account_id", 7],
      ["customer_id", -3],
    ]);
    await lockAccountRow(executor, "customers", 9);
    const [count, lock] = seen.map(render);
    expect(count.sql).toContain('ve."ledger_account_id" = $1');
    expect(count.sql).toContain('ve."customer_id" = $2');
    expect(count.params).toEqual([7, -3]);
    expect(lock.sql).toContain('FROM "customers" WHERE id = $1');
    expect(lock.params).toEqual([9]);
  });

  it("sql.identifier escapes embedded quotes so a hostile alias stays one identifier", () => {
    const scope = { mode: "asOf", asOf: new Date("2024-01-01T00:00:00Z") } as unknown as Parameters<
      typeof netPositionLegacyScanKnown
    >[3];
    const q = render(netPositionLegacyScanKnown('cob" OR 1=1 --', "o", 4, scope));
    expect(q.sql).toContain('"cob"" OR 1=1 --"');
    expect(q.sql).not.toMatch(/[^"]cob" OR 1=1/);
    expect(q.params).toContain(4);
  });

  it("SQL-text helpers refuse untrusted aliases, column references and placeholders", () => {
    for (const payload of [...PAYLOADS, "V", "v.id", "", "1v", "v--", 'v"']) {
      expect(() => assertSqlAlias(payload)).toThrow(/unsafe/);
      expect(() => liveVoucherPredicate(payload, "$1")).toThrow(/unsafe/);
      expect(() => noNonCustomerTarget(payload)).toThrow(/unsafe/);
      expect(() => customerOwnedLinePredicate(payload, "$1", "$2")).toThrow(/unsafe/);
      expect(() => reversalPairSql(payload)).toThrow(/unsafe/);
      expect(() => assertBindPlaceholder(payload)).toThrow(/unsafe/);
      expect(() => buildPaginationIntegrityConditions(payload)).toThrow(/unsafe/);
      expect(() => consolidatedHadiRentLedgerPredicate("ve.ledger_account_id", payload, 1, 1)).toThrow(/unsafe/);
    }
    for (const payload of PAYLOADS) {
      expect(() => assertSqlColumnRef(payload)).toThrow(/unsafe/);
      expect(() => stockItemHistorySqlText([], payload)).toThrow(/unsafe/);
      expect(() => consolidatedHadiRentLedgerPredicate(payload, "$1", 1, 1)).toThrow(/unsafe/);
    }
    // The legitimate call shapes keep working.
    expect(liveVoucherPredicate("v", "$1")).toBe("v.company_id = $1 AND v.optional = false AND v.deleted_at IS NULL");
    expect(noNonCustomerTarget('"voucher_entries"')).toContain('"voucher_entries".supplier_id IS NULL');
    expect(reversalPairSql("v")).toContain("v.reversal_of_voucher_id IS NOT NULL");
    expect(consolidatedHadiRentLedgerPredicate("ve.ledger_account_id", "$1", 1, 1)).toBe("ve.ledger_account_id = $1");
    expect(stockItemHistorySqlText([], "si.id")).toContain("inv.stock_item_id = si.id");
    expect(buildPaginationIntegrityConditions("$1").length).toBeGreaterThan(0);
  });

  it("code-owned lookup maps ignore prototype keys", () => {
    const columns = { name: "legal_name" };
    for (const key of ["constructor", "__proto__", "toString", "hasOwnProperty", 1, null])
      expect(ownKey(columns, key)).toBe(false);
    expect(ownKey(columns, "name")).toBe(true);
  });

  it("bound ID lists (sql.join) carry each id as a separate parameter, including huge and negative ids", () => {
    const ids = [1, -1, Number.MAX_SAFE_INTEGER];
    const q = render(
      sql`SELECT id FROM t WHERE id IN (${sql.join(
        ids.map((id) => sql`${id}`),
        sql`, `
      )})`
    );
    expect(q.sql).toBe("SELECT id FROM t WHERE id IN ($1, $2, $3)");
    expect(q.params).toEqual(ids);
    const hostile = render(
      sql`SELECT id FROM t WHERE id IN (${sql.join(
        PAYLOADS.map((p) => sql`${p}`),
        sql`, `
      )})`
    );
    for (const p of PAYLOADS) expect(hostile.sql).not.toContain(p);
    expect(hostile.params).toEqual(PAYLOADS);
  });
});

const hasDatabase = Boolean(process.env.DATABASE_URL);
const databaseDescribe = hasDatabase ? describe : describe.skip;

databaseDescribe("SQL injection and tenant isolation against a disposable database", () => {
  const suffix = `${process.pid}_${Date.now() % 100000}`;
  const parties = `sqli_parties_${suffix}`;
  const ledger = `sqli_ledger_${suffix}`;
  const ALLOWED_TABLES = new Set([parties, ledger]);
  const SORTS = { name: "name", newest: "created_at" } as const;

  beforeAll(async () => {
    await pool.query(`CREATE TABLE ${parties} (id serial PRIMARY KEY, company_id int NOT NULL, name text NOT NULL,
      created_at date NOT NULL DEFAULT CURRENT_DATE, deleted_at timestamptz)`);
    await pool.query(
      `CREATE TABLE ${ledger} (id serial PRIMARY KEY, company_id int NOT NULL, amount numeric(20,2) NOT NULL)`
    );
    await pool.query(
      `INSERT INTO ${parties} (company_id, name, created_at, deleted_at) VALUES
        (1, 'Alpha', '2024-01-05', NULL), (1, 'Beta', '2024-02-05', NULL),
        (2, 'Other company secret', '2024-01-10', NULL), (1, 'Deleted', '2024-01-06', now()),
        (1, $1, '2024-03-01', NULL)`,
      ["' OR '1'='1"] // stored payload for second-order checks
    );
    await pool.query(`INSERT INTO ${ledger} (company_id, amount) VALUES (1, 100), (2, 999)`);
  });

  afterAll(async () => {
    await pool.query(`DROP TABLE IF EXISTS ${parties}`);
    await pool.query(`DROP TABLE IF EXISTS ${ledger}`);
  });

  /** Drizzle wraps driver errors ("Failed query: ..."); the PostgreSQL reason is on `cause`. */
  async function dbError(promise: Promise<unknown>): Promise<string> {
    const error = (await promise.then(
      () => null,
      (e: unknown) => e
    )) as { message?: string; cause?: { message?: string } } | null;
    expect(error).not.toBeNull();
    return `${error?.message ?? ""} ${error?.cause?.message ?? ""}`;
  }
  // PostgreSQL rejects a NUL byte in text values outright (encoding error), which is
  // itself a value-level rejection; it is covered separately below.
  const DB_PAYLOADS = PAYLOADS.filter((p) => !p.includes("\u0000"));

  /** The remediated pattern: allowlisted identifier, fixed sort map, bound values. */
  async function listParties(
    companyId: number,
    input: { table: string; search: string; sort: string; from: string; ids?: unknown[] }
  ) {
    if (!ALLOWED_TABLES.has(input.table)) throw new Error("Invalid table");
    if (!Number.isSafeInteger(companyId) || companyId <= 0) throw new Error("Invalid company");
    const sort = SORTS[input.sort as keyof typeof SORTS] ?? SORTS.name;
    const ids = (input.ids ?? []).filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id));
    const idFilter = ids.length
      ? sql`AND id IN (${sql.join(
          ids.map((id) => sql`${id}`),
          sql`, `
        )})`
      : sql``;
    const result = await db.execute<{ id: number; company_id: number; name: string }>(sql`
      SELECT id, company_id, name FROM ${sql.identifier(input.table)}
       WHERE company_id = ${companyId} AND deleted_at IS NULL
         AND name ILIKE ${"%" + input.search + "%"} AND created_at >= ${input.from}::date ${idFilter}
       ORDER BY ${sql.identifier(sort)}, id`);
    return result.rows;
  }

  it("hostile search terms, sort keys and id lists cannot reach other companies or deleted rows", async () => {
    for (const payload of DB_PAYLOADS) {
      const rows = await listParties(1, {
        table: parties,
        search: payload,
        sort: payload,
        from: "2024-01-01",
        ids: [payload, 1, 2, 3],
      });
      for (const row of rows) {
        expect(row.company_id).toBe(1);
        expect(row.name).not.toBe("Other company secret");
        expect(row.name).not.toBe("Deleted");
      }
    }
    const nul = await dbError(
      listParties(1, { table: parties, search: "1\u0000; SELECT pg_sleep(1)", sort: "name", from: "2024-01-01" })
    );
    expect(nul).toMatch(/invalid byte sequence|0x00/);
    // The literal search "' OR '1'='1" matches only the row that literally stores it.
    const literal = await listParties(1, { table: parties, search: "' OR '1'='1", sort: "name", from: "2024-01-01" });
    expect(literal.map((r) => r.name)).toEqual(["' OR '1'='1"]);
  });

  it("untrusted table names are refused and malformed dates fail as values, not as SQL", async () => {
    await expect(
      listParties(1, { table: `${parties}; DROP TABLE ${ledger}`, search: "", sort: "name", from: "2024-01-01" })
    ).rejects.toThrow("Invalid table");
    await expect(listParties(1, { table: "users", search: "", sort: "name", from: "2024-01-01" })).rejects.toThrow(
      "Invalid table"
    );
    expect(
      await dbError(listParties(1, { table: parties, search: "", sort: "name", from: "2024-01-01'; DROP TABLE x; --" }))
    ).toMatch(/invalid input syntax for type date/);
    await expect(
      listParties(Number("1 OR 1=1"), { table: parties, search: "", sort: "name", from: "2024-01-01" })
    ).rejects.toThrow("Invalid company");
    const tables = await pool.query("SELECT to_regclass($1) AS t", [ledger]);
    expect(tables.rows[0].t).toBe(ledger);
  });

  it("second-order: a stored payload re-used in a later query stays a value", async () => {
    const stored = await pool.query<{ name: string }>(
      `SELECT name FROM ${parties} WHERE name LIKE '%OR%' AND company_id = 1`
    );
    const name = stored.rows[0].name;
    const reused = await db.execute<{ n: string }>(
      sql`SELECT count(*)::text AS n FROM ${sql.identifier(parties)} WHERE name = ${name}`
    );
    expect(reused.rows[0].n).toBe("1");
  });

  it("stacked statements in a bound value cannot modify another company's ledger", async () => {
    const payload = `0; UPDATE ${ledger} SET amount = 0 WHERE company_id = 2; --`;
    expect(
      await dbError(
        db.execute(sql`UPDATE ${sql.identifier(ledger)} SET amount = amount WHERE company_id = 1 AND id = ${payload}`)
      )
    ).toMatch(/invalid input syntax for type integer/);
    const other = await pool.query<{ amount: string }>(`SELECT amount::text FROM ${ledger} WHERE company_id = 2`);
    expect(other.rows[0].amount).toBe("999.00");
  });

  it("factory bilingual snapshot SQL runs with bound company/product/scope ids and refuses bad ids", async () => {
    const plan = await buildFactoryBilingualSnapshotPlan(987654321);
    expect(plan.targets.length).toBeGreaterThan(0); // the schema probe found the target tables and every query executed
    expect(plan.totals).toEqual({ missing: 0, resolvable: 0, orphaned: 0, finalized: 0 });
    const scoped = await applyFactoryBilingualSnapshotBackfillForScope(987654321, { orderId: 1, baleId: 2 });
    expect(scoped.updated).toBe(0);
    const propagated = await propagateFactoryArabicCatalogChange(987654321, 5);
    expect(propagated.updated).toBe(0);
    await expect(buildFactoryBilingualSnapshotPlan(Number("1 OR 1=1"))).rejects.toThrow(/Invalid companyId/);
    await expect(propagateFactoryArabicCatalogChange(1, 1.5)).rejects.toThrow(/Invalid productId/);
  });

  it("the guarded account-history helpers reject payloads against the real database", async () => {
    await expect(lockAccountRow(db, `customers WHERE 1=1; DROP TABLE ${ledger}; --`, 1)).rejects.toThrow(
      "account_history_invalid_lock"
    );
    await expect(countAccountLines(db, [["ledger_account_id", Number("1 OR 1=1")]])).rejects.toThrow(
      "account_history_invalid_target"
    );
    const counts = await countAccountLines(db, [["ledger_account_id", -987654]]);
    expect(counts).toEqual({ live: 0, any: 0 });
  });
});

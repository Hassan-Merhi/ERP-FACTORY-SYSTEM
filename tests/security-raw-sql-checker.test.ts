/**
 * The raw SQL review gate (npm run check:raw-sql) must reject new, changed,
 * stale and badly justified raw SQL. These tests exercise the scanner and the
 * allowlist validator directly and the CLI end to end against a throwaway tree.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// @ts-expect-error -- plain .mjs module without type declarations
import { scanSource } from "../scripts/lib/raw-sql-scanner.mjs";
// @ts-expect-error -- plain .mjs module without type declarations
import { validateAllowlist, SCAN_ROOTS } from "../scripts/lib/raw-sql-allowlist.mjs";

type Finding = {
  id: string;
  path: string;
  line: number;
  kind: string;
  context: string;
  dynamicParts: string[];
  autoVerified: string | null;
};

const scan = (source: string, path = "server/example.ts"): Finding[] => scanSource(path, source);
const unproven = (source: string) => scan(source).filter((f) => !f.autoVerified);

function entryFor(f: Finding, overrides: Record<string, unknown> = {}) {
  return {
    id: f.id,
    path: f.path,
    kind: f.kind,
    context: f.context,
    classification: "allowlisted-identifier",
    userControlled: "no",
    dynamicInputs: f.dynamicParts.map((expression) => ({
      expression,
      source: "code-owned constant table list at server/example.ts:1",
      validation: "membership test against the fixed TABLES set before use",
    })),
    reason: "The table name is selected from a fixed, code-owned set and cannot carry SQL syntax from a request.",
    ...overrides,
  };
}

describe("raw SQL scanner — detection", () => {
  it("flags sql.raw of a dynamic value and records the dynamic expression", () => {
    const [f] = unproven(`import { sql } from "drizzle-orm"; export const q = (t: string) => sql.raw(t);`);
    expect(f.kind).toBe("sql.raw");
    expect(f.dynamicParts).toEqual(["t"]);
  });

  it("flags a renamed drizzle sql import", () => {
    const found = unproven(
      `import { sql as d } from "drizzle-orm"; export const q = (t: string) => d.raw("SELECT " + t);`
    );
    expect(found.map((f) => f.kind)).toEqual(["sql.raw"]);
  });

  it("flags interpolated pool.query / client.query text", () => {
    const found = unproven(
      "export async function f(pool: any, req: any) { return pool.query(`SELECT * FROM users WHERE id = ${req.query.id}`); }"
    );
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ kind: "query-text", dynamicParts: ["req.query.id"] });
  });

  it("flags concatenated SQL passed to a sink", () => {
    const found = unproven(
      `export function f(client: any, table: string) { return client.query("SELECT * FROM " + table); }`
    );
    expect(found).toHaveLength(1);
    expect(found[0].dynamicParts).toEqual(["table"]);
  });

  it("flags SQL text assembled in a variable and executed later", () => {
    const found = unproven(`import { sql } from "drizzle-orm";
      export async function f(db: any, table: string, id: string) {
        const query = \`DELETE FROM \${table} WHERE id = \${id}\`;
        await db.execute(sql.raw(query));
      }`);
    expect(found.length).toBeGreaterThanOrEqual(1);
    expect(found.flatMap((f) => f.dynamicParts)).toEqual(expect.arrayContaining(["table", "id"]));
  });

  it("flags query wrappers that execute a caller-supplied string", () => {
    const found = unproven(`export async function run(pool: any, statement: string) { return pool.query(statement); }`);
    expect(found).toHaveLength(1);
    expect(found[0].kind).toBe("indirect-query-text");
  });

  it("flags SQL assembled through .replace, array join and quoted literals", () => {
    expect(unproven(`export const f = (t: string) => "SELECT * FROM {T} WHERE x = 1".replace("{T}", t);`)).toHaveLength(
      1
    );
    expect(unproven(`export const f = (w: string) => ["SELECT id FROM t WHERE", w].join(" ");`)).toHaveLength(1);
    expect(unproven("export const f = (d: string) => `AND created_at >= '${d}'`;")).toHaveLength(1);
  });

  it("flags dynamic and malformed sql.identifier", () => {
    const found = unproven(`import { sql } from "drizzle-orm";
      export const a = (t: string) => sql.identifier(t);
      export const b = (c: string) => sql.identifier("ve", c);`);
    expect(found.map((f) => f.kind)).toEqual(["dynamic-identifier", "dynamic-identifier"]);
  });

  it("flags PL/pgSQL EXECUTE with %s or concatenation but not %I-only format()", () => {
    const sqlFile = `DO $$ BEGIN
      EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
      EXECUTE format('SELECT * FROM x WHERE %s', cond);
      EXECUTE 'DROP TABLE ' || t;
    END $$;`;
    const found = scanSource("migrations/x.sql", sqlFile) as Finding[];
    expect(found.filter((f) => !f.autoVerified)).toHaveLength(2);
    expect(found.filter((f) => f.autoVerified)).toHaveLength(1);
  });

  it("does not treat a tagged sql`` template value as raw text", () => {
    const found = scan(`import { sql } from "drizzle-orm";
      export const f = (db: any, id: string) => db.execute(sql\`SELECT * FROM users WHERE id = \${id}\`);`);
    expect(found).toHaveLength(0);
  });
});

describe("raw SQL scanner — mechanical proofs", () => {
  it("proves literals, const maps and fixed-set loops static", () => {
    const found = scan(`import { sql } from "drizzle-orm";
      const TABLES = ["customers", "suppliers"] as const;
      const COLUMNS = { name: "legal_name", code: "code" } as const;
      export async function f(pool: any, key: keyof typeof COLUMNS) {
        for (const table of TABLES) await pool.query(\`SELECT \${COLUMNS[key]} FROM \${table} WHERE id = $1\`, [1]);
        return sql.raw("SELECT 1");
      }`);
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((f) => f.autoVerified)).toBe(true);
  });

  it("does not prove a const map that is written to", () => {
    const found = unproven(`const COLUMNS: Record<string, string> = { name: "legal_name" };
      export function f(pool: any, k: string, v: string) { COLUMNS[k] = v; return pool.query(\`SELECT \${COLUMNS[k]} FROM t\`); }`);
    expect(found).toHaveLength(1);
  });

  it("proves numeric coercions but not raw strings", () => {
    expect(
      unproven("export const f = (pool: any, id: string) => pool.query(`SELECT * FROM t WHERE id = ${Number(id)}`);")
    ).toHaveLength(0);
    expect(
      unproven("export const f = (pool: any, n: string) => pool.query(`SELECT * FROM t LIMIT ${n}`);")
    ).toHaveLength(1);
  });

  it("does not trust numeric member names on unproven receivers", () => {
    // String#valueOf returns the string; parsed JSON can carry { length: "1 OR 1=1" }.
    for (const expr of [
      "req.body.name.valueOf()",
      "req.body.length",
      "req.body.limit.size",
      "req.body.d.getTime()",
      "req.body.items.indexOf(1)",
      "req.body.n.toFixed(2)",
    ]) {
      const found = unproven(
        `export const f = (pool: any, req: any) => pool.query(\`SELECT * FROM users WHERE id = \${${expr}}\`);`
      );
      expect(found, expr).toHaveLength(1);
      expect(found[0].dynamicParts).toEqual([expr]);
    }
    // ...but the same members on receivers the code itself builds stay proven.
    expect(
      unproven(`export function f(pool: any, ids: number[]) {
        const params: number[] = [];
        const now = new Date();
        return pool.query(\`SELECT \${now.getTime()} WHERE \${Object.keys({ a: 1 }).length} = $\${params.push(ids[0])} LIMIT \${params.length}\`, params);
      }`)
    ).toHaveLength(0);
  });

  it("proves placeholder lists built by push-only arrays", () => {
    const found = unproven(`export function f(pool: any, ids: number[]) {
        const params: number[] = [];
        const holders: string[] = [];
        for (const id of ids) holders.push(\`$\${params.push(id)}\`);
        return pool.query(\`SELECT * FROM t WHERE id IN (\${holders.join(",")})\`, params);
      }`);
    expect(found).toHaveLength(0);
  });

  it("fingerprints are stable under reformatting but change with the expression", () => {
    const a = scan("export const f = (p: any, t: string) => p.query(`SELECT * FROM ${t}`);")[0];
    const b = scan("export const f = (p: any, t: string) =>\n  p.query(\n    `SELECT * FROM ${t}`\n  );")[0];
    const c = scan("export const f = (p: any, t: string) => p.query(`SELECT * FROM ${t} WHERE 1=1`);")[0];
    expect(a.id).toBe(b.id);
    expect(a.id).not.toBe(c.id);
  });
});

describe("raw SQL allowlist validation", () => {
  const source = `const TABLES = new Set(["a"]);
    export function f(pool: any, table: string) { if (!TABLES.has(table)) throw new Error("x"); return pool.query(\`SELECT * FROM \${table}\`); }`;
  const [finding] = unproven(source);

  it("accepts a complete, specific approval", () => {
    const result = validateAllowlist([finding], { entries: [entryFor(finding)] });
    expect(result.errors).toEqual([]);
    expect(result.reviewed).toBe(1);
  });

  it("rejects an unreviewed site", () => {
    expect(validateAllowlist([finding], { entries: [] }).errors.join("\n")).toMatch(/UNREVIEWED/);
  });

  it("rejects stale approvals for removed or changed sites", () => {
    const changed = unproven(source.replace("SELECT *", "SELECT id"))[0];
    const errors = validateAllowlist([changed], { entries: [entryFor(finding)] }).errors.join("\n");
    expect(errors).toMatch(/UNREVIEWED/);
    expect(errors).toMatch(/STALE APPROVAL/);
  });

  it("rejects duplicate, malformed, unknown-classification and generic approvals", () => {
    expect(validateAllowlist([finding], { entries: [entryFor(finding), entryFor(finding)] }).errors.join()).toMatch(
      /DUPLICATE/
    );
    expect(validateAllowlist([finding], { entries: [{ id: finding.id }] }).errors.join()).toMatch(/MALFORMED/);
    expect(
      validateAllowlist([finding], { entries: [entryFor(finding, { classification: "trust-me" })] }).errors.join()
    ).toMatch(/unknown classification/);
    expect(
      validateAllowlist([finding], { entries: [entryFor(finding, { reason: "safe because internal" })] }).errors.join()
    ).toMatch(/WEAK JUSTIFICATION/);
    expect(
      validateAllowlist([finding], {
        entries: [
          entryFor(finding, { dynamicInputs: [{ expression: "table", source: "internal", validation: "ok" }] }),
        ],
      }).errors.join()
    ).toMatch(/WEAK PROVENANCE/);
    expect(validateAllowlist([finding], "nope").errors.join()).toMatch(/MALFORMED ALLOWLIST/);
  });

  it("rejects an approval whose documented inputs no longer match the site", () => {
    const entry = entryFor(finding, {
      dynamicInputs: [
        {
          expression: "otherThing",
          source: "code-owned constant somewhere",
          validation: "membership test against a fixed set",
        },
      ],
    });
    expect(validateAllowlist([finding], { entries: [entry] }).errors.join()).toMatch(/PROVENANCE DRIFT/);
  });

  it("rejects approvals bound to a different file / category / function", () => {
    expect(
      validateAllowlist([finding], { entries: [entryFor(finding, { path: "server/other.ts" })] }).errors.join()
    ).toMatch(/APPROVAL MISMATCH/);
  });

  it("rejects approvals for sites that are already mechanically proven", () => {
    const [proven] = scan('export const f = (p: any) => p.query(`SELECT * FROM ${"t"}`);');
    expect(proven.autoVerified).toBeTruthy();
    expect(validateAllowlist([proven], { entries: [entryFor(proven)] }).errors.join()).toMatch(/UNNECESSARY APPROVAL/);
  });
});

describe("check:raw-sql CLI", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function tree(files: Record<string, string>, allowlist: unknown = { entries: [] }) {
    const root = mkdtempSync(join(tmpdir(), "raw-sql-gate-"));
    dirs.push(root);
    for (const r of SCAN_ROOTS as string[]) {
      mkdirSync(join(root, r), { recursive: true });
      writeFileSync(join(root, r, "keep.ts"), "export {};\n");
    }
    mkdirSync(join(root, "docs/security"), { recursive: true });
    writeFileSync(join(root, "docs/security/raw-sql-allowlist.json"), JSON.stringify(allowlist));
    for (const [p, s] of Object.entries(files)) writeFileSync(join(root, p), s);
    return root;
  }
  const run = (root: string, ...args: string[]) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, ["scripts/verify-raw-sql-allowlist.mjs", "--root", root, ...args], {
          encoding: "utf8",
        }),
      };
    } catch (error) {
      const e = error as { status: number; stdout: string };
      return { code: e.status, out: e.stdout };
    }
  };

  it("fails on a newly introduced unsafe site and passes once reviewed + registered", () => {
    const unsafe = {
      "server/new.ts":
        "export const f = (p: any, req: any) => p.query(`SELECT * FROM t WHERE name = '${req.body.name}'`);\n",
    };
    const root = tree(unsafe);
    run(root, "--write-register");
    const failed = run(root);
    expect(failed.code).toBe(1);
    expect(failed.out).toMatch(/UNREVIEWED query-text server\/new.ts/);
  });

  it("passes on a clean tree and fails when the register is out of date", () => {
    const root = tree({
      "server/ok.ts": "export const f = (p: any) => p.query(`SELECT * FROM t WHERE id = $1`, [1]);\n",
    });
    expect(run(root).code).toBe(1); // no register committed yet
    run(root, "--write-register");
    expect(run(root).code).toBe(0);
  });

  it("fails when a scan root is missing", () => {
    const root = tree({});
    rmSync(join(root, "shared"), { recursive: true, force: true });
    run(root, "--write-register");
    const result = run(root);
    expect(result.code).toBe(1);
    expect(result.out).toMatch(/SCAN ROOT MISSING shared/);
  });
});

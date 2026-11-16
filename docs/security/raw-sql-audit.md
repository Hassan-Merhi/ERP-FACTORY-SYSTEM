# Raw SQL injection audit and review gate

Status: **complete** — every SQL construction site in the scanned tree has a
recorded disposition and `npm run check:raw-sql` enforces it in required CI
(Repository Audits job). Working notes from the earlier phases are kept as
records in `docs/archive/raw-sql-phase1.md` and
`docs/archive/raw-sql-phase2-review.md`.

## How to use the gate

```bash
npm run check:raw-sql                                   # CI gate (fails closed)
node scripts/verify-raw-sql-allowlist.mjs --inventory   # full machine-readable inventory
node scripts/verify-raw-sql-allowlist.mjs --write-register  # regenerate the findings register
```

When the gate reports `UNREVIEWED`, `STALE APPROVAL` or `PROVENANCE DRIFT`:

1. Prefer fixing the code: bind values with drizzle `sql\`...${value}\`` /
   `sql.join`, or `$n` + params with node-postgres; choose identifiers from a
   fixed map and emit them with `sql.identifier`; use the guards in
   `server/lib/sqlTextGuards.ts` for code-owned alias / column / placeholder text.
2. Only if the dynamic text is genuinely code-owned, add an entry to
   `docs/security/raw-sql-allowlist.json` that documents **every** dynamic
   part (expression, source with file:line, validation) and a specific
   reason. Then run `--write-register` and commit both files.

The gate rejects: unreviewed sites; approvals whose site changed or vanished
(fingerprint = file + enclosing function + formatting-insensitive expression
+ occurrence index); approvals that no longer match the exact dynamic parts;
duplicates; malformed entries; unknown classifications; short or generic
justifications ("safe because internal"); approvals for sites that are now
mechanically proven; a missing/empty scan root; an out-of-date register.
The checker is tested in `tests/security-raw-sql-checker.test.ts`.

## Scope and method

**Scanned** (measured, not estimated): 4,484 files — `server/` 2,333,
`shared/` 151, `scripts/` 280, `migrations/` 92, `tests/` 1,625, plus
`build.mjs`, `drizzle.config.ts`, `vite.config.ts`. Extensions: `.ts .tsx .mts
.cts .js .jsx .mjs .cjs .sql`. The only other files under the roots are
`scripts/git-hooks/pre-push` (shell) and `scripts/training-narration-tts.py`;
neither contains SQL. `client/` has no database access (no `pg`/drizzle
imports) and is out of scope.

**Detected categories** (`scripts/lib/raw-sql-scanner.mjs`, TypeScript AST):

| Category | Meaning | Sites |
| --- | --- | ---: |
| `query-text` | template / concatenation passed directly to `.query` / `.execute` / `.unsafe` | 557 |
| `assembled-sql-text` | SQL-shaped template / concatenation with dynamic parts anywhere (helpers, constants, loops, quoted `'${x}'` literals) | 386 |
| `indirect-query-text` | sink receives a variable / parameter holding SQL text (wrappers) | 131 |
| `sql.raw` | drizzle `sql.raw(...)` under any import alias | 70 |
| `dynamic-identifier` | `sql.identifier(x)` with non-literal (or wrong-arity) argument | 22 |
| `plpgsql-execute` | PL/pgSQL `EXECUTE` in `.sql` migrations or embedded SQL | 14 |
| `sql-array-join` | SQL-shaped array literal with dynamic elements, joined | 7 |
| **Total** | | **1,187** |

Also detected: `.replace()` on SQL text with a dynamic value (none remain).
Tagged drizzle templates (`sql\`...${v}\``) bind values and are not counted
as sites; `sql.raw` / `sql.identifier` inside them are.

For each site the scanner extracts the *dynamic parts* and tries to prove them
injection-proof: literals, `const` bindings, conditionals between proven
values, lookups in never-written const maps/arrays, `for (const x of FIXED)`,
push-only arrays of proven values, in-file helpers whose returns are proven
for proven arguments, and numeric values (`Number()`, arithmetic, `.length`,
loop counters) which render only as `[-0-9.e+]|NaN|Infinity`. PL/pgSQL
`format()` using only `%I`/`%L` is proven quoted.

## Results

| Disposition | Sites |
| --- | ---: |
| Auto-verified: static / numeric (scanner proof) | 680 |
| Auto-verified: PL/pgSQL `format()` with `%I`/`%L` only | 9 |
| Reviewed: trusted-sql-fragment | 145 |
| Reviewed: test-fixture | 147 |
| Reviewed: allowlisted-identifier | 88 |
| Reviewed: placeholder-text | 53 |
| Reviewed: not-sql-text (log/error/HTTP strings flagged by shape) | 32 |
| Reviewed: catalog-identifier | 16 |
| Reviewed: validated-numeric | 12 |
| Reviewed: developer-script | 5 |
| **Unresolved** | **0** |

Of the 498 reviewed sites: 465 have no user-controlled input reaching SQL
text; 32 are *indirectly* influenced by a request (the request only selects a
key in a code-owned map, or a value is validated/bound) and 1 carries a
request-derived value into text after strict validation (`partyOpenItemService`:
ids through `Number.isSafeInteger` + `intLiteral`). Per-site provenance
(source → validation → construction → sink) is in
`docs/security/raw-sql-allowlist.json`; the full register with risk and
status per site is `docs/security/raw-sql-audit-findings.json`.

The review of the 481 non-provable sites was done file by file, tracing each
dynamic part through its callers (grep across `server/`, `shared/`,
`scripts/`), including second-order sources (database-derived values were only
accepted when they are integers, catalog names that are quoted, or code-owned).

### Historical scope

The original "≈177 sites" was a planning estimate. Measured on `main` before
this work, the first scanner version found 444 `sql.raw` / interpolated-sink /
assembled-text sites (69 `sql.raw`); the expanded scanner finds 1,187 sites
because it also covers indirect sinks, helpers, PL/pgSQL and tests.

## Vulnerabilities fixed

| Area | Problem | Fix |
| --- | --- | --- |
| Full export (`server/services/export-excel/workbook.ts`, `POST /api/export/start`, `POST /api/daily-export/trigger-whatsapp`) | **Exploitable.** `req.body.fromDate` / `toDate` spliced as `'${fromDate}'` into ~42 export queries. The WhatsApp trigger only requires authentication. | Calendar-date validation at both routes (400) and in the builder; dates bound as `$1/$2`. |
| Rental accrual / posting, transporter allocation & statement, rental payment posting | ID lists built with `sql.raw(ids.join(","))`; a payment cutoff date spliced as `'${effectiveAsOf}'` | `sql.join` of bound ids; bound date |
| SP migration rollback, admin dependent-row purge | `sql.raw` of table name + id | `sql.identifier` (fixed set / catalog, schema-qualified) + bound id |
| SP GIT tracking update & import/undo | `sql.raw(column)` | `sql.identifier` from the fixed column map |
| Accounting: account history, cash/bank reconciliation, FX valuation, party open items | `sql.raw(table / column)` | `sql.identifier` after fixed-set checks; fixed a wrong-arity `sql.identifier("ve", column)` that rendered only `"ve"` |
| Factory net position | `sql.raw(alias)`, `sql.raw(number)` with arbitrary strings | quoted identifiers; typed `SQL` fragments |
| Factory bilingual snapshots | whole queries built as strings with `${Number(companyId)}`, scope ids, product id and the information_schema table list | bound ids and table list, quoted identifiers, frozen code-owned target config (`requirePositiveId`) |
| Exported SQL-text helpers (`partyLineRules` ×3, `reversalPairSql`, `consolidatedHadiRentLedgerPredicate`, `buildPaginationIntegrityConditions`, `stockItemHistorySqlText`) | accepted any `string` alias/column/placeholder into SQL text | runtime guards in `server/lib/sqlTextGuards.ts` |
| Code-owned maps keyed by request data (export run tracker, historical currency repair kinds, opening-balance entity types) | prototype keys (`constructor`) passed `!== undefined` checks | own-property lookups (`ownKey`) |

In total 31 `sql.raw(...)` calls with dynamic input were removed (one
documented `configFragment` remains for the frozen bilingual target config).

## Tests

* `tests/security-raw-sql-checker.test.ts` — scanner detection and proofs,
  allowlist validation failure modes, CLI end to end.
* `tests/security-sql-injection-regression.test.ts` — payloads `' OR '1'='1`,
  `1; DROP TABLE customers; --`, `company_id DESC; DELETE FROM vouchers; --`,
  quotes, comments, unicode apostrophes, NUL, numeric coercion, NaN /
  fractional / huge / negative ids, malformed dates, untrusted sort / table /
  alias, second-order stored payloads; tenant isolation (no cross-company
  read or update, deleted rows stay hidden, stacked statements rejected)
  against a disposable database (`DATABASE_URL`, CI test database only).
* Updated: `export-excel-workbook-behavior`, `rental-accrual-positive-path`,
  `performance-wave4-database-hotspots` (they pinned the old interpolated text).

## Known limitations

* The scanner is syntactic. It does not use the TypeScript type checker, so
  values it cannot prove (e.g. a typed `number` parameter) are left to manual
  review rather than auto-approved. SQL built in files outside the scan roots,
  or passed through `eval`/`new Function`, would not be seen.
* Reviewed "trusted-sql-fragment" sites rely on the fragment staying
  code-owned. The fingerprint changes whenever the expression or its dynamic
  parts change, forcing a new review.
* `scripts/wipe-company12-data.ts` interpolates information_schema names
  without quoting (operator-only script, catalog names); recorded, not changed.
* `/api/daily-export/trigger-whatsapp` is reachable by any authenticated user;
  the injection is fixed but the authorization level was not changed by this
  audit (out of scope — flagged for a separate decision).
* No production database was read or modified by this work.

# Raw SQL injection audit — Phase 1 baseline

Status: initial discovery and high-confidence unsafe interpolation fixes committed.
This is **not** a security sign-off for the repository.

## Scope and reproducible inventory

Run `node scripts/verify-raw-sql-allowlist.mjs --inventory > raw-sql-inventory.json`
from the repository root after installing dependencies. The inventory is AST-derived,
records file/line/category and fingerprints individual occurrences, and includes
`sql.raw(...)` calls plus direct interpolated template arguments passed to
`.query(...)` and `.execute(...)`. The default command,
`npm run check:raw-sql`, fails closed on any unreviewed occurrence and on stale
allowlist approvals.

The previously estimated **~177** sites are a planning estimate, not a
validated count. A preliminary GitHub source search located **44 files**
containing the term `sql.raw` (including some test files); this is not an
exhaustive enumeration of calls and does not cover all direct PostgreSQL clients.
The inventory command must be executed on a checked-out repository to obtain
an authoritative count. The current allowlist is intentionally empty.

## High-confidence fixes in this branch

- `server/lib/transporterAllocation.ts`: bound loan-account and allocation
  entry IDs rather than injecting comma-separated values.
- `server/routes/sp/spMigrationPhase2Routes.ts`: checked rollback table
  names remain from the fixed set; use `sql.identifier(table)` and bound IDs
  for ownership and delete queries.
- `server/routes/rental/shared/accrual.ts`: bound monthly-ledger IDs and
  payment cutoff values across the previous raw SQL paths.

## Phase 2 entry criteria

1. Run the AST inventory in an actual checkout and preserve the full findings.
2. Review every occurrence's dynamic inputs and caller provenance. Static SQL
   strings and validated identifiers may qualify for a *documented* allowlist;
   user-controlled values must be bound, not allowed.
3. Expand scanner coverage for nonstandard query helpers, string-built SQL
   passed indirectly to a database call, and aliases where needed.
4. Ensure the review gate rejects new, altered, unreviewed, and stale entries.
5. Run TypeScript checking, injection-focused tests, relevant backend regression
   suites, and CI before merging. No claim of these checks passing is made here.

Never bulk-approve findings based solely on an AST pattern or the file name.

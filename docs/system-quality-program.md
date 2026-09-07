# System quality program

This document is the current reference for the repository quality program that
covers **type safety**, **test breadth**, **documentation state**, and
**configuration coherence**. Historical phase notes belong under
`docs/archive/`; this file describes the rules that are enforced now.

The governing principle is the same as the god-file program: **measurement and
a falling ratchet come before cleanup**. A cleanup without a ratchet can refill
silently; a ratchet without a behavioural test can give a false sense of safety.

## Where things stand

Every bound figure below is checked by `npm run audit:doc-index` against its live
source. If one of these numbers changes without this document changing, the
audit fails instead of allowing the reference to drift.

| Signal | Now | Command |
|---|---|---|
| Type escapes (AST) | 1,658 total | `npm run audit:type-escapes` |
| ESLint warnings | 0 total | `npm run lint` |
| Startup migration failures | 0 on a fresh database | `npm run verify:startup-migrations` |
| Backend coverage floor (lines) | 35% | `config/coverage-thresholds.json` |
| Write routes with no test at all | 0 of 328 | `npm run audit:write-routes` |
| Write routes covered only by the guard sweep | 0 of 328 | `npm run audit:write-routes` |
| Registered routes | 1,947 | `config/route-manifest.json` |
| God-file backlog | 0 files, 0 excess lines | `npm run audit:god-files` |

The schema layer remains the type source of truth. New code is not allowed to
increase the type-escape ceiling, and sensitive write routes are not allowed to
fall back to anonymous-auth coverage only.

---

## Phase 0 — measurement foundation

Phase 0 created the instruments that make the rest of the program enforceable.
It is complete.

### Type-escape census

`scripts/audit-type-escapes.mjs` measures `: any`, `as any`, and TypeScript
suppression escapes per file. The committed baseline may only fall. New files
cannot add escapes without either fixing them or deliberately changing the
baseline in the same reviewed change.

```bash
npm run audit:type-escapes
```

### Money-endpoint characterization

`tests/report-endpoint-characterization.test.ts` pins the output of high-risk
money/report endpoints so refactors cannot silently change financial results.
The characterization set includes the purchase-order write path and factory raw
stock offload path in addition to the read/report endpoints.

### Documentation state index

`config/doc-index.json` classifies current reference documents and archived
records and binds important numerical claims to live configuration/audit
sources.

```bash
npm run audit:doc-index
```

---

## Phase 1 — type-safety ratchet

The type-safety foundation is complete and the long-term drawdown remains an
ownership rule: code that is touched should improve or preserve its local escape
count; untouched code cannot get worse.

`@typescript-eslint/no-explicit-any` is visible during development, while the
exact enforcement comes from `config/type-escape-boundaries.json`. Drizzle raw
result casts were reduced through typed helpers such as `resultRows()` and
`firstRow()` so raw SQL row shapes are declared next to the query rather than
forced through `any`.

The rule for future work is simple: **do not raise a frozen type-escape baseline
to make unrelated churn fit**. If formatting or file-size gates block a cleanup,
fix the structural blocker instead of creating headroom that can refill.

### Lint warning ratchet

The ESLint cap was the last gate in this repository whose threshold was not
measured. It lived in the `lint` script as `--max-warnings 12358`, a number
nobody could trace: the tree was actually at 12,304, so 54 warnings could be
added before anything failed, and a cap that has never been re-measured only
ever describes the day it was typed.

The ceiling now lives in `config/lint-warning-ratchet.json`, alongside the
coverage floors and type-escape baselines. `scripts/run-lint.mjs` reads it, so
`npm run lint` has no number of its own, and the ratchet is a two-part gate:

- **`totals.warningCeiling`** is the repository total, now 0 and permanent.
  `totals.errorCeiling` is also 0 and permanent — errors are not part of the
  drawdown.
- **`perRule`** freezes each rule at its own count, checked by
  `npm run audit:lint-ratchet`. Before the warning cleanup, 8,815 of 9,441
  warnings were `no-explicit-any`; a total-only gate would have allowed those
  removals to pay for new `react-hooks/exhaustive-deps` warnings. Per-rule
  ceilings prevented that trade. The object is now empty because every warning
  rule is at zero.

`scan.step` is 500. It remains as historical ratchet metadata, but with the
warning ceiling at zero every new warning fails immediately.

`no-explicit-any` is gated by `config/type-escape-boundaries.json`, which freezes
the backlog per file and is strictly stronger than a repository-wide ESLint
count. The lint rule allowances are now empty because every enabled lint rule
is clean; a warning from any rule is therefore both above the total ceiling and
missing an authorised per-rule ceiling.

---

### Startup migration ratchet

`.github/workflows/ci.yml` gates the entire backend suite on the startup step:
`node dist/index.js` runs, CI polls `/api/health/db`, and the tests only run
`if: steps.runtime_migrations.outcome == 'success'`. That endpoint reported
`{"status":"ok","message":"Database ready"}` as soon as the migration pass
*finished*, whether or not migrations inside it had failed — so eleven failed
migrations on a fresh database passed the gate every run, and the suite tested
whatever schema survived.

`server/startupMigrationReport.ts` now records the outcome and
`server/health/dbHealthRoute.ts` publishes it, so the endpoint carries a
`migrations` block with the failure count and the failing statements. Readiness
semantics are unchanged: the response is still 200 with `status: "ok"` once the
pass completes, because CI uses it to learn that startup is done and Render's
own check is `/api/health/ready`.

`scripts/verify-startup-migrations.mjs` turns that report into a gate against
`config/startup-migration-baseline.json`. The known set is frozen,
`totals.failureCeiling` may only fall, and any failure not already recorded
fails the build.

The ceiling is **0**: any startup migration failure fails the build. It did not
start there. The first measurement on a fresh database found eleven failures,
which were frozen as a baseline so the gate was real immediately rather than
permanently red — a gate that is always red is one that gets switched off. All
eleven were then fixed and the ceiling lowered to zero:

- Nine were seed `INSERT`s pinning `company_id` values that do not exist on a
  fresh database. Each is now a guarded `SELECT` checking that both the company
  and the referenced ledger account exist, so they no-op on an empty database
  and still seed once the target company is created.
- Two were foreign keys targeting schema that no longer exists:
  `supplier_containers`, which is defined neither here nor in `shared/schema`,
  and `bales.erp_location_id`, a column only `factory_bales` still carries.
  Both statements are guarded on the object being present rather than deleted,
  so a long-lived database that still has them still gains the key.

Three `factory_container_receipts` constraints were fixed in the same change:
they lacked the `DO`/`duplicate_object` guard the rest of that file uses, so
they failed on every startup after the first. A re-run against an
already-migrated database now produces the same eleven rather than fourteen.

---

## Phase 2 — coverage breadth and sensitive writes

Phase 2 is complete at the ratchet level.

### Read-surface contract sweep

The API smoke sweep does more than check liveness. Stable read endpoints have a
pinned status/shape contract in `config/api-smoke-shapes.json`, so an endpoint
that silently starts refusing access or drops response structure is detected.

```bash
npm run test:smoke-sweep
```

### Sensitive write audit

`scripts/audit-write-route-coverage.mjs` classifies POST/PUT/PATCH/DELETE routes
whose owner files write money or stock-ledger tables such as `vouchers`,
`voucher_entries`, `inventory`, `sales_items`, `factory_raw_stock`,
`factory_bales`, and `ledger_accounts`.

There are two zero ceilings in `config/write-route-coverage.json`:

- **uncoveredSensitiveCeiling = 0** — every sensitive write must be covered by a
  test surface;
- **guardOnlySensitiveCeiling = 0** — authentication-only coverage is not enough.

The unauthenticated guard sweep remains important because it proves every
sensitive write rejects anonymous callers. It no longer receives credit as the
only behavioural evidence for any sensitive route.

### Authenticated write-safety sweep

`tests/write-route-authenticated-safety-sweep.test.ts` closes the broad gap for
routes that would otherwise have only the anonymous guard assertion. It derives
that exact pre-sweep set from the audit at runtime and invokes every route as an
authenticated Developer in the appropriate ERP, Factory, Properties, or
Supplier Partner company mode.

The sweep is intentionally **non-mutating**. It uses missing resource IDs and
poison/dry-run validation bodies and asserts that each call:

- does not 5xx;
- does not lose the authenticated session;
- does not change the selected company's voucher totals, ledger-account count,
  inventory quantity/value, raw-stock quantity, bale count, or sales-item count;
- leaves all non-optional vouchers balanced;
- does not touch sentinel accounting state in unrelated ERP, Factory,
  Properties, or Supplier Partner companies.

This is negative-path behavioural coverage, not a replacement for deep
positive-path tests. Exact accounting/stock behaviour continues to be pinned by
route/domain tests that assert journal direction, quantities, statuses,
reversals, and lifecycle transitions. Examples added during the drawdown include
purchase-order edits/deletes, factory reverse-offload, and container other-charge
posting/replacement.

`tests/write-route-authenticated-safety-audit.test.ts` protects the measurement
itself: with the authenticated sweep deliberately disabled, the audit must still
see the pre-sweep guard-only backlog; with it enabled, that same measured set
must fall to zero. The audit also requires the sweep's dynamic inventory,
sensitive fingerprint, voucher-balance assertion, and isolation sentinels to
remain present before it grants that coverage. A leftover marker comment is not
enough.

```bash
npm run audit:write-routes
```

**Phase 2 exit criteria:** no sensitive write route is uncovered; no sensitive
write route is covered only by the anonymous guard sweep; authenticated
negative-path atomicity and cross-company isolation are enforced across the
remaining surface; deep positive-path domain tests remain the source of truth
for the numbers written.

---

## Phase 3 — documentation state

Phase 3 is complete and enforced by both the standalone documentation audit and
the normal backend test suite.

### Current references versus historical records

Every Markdown document below `docs/` is explicitly classified in
`config/doc-index.json` as one of two states:

- **reference** — describes current behaviour and must live outside
  `docs/archive/`;
- **record** — describes completed work and must live under `docs/archive/`.

`npm run audit:doc-index` fails when a document is unclassified, when its class
does not match its location, or when the index contains a stale path for a file
that no longer exists. Renaming or deleting documentation therefore requires an
intentional index change rather than leaving ghost metadata behind.

### Discoverability contract

`docs/README.md` is the canonical navigation surface for current documentation.
Every current reference except the README itself must be linked there. A new
reference that is correctly classified but not discoverable still fails the
audit. The landing page also fails if it directly lists an archived record as
current documentation or links to a missing Markdown document.

This closes a gap where a document could be technically present and correctly
classified but effectively invisible to maintainers.

### Bound live figures

Selected numerical claims in current documentation are explicitly bound to live
configuration or audit outputs in `config/doc-index.json`. When the source value
changes, the documentation must change in the same work or the audit fails.
This is intentionally narrow: prose freshness still requires review, while
figures with an objective source are machine-enforced.

### Test-suite integration

`tests/doc-index-contract.test.ts` invokes the same audit during the normal
backend suite and asserts that there are no unclassified docs, stale entries,
misplaced docs, missing README references, archived-record navigation leaks,
broken README Markdown links, or bound-figure mismatches.

```bash
npm run audit:doc-index
```

**Phase 3 exit criteria:** the documentation index exactly describes the current
Markdown tree; references and records are physically separated; every live
reference is reachable from the docs landing page; stale paths and broken
landing-page entries fail closed; objective figures remain bound to their live
sources; and the contract is part of the standard backend tests.

---

## Phase 4 — configuration coherence

Phase 4 is complete at the implementation level. Runtime selection, CI wiring,
script-gate classification, workflow drift, and committed deployment-secret
hygiene are all expressed as enforceable contracts rather than conventions.

### Canonical Node runtime

`.node-version` is the canonical runtime pin. `scripts/audit-toolchain-coherence.mjs`
requires agreement across:

- `.nvmrc` — exact canonical version;
- `package.json#engines.node` — compatibility floor in the same Node major and
  no older major admitted;
- `.replit` — exactly one `nodejs-N` module matching the canonical major;
- `render.yaml#NODE_VERSION` — exact canonical version used by production;
- every GitHub Actions job that runs `node`, `npm`, or `npx` — exactly one
  `actions/setup-node` pin and that pin must equal the canonical version;
- every CircleCI `cimg/node` image — exact canonical version;
- the root README prerequisite — exact canonical version.

The job-level rule is important. Merely scanning literal `node-version:` strings
allowed a workflow to run Node without `setup-node` and inherit whatever version
`ubuntu-latest` happened to provide. The i18n audit had exactly that gap and is
now explicitly pinned. The production Render declaration had also been pinned
only to major `22`; it is now pinned to the same canonical `22.14` used by the
repository.

`tests/toolchain-coherence-audit.test.ts` executes the same audit from the normal
backend suite and pins the production Render source plus every Node-using GitHub
job to the canonical runtime.

```bash
npm run audit:toolchain
```

### Workflow coherence

Active workflows are aligned with current branch/tooling conventions rather
than obsolete phase branches. The RTL/accessibility workflow now targets
`main`, uses a purpose-based concurrency key, and uses the same current checkout
and setup-node action generations as the other maintained workflows. The mobile
responsive workflow was aligned to those action generations as well.

A workflow that uses Node without pinning it is now a toolchain-audit failure,
so adding a new workflow cannot silently reintroduce hosted-runner drift.

### Verification-script inventory

`scripts/audit-script-inventory.mjs` no longer treats the existence of an npm
alias as proof that a script is a CI gate. Every `verify-*.mjs` and
`audit-*.mjs` is classified into one of four states:

- **wired** — invoked by automatic GitHub Actions or CircleCI;
- **manual** — exposed through `package.json` or a `workflow_dispatch`-only
  workflow but not automatically enforced;
- **chained** — reached only by another script or test;
- **orphan** — neither invoked nor intentionally exposed.

Automatic wired scripts are executed by the inventory audit unless they have a
reviewed build/database/network dependency in `config/script-inventory.json`.
A `knownFailing` entry may describe a manual release check, but it cannot be
used to suppress a failing automatic CI gate. Stale exception rows and empty
exception reasons fail the audit, and the orphan count remains a falling
ceiling.

The existing untranslated-text release debt remains classified as a **manual
release finding**, not an automatically-green gate. Final verification must fix
that debt or leave the release blocked; increasing translation caps is not a
valid repair.

`tests/script-inventory-contract.test.ts` pins the automatic/manual distinction,
the orphan ceiling, and the rule that the known translation debt stays out of
automatic CI while unresolved.

```bash
npm run audit:scripts
```

### Committed configuration secret hygiene

A carrier API credential was found as a literal value in committed `.replit`
configuration during this phase. The current configuration no longer contains
the value. Credentials belong in platform secret/environment storage, not in
repository configuration.

`tests/configuration-secret-hygiene.test.ts` now scans committed deployment-style
environment files (`.replit`, `.env.production`, and Capacitor environment
configuration) for literal values assigned to credential-bearing variable names,
and rejects literal secret values in `render.yaml` as well.

Removing a secret from the current tree does **not** erase it from Git history.
Any credential discovered this way must also be rotated at the provider.

**Phase 4 exit criteria:** one canonical Node runtime is selected at every real
runtime/CI boundary; a Node-using workflow cannot rely on the hosted runner's
default; deployment runtime pins match repository pins; automatic gates are
distinguished from manual commands; known failures cannot suppress automatic
CI; orphan verification scripts remain ratcheted; stale script exceptions fail;
committed deployment configs cannot contain literal credentials; and all three
contracts are represented in the normal backend test suite.

---

## Phase 5 — tighten ratchets

Tightening is the ongoing maintenance phase. When measured coverage or code
quality improves, the corresponding floor/ceiling must move in the same change
so the improvement cannot silently refill later.

Targets include:

- lower type-escape ceilings as domains are cleaned;
- lower the lint warning ceiling a 500-warning step at a time, and the matching
  `perRule` entry with it, whenever `npm run audit:lint-ratchet` reports the
  step earned;
- raise coverage floors to track measured coverage with margin;
- lower god-file soft limits/backlog as files are split;
- keep sensitive-write uncovered and guard-only ceilings permanently at zero.

---

## Working rules

1. **Baseline changes travel with the implementation.** Do not leave headroom
   after reducing a backlog.
2. **Do not regenerate behavioural pins for an accidental change.** A changed
   pin is a behaviour change and must be reviewed as one.
3. **Negative-path sweeps do not replace positive-path accounting tests.** The
   broad sweep proves safety/atomicity; domain tests prove the numbers.
4. **Company isolation is part of correctness.** A route that writes the right
   amount to the wrong company is still a failed financial write.
5. **Final release verification happens after implementation phases.** Full
   backend/frontend suites, build, lint/format, audit gates, GitHub Actions and
   external CI are run together at the final verification phase so intermediate
   implementation work is not repeatedly blocked by the full matrix.

#!/usr/bin/env node
/**
 * audit-write-route-coverage.mjs
 *
 * The smoke sweep deliberately excludes mutating endpoints — calling them in a
 * sweep is unsafe — which is correct, and leaves every write route in the
 * repository covered by nothing but whatever hand-written test happens to
 * mention it. This audit measures that gap and ranks it by blast radius.
 *
 * A write route is **sensitive** when the file registering it also writes to
 * one of the tables where a silent regression costs money rather than
 * convenience: vouchers, voucher_entries, inventory, sales_items, and the
 * factory raw-stock/bale equivalents. Those are the ledger and the stock
 * ledger; everything else is recoverable by editing a row.
 *
 * A route counts as **referenced** when some test mentions its path. That is a
 * deliberately weak definition — a mention is not an assertion — but it is
 * exact and unarguable, and the routes it reports have no test that so much as
 * names them. Strengthening the definition would mean guessing at intent.
 *
 * Phase F adds one explicit exception to that textual rule: the authenticated
 * write-safety sweep derives the current guard-only set from this audit at
 * runtime and invokes every one of those routes as a privileged user. Because
 * its route inventory is deliberately dynamic, the paths do not appear as
 * literals in the test source. The sweep only counts while its required
 * behavioural-contract signatures are all present, and callers can disable
 * that recognition to recover the raw pre-sweep guard-only list that the test
 * itself must execute.
 *
 * Usage:
 *   npm run audit:write-routes
 *   node scripts/audit-write-route-coverage.mjs --json
 *   UPDATE_WRITE_ROUTE_BASELINE=1 node scripts/audit-write-route-coverage.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(projectRoot, "config/route-manifest.json");
const configPath = path.join(projectRoot, "config/write-route-coverage.json");

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** The sweep that covers the whole sensitive write surface with one auth assertion. */
const GUARD_SWEEP_TEST = "tests/write-route-guard-sweep.test.ts";

/**
 * Authenticated behavioural sweep. Unlike GUARD_SWEEP_TEST this enters the
 * authenticated route chain, uses deliberately invalid resources / validation
 * bodies, and asserts that sensitive state is not partially mutated and that
 * vouchers remain balanced. Requiring the behavioural signatures below means a
 * leftover marker comment cannot keep 168 routes credited after the real test
 * loop or its invariants have been deleted.
 */
const AUTHENTICATED_SAFETY_SWEEP_TEST = "tests/write-route-authenticated-safety-sweep.test.ts";
const AUTHENTICATED_SAFETY_SWEEP_SIGNATURES = [
  "WRITE_ROUTE_AUTHENTICATED_SAFETY_SWEEP_V1",
  "auditWriteRouteCoverage({ includeAuthenticatedSafetySweep: false })",
  "raw.guardOnlySensitive",
  "sensitiveFingerprint",
  "expectBalancedVouchers",
  "controlBefore",
  "mutated sensitive state during the safety sweep",
];

/** Tables whose corruption is expensive and hard to notice. */
const SENSITIVE_TABLES = [
  "vouchers",
  "voucher_entries",
  "voucherEntries",
  "inventory",
  "sales_items",
  "salesItems",
  "factory_raw_stock",
  "factoryRawStock",
  "factory_bales",
  "factoryBales",
  "ledger_accounts",
  "ledgerAccounts",
  // A payroll deduction reduces what a worker is paid. It reaches the ledger
  // through a payroll voucher rather than directly, which is why it was missing
  // here — but the money is no less real. Its absence only became visible when
  // splitting workerStatsAdvancesRoutes.ts moved the deduction routes out of the
  // file that also posts vouchers: the audit classifies by owner file, so the god
  // file had been lending them a sensitivity they did not declare themselves.
  "factory_worker_deductions",
  "factoryWorkerDeductions",
];

/** Ways this codebase writes: drizzle builders and raw SQL alike. */
function writesSensitiveTable(source) {
  for (const table of SENSITIVE_TABLES) {
    const patterns = [
      new RegExp(`\\.insert\\(\\s*${table}\\b`),
      new RegExp(`\\.update\\(\\s*${table}\\b`),
      new RegExp(`\\.delete\\(\\s*${table}\\b`),
      new RegExp(`INSERT\\s+INTO\\s+${table}\\b`, "i"),
      new RegExp(`UPDATE\\s+${table}\\b`, "i"),
      new RegExp(`DELETE\\s+FROM\\s+${table}\\b`, "i"),
    ];
    if (patterns.some((pattern) => pattern.test(source))) return table;
  }
  return null;
}

const READS_FILE_CONTENTS = /\breadFileSync\b|\breadFile\b/;
const TEXT_ASSERTION = /\.(?:toContain|toMatch)\(/;

/**
 * True when a test reads file contents and asserts substrings against them.
 * Such a test pins source text rather than exercising behaviour, so a route
 * path appearing in it is evidence the route is still registered, not evidence
 * anything calls it.
 */
function assertsAgainstFileContents(source) {
  return READS_FILE_CONTENTS.test(source) && TEXT_ASSERTION.test(source);
}

function walk(dir, extensions, out = []) {
  const absolute = path.join(projectRoot, dir);
  if (!fs.existsSync(absolute)) return out;
  for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const relative = path.join(dir, entry.name).split(path.sep).join("/");
    if (entry.isDirectory()) walk(relative, extensions, out);
    else if (extensions.some((extension) => relative.endsWith(extension))) out.push(relative);
  }
  return out;
}

export function auditWriteRouteCoverage(options = {}) {
  const { includeAuthenticatedSafetySweep = true } = options;
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));

  const allServerFiles = walk("server", [".ts"]);
  const serverFiles = allServerFiles.filter((file) => !file.endsWith(".test.ts"));
  const sources = new Map(serverFiles.map((file) => [file, fs.readFileSync(path.join(projectRoot, file), "utf8")]));

  // Colocated server tests have to be selected from the unfiltered walk.
  // `serverFiles` has already had every `.test.ts` removed, so filtering it for
  // `.test.ts` could only ever yield nothing, and a route whose only test sits
  // beside its route file read as having no test at all.
  const testFiles = [...walk("tests", [".ts"]), ...allServerFiles.filter((file) => file.endsWith(".test.ts"))];
  const readTest = (file) => fs.readFileSync(path.join(projectRoot, file), "utf8");
  const sweepText = testFiles.includes(GUARD_SWEEP_TEST) ? readTest(GUARD_SWEEP_TEST) : "";
  const authenticatedSweepText = testFiles.includes(AUTHENTICATED_SAFETY_SWEEP_TEST)
    ? readTest(AUTHENTICATED_SAFETY_SWEEP_TEST)
    : "";
  const authenticatedSafetySweepPresent = AUTHENTICATED_SAFETY_SWEEP_SIGNATURES.every((signature) =>
    authenticatedSweepText.includes(signature)
  );
  // Naming a route inside a source-text assertion is not behavioural coverage.
  // A test that reads a route file and asserts substrings against it proves the
  // path is still registered; it never sends a request, so it cannot say the
  // handler still posts balanced vouchers or holds its tenant boundary. Letting
  // such a mention count as "tested elsewhere" takes the route out of
  // guardOnlySensitive - the set tests/write-route-authenticated-safety-sweep
  // enumerates - so the one gate that does exercise it would stop covering it.
  //
  // This is deliberately looser than the pinned-path rule in
  // audit-source-text-assertions.mjs: colocated tests read their sibling with a
  // relative `new URL("./routes.ts", import.meta.url)`, which that audit's
  // repo-rooted path pattern does not match. Reading any file and asserting a
  // substring is enough to disqualify the mention here.
  const otherTestText = testFiles
    .filter((file) => file !== GUARD_SWEEP_TEST && file !== AUTHENTICATED_SAFETY_SWEEP_TEST)
    .map(readTest)
    .filter((source) => !assertsAgainstFileContents(source))
    .join("\n");

  // Route path -> the file that registers it, built in one pass over the server
  // sources. The obvious shape — compile a regex per route and scan every file —
  // is 962 routes x ~2,500 files and took six seconds on its own, enough to push
  // the script-inventory gate past its 30-second budget. Scanning each file once
  // for every registration it makes gives the same answer in one sweep.
  const registrationOwners = new Map();
  const REGISTRATION_PATTERN = /\.(?:get|post|put|patch|delete)\(\s*"([^"]+)"/g;
  for (const [file, source] of sources) {
    for (const match of source.matchAll(REGISTRATION_PATTERN)) {
      const existing = registrationOwners.get(match[1]);
      if (!existing) registrationOwners.set(match[1], [file]);
      else if (!existing.includes(file)) existing.push(file);
    }
  }

  const routes = [];
  const seen = new Set();
  for (const entry of manifest.routes) {
    const [method, routePath] = entry.split(" ");
    if (!WRITE_METHODS.has(method) || !routePath?.startsWith("/api/")) continue;
    if (seen.has(`${method} ${routePath}`)) continue;
    seen.add(`${method} ${routePath}`);

    let owners = registrationOwners.get(routePath) ?? null;
    if (!owners) {
      for (const [file, source] of sources) {
        if (source.includes(`"${routePath}"`)) {
          owners = [file];
          break;
        }
      }
    }

    // A path can be registered by more than one file: a prerequisite that calls
    // next() is mounted ahead of the handler that actually writes. Taking only the
    // first registration let such a pass-through decide the classification, and a
    // route posting vouchers silently dropped out of the sensitive set. Classify
    // across every registering file and report the one that writes.
    let owner = owners?.[0] ?? null;
    let sensitiveTable = null;
    for (const file of owners ?? []) {
      const table = writesSensitiveTable(sources.get(file));
      if (table) {
        owner = file;
        sensitiveTable = table;
        break;
      }
    }
    const namedElsewhere = otherTestText.includes(routePath);
    const guardSweepReferenced = sweepText.includes(routePath);
    const referencedBeforeAuthenticatedSweep = namedElsewhere || guardSweepReferenced;
    const guardOnlyBeforeAuthenticatedSweep = referencedBeforeAuthenticatedSweep && !namedElsewhere;
    const authenticatedSafetyCovered = Boolean(
      includeAuthenticatedSafetySweep &&
        authenticatedSafetySweepPresent &&
        sensitiveTable &&
        guardOnlyBeforeAuthenticatedSweep
    );
    const referenced = referencedBeforeAuthenticatedSweep || authenticatedSafetyCovered;
    const guardOnly = guardOnlyBeforeAuthenticatedSweep && !authenticatedSafetyCovered;

    routes.push({
      method,
      path: routePath,
      owner,
      sensitiveTable,
      referenced,
      guardOnly,
      guardOnlyBeforeAuthenticatedSweep,
      authenticatedSafetyCovered,
    });
  }

  const sensitive = routes.filter((route) => route.sensitiveTable);
  const uncoveredSensitive = sensitive.filter((route) => !route.referenced);
  const guardOnlySensitive = sensitive.filter((route) => route.guardOnly);
  const guardOnlyBeforeAuthenticatedSweep = sensitive.filter((route) => route.guardOnlyBeforeAuthenticatedSweep);
  const authenticatedSafetyCovered = sensitive.filter((route) => route.authenticatedSafetyCovered);

  const failures = [];
  const ceiling = config.uncoveredSensitiveCeiling;
  if (ceiling !== undefined && uncoveredSensitive.length > ceiling) {
    failures.push(
      `${uncoveredSensitive.length} write routes touching money or stock tables have no test that references them; ` +
        `the ceiling is ${ceiling}. This number may only fall. Add a test, or explain the exception in ` +
        `config/write-route-coverage.json.`
    );
  }
  const guardOnlyCeiling = config.guardOnlySensitiveCeiling;
  if (guardOnlyCeiling !== undefined && guardOnlySensitive.length > guardOnlyCeiling) {
    failures.push(
      `${guardOnlySensitive.length} write routes touching money or stock tables are covered only by the guard ` +
        `sweep, which proves they reject an unauthenticated caller and nothing more; the ceiling is ` +
        `${guardOnlyCeiling}. This number may only fall. Give one of them behavioural coverage.`
    );
  }

  return {
    version: config.version,
    failures,
    routes,
    uncoveredSensitive,
    guardOnlySensitive,
    guardOnlyBeforeAuthenticatedSweep,
    authenticatedSafetyCovered,
    summary: {
      writeRoutes: routes.length,
      sensitiveRoutes: sensitive.length,
      sensitiveReferenced: sensitive.length - uncoveredSensitive.length,
      uncoveredSensitive: uncoveredSensitive.length,
      guardOnlySensitive: guardOnlySensitive.length,
      guardOnlyBeforeAuthenticatedSweep: guardOnlyBeforeAuthenticatedSweep.length,
      authenticatedSafetyCovered: authenticatedSafetyCovered.length,
      behaviourallyCovered: sensitive.length - uncoveredSensitive.length - guardOnlySensitive.length,
      ceiling: ceiling ?? null,
      guardOnlyCeiling: guardOnlyCeiling ?? null,
      authenticatedSafetySweepPresent,
      unownedRoutes: routes.filter((route) => !route.owner).length,
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = auditWriteRouteCoverage();

  if (process.env.UPDATE_WRITE_ROUTE_BASELINE === "1") {
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.uncoveredSensitiveCeiling = report.summary.uncoveredSensitive;
    config.guardOnlySensitiveCeiling = report.summary.guardOnlySensitive;
    fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    console.log(
      `Ceilings set to uncovered=${report.summary.uncoveredSensitive}, guard-only=${report.summary.guardOnlySensitive}.`
    );
    process.exit(0);
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.failures.length > 0 ? 1 : 0);
  }

  const { summary } = report;
  console.log(
    `Write routes: ${summary.writeRoutes}. Touching money or stock tables: ${summary.sensitiveRoutes}, ` +
      `${summary.uncoveredSensitive} uncovered, ${summary.guardOnlySensitive} guard-only, ` +
      `${summary.authenticatedSafetyCovered} covered by the authenticated safety sweep.`
  );

  const list = process.argv.includes("--list")
    ? report.uncoveredSensitive
    : process.argv.includes("--list-guard-only")
      ? report.guardOnlySensitive
      : null;
  if (list) {
    const byOwner = new Map();
    for (const route of list) {
      if (!byOwner.has(route.owner)) byOwner.set(route.owner, []);
      byOwner.get(route.owner).push(`${route.method} ${route.path}`);
    }
    for (const [owner, entries] of [...byOwner.entries()].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`\n${owner} (${entries.length})`);
      for (const entry of entries) console.log(`  ${entry}`);
    }
  }

  if (report.failures.length > 0) {
    console.error(report.failures.join("\n"));
    process.exitCode = 1;
  }
}

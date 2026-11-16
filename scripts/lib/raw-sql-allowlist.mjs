/**
 * Allowlist validation and register construction for the raw SQL review gate.
 * Pure functions so the checker itself can be unit-tested (tests/security/raw-sql-checker.test.ts).
 */

export const SCAN_ROOTS = ["server", "shared", "scripts", "migrations", "tests"];
export const ROOT_FILES = ["build.mjs", "drizzle.config.ts", "vite.config.ts"];

/** Review classifications a manual approval may use. */
export const CLASSIFICATIONS = new Map([
  ["allowlisted-identifier", "Identifier chosen from an application-owned fixed set (and quoted or validated against a strict pattern) before reaching SQL text."],
  ["catalog-identifier", "Identifier read from PostgreSQL system catalogs and emitted through identifier quoting."],
  ["trusted-sql-fragment", "SQL text produced only by application code (typed SQL fragments, code-owned expression builders) — no request, import or stored data reaches it."],
  ["validated-numeric", "Value validated as a safe integer / finite number (or coerced through Number()) before it is rendered into SQL text."],
  ["placeholder-text", "Only the SQL text for `$n` bind placeholders or fixed column lists is generated; every value travels as a bound parameter."],
  ["developer-script", "Maintenance / CI script input that comes from the operator's command line or a code constant, never from an application user."],
  ["test-fixture", "Test-only SQL against a disposable database; dynamic parts are test constants or generated fixture ids."],
]);

export const USER_CONTROLLED = new Set(["no", "indirect-validated", "yes-validated"]);

const GENERIC = /^(safe|internal|trusted|ok|fine|n\/?a|none|reviewed|constant|static|todo|tbd)\.?$|safe because internal|\btodo\b|\btbd\b|lorem/i;

const REQUIRED = ["id", "path", "kind", "context", "classification", "userControlled", "reason", "dynamicInputs"];

export function validateAllowlist(findings, allowlist) {
  const errors = [];
  const entries = Array.isArray(allowlist) ? allowlist : allowlist?.entries;
  if (!Array.isArray(entries)) {
    return { errors: ["MALFORMED ALLOWLIST: expected {\"entries\": [...]}"], reviewed: 0, autoVerified: 0, outstanding: findings.length, byId: new Map() };
  }
  const byId = new Map();
  for (const [index, item] of entries.entries()) {
    const label = item && typeof item.id === "string" ? item.id : `entry #${index}`;
    if (!item || typeof item !== "object") { errors.push(`MALFORMED ${label}`); continue; }
    const missing = REQUIRED.filter((k) => item[k] === undefined || item[k] === null || item[k] === "");
    if (missing.length) { errors.push(`MALFORMED ${label}: missing ${missing.join(", ")}`); continue; }
    if (byId.has(item.id)) { errors.push(`DUPLICATE APPROVAL ${item.id}`); continue; }
    if (!/^[0-9a-f]{20}$/.test(item.id)) errors.push(`MALFORMED ${label}: id must be a 20-hex fingerprint`);
    if (!CLASSIFICATIONS.has(item.classification)) errors.push(`MALFORMED ${label}: unknown classification "${item.classification}"`);
    if (!USER_CONTROLLED.has(item.userControlled)) errors.push(`MALFORMED ${label}: userControlled must be one of ${[...USER_CONTROLLED].join("|")}`);
    if (typeof item.reason !== "string" || item.reason.trim().length < 40 || GENERIC.test(item.reason.trim())) {
      errors.push(`WEAK JUSTIFICATION ${label}: reason must explain specifically why no untrusted SQL syntax can reach the text (>= 40 chars, not generic)`);
    }
    if (!Array.isArray(item.dynamicInputs) || item.dynamicInputs.length === 0) {
      errors.push(`MALFORMED ${label}: dynamicInputs must list every dynamic part`);
    } else {
      for (const input of item.dynamicInputs) {
        if (!input || typeof input.expression !== "string" ||
          typeof input.source !== "string" || input.source.trim().length < 15 || GENERIC.test(input.source.trim()) ||
          typeof input.validation !== "string" || input.validation.trim().length < 15 || GENERIC.test(input.validation.trim())) {
          errors.push(`WEAK PROVENANCE ${label}: each dynamic input needs expression, source (>=15 chars) and validation (>=15 chars)`);
          break;
        }
      }
    }
    byId.set(item.id, item);
  }

  const findingIds = new Set();
  let reviewed = 0;
  let autoVerified = 0;
  for (const f of findings) {
    if (findingIds.has(f.id)) errors.push(`AMBIGUOUS FINGERPRINT ${f.id} ${f.path}:${f.line}`);
    findingIds.add(f.id);
    const entry = byId.get(f.id);
    if (f.autoVerified) {
      autoVerified++;
      if (entry) errors.push(`UNNECESSARY APPROVAL ${f.id} ${f.path}:${f.line} — site is mechanically proven (${f.autoVerified}); remove the entry`);
      continue;
    }
    if (!entry) {
      errors.push(`UNREVIEWED ${f.kind} ${f.path}:${f.line} [${f.id}] dynamic: ${f.dynamicParts.join(" | ")}`);
      continue;
    }
    if (entry.path !== f.path || entry.kind !== f.kind || entry.context !== f.context) {
      errors.push(`APPROVAL MISMATCH ${f.id}: entry says ${entry.path}/${entry.kind}/${entry.context}, source is ${f.path}/${f.kind}/${f.context}`);
      continue;
    }
    if (Array.isArray(entry.dynamicInputs)) {
      const documented = new Set(entry.dynamicInputs.map((i) => i?.expression));
      const actual = new Set(f.dynamicParts);
      const undocumented = [...actual].filter((x) => !documented.has(x));
      const extra = [...documented].filter((x) => !actual.has(x));
      if (undocumented.length || extra.length) {
        errors.push(`PROVENANCE DRIFT ${f.id} ${f.path}:${f.line} undocumented: [${undocumented.join(" | ")}] no-longer-present: [${extra.join(" | ")}]`);
        continue;
      }
    }
    reviewed++;
  }
  for (const id of byId.keys()) if (!findingIds.has(id)) errors.push(`STALE APPROVAL ${id} (${byId.get(id).path}) — the reviewed site was removed or changed`);
  return { errors, reviewed, autoVerified, outstanding: findings.length - reviewed - autoVerified, byId };
}

export function buildRegister(findings, allowlist, meta = {}) {
  const entries = Array.isArray(allowlist) ? allowlist : allowlist?.entries ?? [];
  const byId = new Map(entries.filter((e) => e && e.id).map((e) => [e.id, e]));
  const out = findings.map((f, i) => {
    const e = byId.get(f.id);
    let disposition;
    if (f.autoVerified) disposition = `auto-verified:${f.autoVerified}`;
    else if (e) disposition = `reviewed:${e.classification}`;
    else disposition = "UNRESOLVED";
    return {
      findingId: `RSQL-${String(i + 1).padStart(4, "0")}`,
      id: f.id,
      path: f.path,
      line: f.line,
      category: f.kind,
      sink: f.sink,
      context: f.context,
      dynamicInputs: e?.dynamicInputs ?? f.dynamicParts.map((expression) => ({ expression })),
      userControlled: e?.userControlled ?? (f.autoVerified ? "no" : "unknown"),
      validation: f.autoVerified
        ? (f.autoVerified === "static" ? "All dynamic parts proven literal/const by the scanner" :
          f.autoVerified === "plpgsql-quoted-format" ? "format() with %I/%L quoting only" : f.autoVerified)
        : e?.dynamicInputs?.map((x) => x.validation).join(" / ") ?? null,
      parameterization: f.kind === "dynamic-identifier" ? "identifier quoted by sql.identifier" :
        f.autoVerified ? "no dynamic value in SQL text" : "dynamic text reviewed (values bound separately)",
      risk: disposition === "UNRESOLVED" ? "high" : e?.userControlled === "yes-validated" ? "medium (validated)" : "low",
      requiredAction: disposition === "UNRESOLVED" ? "review or remediate" : "none",
      reviewStatus: disposition === "UNRESOLVED" ? "open" : "closed",
      disposition,
      reason: e?.reason ?? null,
    };
  });
  const byCategory = {};
  const byDisposition = {};
  for (const f of out) {
    byCategory[f.category] = (byCategory[f.category] ?? 0) + 1;
    const d = f.disposition.split(":")[0];
    byDisposition[d] = (byDisposition[d] ?? 0) + 1;
  }
  return {
    generatedBy: "node scripts/verify-raw-sql-allowlist.mjs --write-register",
    summary: {
      scannedFiles: meta.scannedFiles, perRoot: meta.perRoot, totalSites: out.length,
      byCategory, byDisposition,
      userControlledValidated: out.filter((f) => f.userControlled === "yes-validated").length,
      unresolved: out.filter((f) => f.disposition === "UNRESOLVED").length,
    },
    findings: out,
  };
}

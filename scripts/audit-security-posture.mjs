#!/usr/bin/env node
/**
 * audit-security-posture.mjs
 *
 * Phase 0 security scorecard. Reads source and environment policy (no network,
 * no database) and reports whether the documented controls are present and
 * correctly configured for the current process environment.
 *
 * Usage:
 *   npm run audit:security-posture
 *   node scripts/audit-security-posture.mjs --json
 *   node scripts/audit-security-posture.mjs --strict   # exit 1 on any FAIL
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");
const strict = process.argv.includes("--strict");

function readText(relativePath) {
  const absolute = path.join(projectRoot, relativePath);
  if (!fs.existsSync(absolute)) return null;
  return fs.readFileSync(absolute, "utf8");
}

function check(id, status, detail, evidence = []) {
  return { id, status, detail, evidence };
}

function evaluate() {
  const checks = [];
  const nodeEnv = process.env.NODE_ENV ?? "development";
  const isProduction = nodeEnv === "production";

  // --- Session cookie policy (source) ---
  const sessionSource = readText("server/startup/sessionMiddleware.ts") ?? "";
  const cookiePolicySource = readText("server/services/security/sessionCookiePolicy.ts") ?? "";

  const httpOnlyTrue = /httpOnly:\s*true/.test(sessionSource);
  checks.push(
    check(
      "session.httpOnly",
      httpOnlyTrue ? "PASS" : "FAIL",
      httpOnlyTrue
        ? "Session cookie sets httpOnly: true."
        : "Session cookie does not set httpOnly: true in sessionMiddleware.ts.",
      ["server/startup/sessionMiddleware.ts"]
    )
  );

  const hasSecurePolicy =
    /secure:\s*[\s\S]*NODE_ENV\s*===\s*[\"']production[\"']/.test(sessionSource) ||
    /secure:\s*process\.env\.NODE_ENV\s*===\s*[\"']production[\"']/.test(sessionSource);
  checks.push(
    check(
      "session.secure",
      hasSecurePolicy ? "PASS" : "FAIL",
      hasSecurePolicy
        ? "Session cookie enables secure in production (and Replit/Capacitor paths)."
        : "Could not confirm production secure-cookie policy in sessionMiddleware.ts.",
      ["server/startup/sessionMiddleware.ts"]
    )
  );

  const hasSameSite =
    /sameSite:\s*process\.env\.CAPACITOR_ENABLED\s*===\s*[\"']true[\"']\s*\?\s*[\"']none[\"']\s*:\s*[\"']lax[\"']/.test(
      sessionSource
    ) || /sameSite:\s*[\"']lax[\"']/.test(sessionSource);
  checks.push(
    check(
      "session.sameSite",
      hasSameSite ? "PASS" : "WARN",
      hasSameSite
        ? "SameSite is lax by default and none when CAPACITOR_ENABLED=true."
        : "Could not confirm SameSite policy; review sessionMiddleware.ts.",
      ["server/startup/sessionMiddleware.ts"]
    )
  );

  const namedCookie =
    cookiePolicySource.includes("erp.session") || sessionSource.includes("SESSION_COOKIE_NAME");
  checks.push(
    check(
      "session.cookieName",
      namedCookie ? "PASS" : "WARN",
      namedCookie
        ? "Canonical session cookie name is centralized (erp.session)."
        : "Session cookie name policy file missing or not referenced.",
      ["server/services/security/sessionCookiePolicy.ts"]
    )
  );

  const sessionSecretRequired =
    /SESSION_SECRET/.test(sessionSource) &&
    /NODE_ENV\s*===\s*[\"']production[\"']/.test(sessionSource) &&
    /process\.exit\(1\)/.test(sessionSource);
  checks.push(
    check(
      "session.secretRequiredInProduction",
      sessionSecretRequired ? "PASS" : "FAIL",
      sessionSecretRequired
        ? "Missing SESSION_SECRET exits the process in production."
        : "Production SESSION_SECRET hard-fail not found in sessionMiddleware.ts.",
      ["server/startup/sessionMiddleware.ts"]
    )
  );

  // --- CSRF ---
  const csrfSource = readText("server/security/csrfProtection.ts") ?? "";
  const originGuardSource = readText("server/security/originGuard.ts") ?? "";

  const csrfDefaultEnforce = /CSRF_ENFORCE\s*=\s*process\.env\.CSRF_ENFORCE\s*!==\s*[\"']0[\"']/.test(
    csrfSource
  );
  checks.push(
    check(
      "csrf.defaultEnforce",
      csrfDefaultEnforce ? "PASS" : "FAIL",
      csrfDefaultEnforce
        ? "CSRF synchronizer token enforces by default (CSRF_ENFORCE !== \"0\")."
        : "CSRF default enforcement expression not found.",
      ["server/security/csrfProtection.ts"]
    )
  );

  const csrfProductionLock =
    /CSRF_ALLOW_WARN_ONLY_IN_PRODUCTION/.test(csrfSource) &&
    /NODE_ENV\s*===\s*[\"']production[\"']/.test(csrfSource);
  checks.push(
    check(
      "csrf.productionHardFail",
      csrfProductionLock ? "PASS" : "FAIL",
      csrfProductionLock
        ? "Production refuses CSRF warn-only unless CSRF_ALLOW_WARN_ONLY_IN_PRODUCTION=1."
        : "Production CSRF warn-only lock not present — apply the Phase 0 csrfProtection.ts patch.",
      ["server/security/csrfProtection.ts"]
    )
  );

  const originGuardPresent =
    originGuardSource.length > 0 &&
    (/origin/i.test(originGuardSource) || /referer/i.test(originGuardSource));
  checks.push(
    check(
      "csrf.originGuard",
      originGuardPresent ? "PASS" : "FAIL",
      originGuardPresent
        ? "Origin/Referer guard module is present."
        : "server/security/originGuard.ts missing or empty.",
      ["server/security/originGuard.ts"]
    )
  );

  // Runtime CSRF mode for this process
  const csrfEnforceEnv = process.env.CSRF_ENFORCE;
  const csrfWarnOnly = csrfEnforceEnv === "0";
  const allowWarnOnlyInProd = process.env.CSRF_ALLOW_WARN_ONLY_IN_PRODUCTION === "1";
  if (isProduction && csrfWarnOnly && !allowWarnOnlyInProd) {
    checks.push(
      check(
        "csrf.runtimeProductionMode",
        "FAIL",
        "Production process has CSRF_ENFORCE=0 without CSRF_ALLOW_WARN_ONLY_IN_PRODUCTION=1.",
        ["process.env"]
      )
    );
  } else if (csrfWarnOnly) {
    checks.push(
      check(
        "csrf.runtimeProductionMode",
        "WARN",
        "CSRF is in warn-only mode (CSRF_ENFORCE=0). Acceptable only outside production or with explicit escape hatch.",
        ["process.env"]
      )
    );
  } else {
    checks.push(
      check(
        "csrf.runtimeProductionMode",
        "PASS",
        "CSRF runtime mode is enforcing for this process.",
        ["process.env"]
      )
    );
  }

  // --- Security headers / CSP ---
  const headersSource = readText("server/security/securityHeaders.ts") ?? "";
  const hasHelmet = /from\s+[\"']helmet[\"']/.test(headersSource);
  const hasProductionScriptSrc =
    /scriptSrc:\s*isProduction\s*\?\s*\[\s*[\"']'self'[\"']\s*\]/.test(headersSource) ||
    /scriptSrc:[\s\S]*isProduction[\s\S]*[\"']'self'[\"']/.test(headersSource);
  checks.push(
    check(
      "headers.helmetCsp",
      hasHelmet && hasProductionScriptSrc ? "PASS" : "FAIL",
      hasHelmet && hasProductionScriptSrc
        ? "Helmet CSP present; production script-src is self-only."
        : "Helmet CSP / production script-src policy not confirmed.",
      ["server/security/securityHeaders.ts"]
    )
  );

  // --- Rate limiting ---
  const apiRateSource = readText("server/middleware/apiRateLimit.ts") ?? "";
  const privilegedSource = readText("server/middleware/privilegedEndpointSecurity.ts") ?? "";
  checks.push(
    check(
      "rateLimit.global",
      /express-rate-limit/.test(apiRateSource) ? "PASS" : "FAIL",
      /express-rate-limit/.test(apiRateSource)
        ? "Global API rate limiter is present."
        : "apiRateLimit.ts missing express-rate-limit usage.",
      ["server/middleware/apiRateLimit.ts"]
    )
  );
  checks.push(
    check(
      "rateLimit.privileged",
      /privilegedMutationRateLimit/.test(privilegedSource) ? "PASS" : "FAIL",
      /privilegedMutationRateLimit/.test(privilegedSource)
        ? "Privileged mutation rate limit is present."
        : "privilegedEndpointSecurity.ts missing privileged mutation limiter.",
      ["server/middleware/privilegedEndpointSecurity.ts"]
    )
  );

  // --- Permissions V2 activation state (env + docs) ---
  const createOnlyAssignment = process.env.PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT;
  const createOnlyEnabled =
    typeof createOnlyAssignment === "string" &&
    ["1", "true", "enabled", "on", "yes"].includes(createOnlyAssignment.toLowerCase());
  checks.push(
    check(
      "permissionsV2.createOnlyAssignment",
      createOnlyEnabled ? "WARN" : "PASS",
      createOnlyEnabled
        ? "PERMISSIONS_V2_CREATE_ONLY_ASSIGNMENT is enabled in this process. Confirm release gates before production use."
        : "Create Only assignment switch is off (shadow / not activated) — expected for Phase 0.",
      ["process.env", "docs/permissions-control-center-activation.md"]
    )
  );

  // --- Documentation discoverability ---
  const postureDoc = readText("docs/security-posture.md");
  const docsReadme = readText("docs/README.md") ?? "";
  checks.push(
    check(
      "docs.securityPosture",
      postureDoc ? "PASS" : "FAIL",
      postureDoc
        ? "docs/security-posture.md exists."
        : "docs/security-posture.md is missing.",
      ["docs/security-posture.md"]
    )
  );
  const linkedFromReadme =
    docsReadme.includes("security-posture.md") || docsReadme.includes("(security-posture.md)");
  checks.push(
    check(
      "docs.readmeLink",
      linkedFromReadme ? "PASS" : "FAIL",
      linkedFromReadme
        ? "docs/README.md links to security-posture.md."
        : "docs/README.md does not yet link to security-posture.md (required by doc-index audit).",
      ["docs/README.md"]
    )
  );

  // --- Accepted risk documentation ---
  const privacyDoc = readText("docs/security-privacy.md") ?? "";
  const xlsxDocumented = /xlsx/i.test(privacyDoc) || (postureDoc ? /xlsx/i.test(postureDoc) : false);
  checks.push(
    check(
      "risks.xlsxDocumented",
      xlsxDocumented ? "PASS" : "WARN",
      xlsxDocumented
        ? "xlsx accepted risk is documented."
        : "xlsx accepted risk not found in security-privacy.md or security-posture.md.",
      ["docs/security-privacy.md", "docs/security-posture.md"]
    )
  );

  const pass = checks.filter((c) => c.status === "PASS").length;
  const warn = checks.filter((c) => c.status === "WARN").length;
  const fail = checks.filter((c) => c.status === "FAIL").length;

  return {
    generatedAt: new Date().toISOString(),
    nodeEnv,
    isProduction,
    summary: { total: checks.length, pass, warn, fail },
    checks,
  };
}

const report = evaluate();

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(
    `Security posture: ${report.summary.pass} pass, ${report.summary.warn} warn, ${report.summary.fail} fail (${report.summary.total} checks) — NODE_ENV=${report.nodeEnv}`
  );
  for (const item of report.checks) {
    const mark = item.status === "PASS" ? "✓" : item.status === "WARN" ? "!" : "✗";
    console.log(`  ${mark} [${item.status}] ${item.id}: ${item.detail}`);
  }
  if (report.summary.fail === 0 && report.summary.warn === 0) {
    console.log("\nPhase 0 scorecard is clean.");
  } else if (report.summary.fail === 0) {
    console.log("\nNo failures. Review warnings before treating posture as complete.");
  } else {
    console.log("\nFailures must be fixed for Phase 0 completion.");
  }
}

if (strict && report.summary.fail > 0) process.exit(1);
if (!strict && report.summary.fail > 0) process.exitCode = 1;

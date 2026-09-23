#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import puppeteer from "puppeteer";

const BASE_URL = String(
  process.env.ERP_PERF_CERT_BASE_URL ||
    process.env.ERP_BANDWIDTH_SMOKE_BASE_URL ||
    ""
).replace(/\/$/, "");
const USERNAME =
  process.env.ERP_PERF_CERT_USERNAME ||
  process.env.ERP_BANDWIDTH_SMOKE_USERNAME ||
  "";
const PASSWORD =
  process.env.ERP_PERF_CERT_PASSWORD ||
  process.env.ERP_BANDWIDTH_SMOKE_PASSWORD ||
  "";
const ROUTES = String(process.env.ERP_PERF_CERT_ROUTES || "/financial-overview")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean)
  .map((value) => (value.startsWith("/") ? value : "/" + value));
const TIMEOUT_MS = finiteEnv("ERP_PERF_CERT_TIMEOUT_MS", 45_000, 5_000);
const MIN_TOTAL_SAMPLES = finiteEnv("ERP_PERF_CERT_MIN_TOTAL_SAMPLES", 10, 1);
const MIN_ROUTE_SAMPLES = finiteEnv("ERP_PERF_CERT_MIN_ROUTE_SAMPLES", 3, 1);
const MAX_ERROR_PERCENT = finiteEnv("ERP_PERF_CERT_MAX_ERROR_PERCENT", 1, 0);
const MAX_RSS_MB = optionalFiniteEnv("ERP_PERF_CERT_MAX_RSS_MB", 1);
const MAX_OVERALL_P95_MS = optionalFiniteEnv("ERP_PERF_CERT_MAX_OVERALL_P95_MS", 1);
const OUTPUT_DIR = path.resolve(
  process.env.ERP_PERF_CERT_OUTPUT_DIR || "artifacts/performance-wave5"
);

if (!BASE_URL) {
  throw new Error("ERP_PERF_CERT_BASE_URL is required.");
}
if (!USERNAME || !PASSWORD) {
  throw new Error(
    "ERP_PERF_CERT_USERNAME and ERP_PERF_CERT_PASSWORD are required. Use a non-production Admin/Developer test account."
  );
}

function finiteEnv(name, fallback, minimum) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.max(minimum, value) : fallback;
}

function optionalFiniteEnv(name, minimum) {
  if (!process.env[name]) return null;
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < minimum) {
    throw new Error(name + " must be a finite number >= " + minimum + ".");
  }
  return value;
}

async function settle(page) {
  await new Promise((resolve) => setTimeout(resolve, 1_250));
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
}

async function login(page) {
  await page.goto(BASE_URL + "/login", {
    waitUntil: "networkidle2",
    timeout: TIMEOUT_MS,
  });
  await page.waitForSelector('[data-testid="input-username"]', {
    visible: true,
    timeout: TIMEOUT_MS,
  });
  await page.type('[data-testid="input-username"]', USERNAME);
  await page.type('[data-testid="input-password"]', PASSWORD);
  await page.click('[data-testid="button-login"]');
  await page.waitForFunction(
    () =>
      window.location.pathname !== "/login" &&
      Boolean(document.getElementById("main-content")),
    { timeout: TIMEOUT_MS }
  );
  await settle(page);
}

async function measureNavigation(page, route) {
  const response = await page.goto(BASE_URL + route, {
    waitUntil: "networkidle2",
    timeout: TIMEOUT_MS,
  });
  await settle(page);
  const browser = await page.evaluate(() => {
    const navigation = performance.getEntriesByType("navigation")[0];
    const resources = performance.getEntriesByType("resource");
    const transferBytes = resources.reduce(
      (sum, entry) => sum + Number(entry.transferSize || 0),
      0
    );
    const decodedBytes = resources.reduce(
      (sum, entry) => sum + Number(entry.decodedBodySize || 0),
      0
    );
    const apiRequests = resources.filter((entry) => {
      try {
        return new URL(entry.name).pathname.startsWith("/api/");
      } catch {
        return false;
      }
    }).length;
    return {
      navigation: navigation
        ? {
            domContentLoadedMs: Math.round(navigation.domContentLoadedEventEnd),
            loadEventMs: Math.round(navigation.loadEventEnd),
            transferSize: Number(navigation.transferSize || 0),
            decodedBodySize: Number(navigation.decodedBodySize || 0),
          }
        : null,
      resourceCount: resources.length,
      apiRequests,
      transferBytes,
      decodedBytes,
    };
  });
  return {
    route,
    status: response ? response.status() : null,
    url: page.url(),
    browser,
  };
}

async function fetchJson(page, route) {
  return page.evaluate(async (pathName) => {
    const response = await fetch(pathName, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const text = await response.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return {
      ok: response.ok,
      status: response.status,
      body,
      textPreview: body ? null : text.slice(0, 500),
    };
  }, route);
}

function routeLabel(row) {
  return String(row.method || "GET") + " " + String(row.route || "<unknown>");
}

function writeMarkdown(report) {
  const snapshot = report.performanceSnapshot || {};
  const summary = snapshot.summary || {};
  const lines = [
    "# Wave 5 Production Performance Certification",
    "",
    "- Base URL: " + report.baseUrl,
    "- Finished: " + report.finishedAt,
    "- Result: **" + (report.failures.length ? "FAIL" : "PASS") + "**",
    "- Performance window: " + String(snapshot.windowMinutes || "?") + " minutes",
    "- Requests sampled: " + String(summary.requests ?? "?"),
    "- Overall p95: " + String(summary.p95Ms ?? "?") + " ms",
    "- Error rate: " + String(summary.errorPercent ?? "?") + "%",
    "- RSS: " + String(snapshot.memoryMb?.rss ?? "?") + " MB",
    "- DB pool waiting: " + String(snapshot.databasePool?.waiting ?? "?"),
    "",
    "## Page measurements",
    "",
  ];
  for (const page of report.pages) {
    lines.push(
      "- " +
        page.route +
        ": first load " +
        String(page.first.browser.navigation?.loadEventMs ?? "?") +
        " ms, repeat load " +
        String(page.repeat.browser.navigation?.loadEventMs ?? "?") +
        " ms, repeat transfer " +
        String(page.repeat.browser.transferBytes ?? "?") +
        " bytes"
    );
  }
  lines.push("", "## Budget breaches", "");
  if (report.qualifyingBudgetBreaches.length === 0) {
    lines.push("- None at the configured minimum sample count.");
  } else {
    for (const row of report.qualifyingBudgetBreaches) {
      lines.push(
        "- " +
          routeLabel(row) +
          ": " +
          row.budgetBreaches.join(", ") +
          " (count=" +
          row.count +
          ", p95=" +
          row.p95Ms +
          " ms, avg DB=" +
          row.averageDbMs +
          " ms, avg queries=" +
          row.averageDbQueries +
          ")"
      );
    }
  }
  lines.push("", "## Warnings", "");
  if (report.warnings.length === 0) lines.push("- None.");
  else for (const warning of report.warnings) lines.push("- " + warning);
  lines.push("", "## Failures", "");
  if (report.failures.length === 0) lines.push("- None.");
  else for (const failure of report.failures) lines.push("- " + failure);
  return lines.join("\n") + "\n";
}

await fs.mkdir(OUTPUT_DIR, { recursive: true });

const report = {
  baseUrl: BASE_URL,
  routes: ROUTES,
  startedAt: new Date().toISOString(),
  thresholds: {
    minTotalSamples: MIN_TOTAL_SAMPLES,
    minRouteSamples: MIN_ROUTE_SAMPLES,
    maxErrorPercent: MAX_ERROR_PERCENT,
    maxRssMb: MAX_RSS_MB,
    maxOverallP95Ms: MAX_OVERALL_P95_MS,
  },
  pages: [],
  health: {},
  performanceSnapshot: null,
  qualifyingBudgetBreaches: [],
  browserErrors: [],
  warnings: [],
  failures: [],
};

const browser = await puppeteer.launch({
  headless: true,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
});

try {
  const page = await browser.newPage();
  page.setDefaultTimeout(TIMEOUT_MS);
  page.setDefaultNavigationTimeout(TIMEOUT_MS);
  await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });

  page.on("pageerror", (error) => {
    report.browserErrors.push("pageerror: " + error.message);
  });
  page.on("requestfailed", (request) => {
    if (!["document", "script", "stylesheet"].includes(request.resourceType())) return;
    const errorText = request.failure()?.errorText || "unknown";
    if (errorText === "net::ERR_ABORTED") return;
    report.browserErrors.push(
      request.resourceType() + " request failed: " + request.url() + " (" + errorText + ")"
    );
  });

  await login(page);

  for (const route of ROUTES) {
    const first = await measureNavigation(page, route);
    const repeat = await measureNavigation(page, route);
    report.pages.push({ route, first, repeat });
    if (first.status !== 200) {
      report.failures.push(route + " first navigation returned HTTP " + String(first.status) + ".");
    }
    if (repeat.status !== 200) {
      report.failures.push(route + " repeat navigation returned HTTP " + String(repeat.status) + ".");
    }
  }

  const [ready, db, performance] = await Promise.all([
    fetchJson(page, "/api/health/ready"),
    fetchJson(page, "/api/health/db"),
    fetchJson(page, "/api/health/performance.json"),
  ]);

  report.health.ready = ready;
  report.health.db = db;

  if (!ready.ok) {
    report.failures.push("/api/health/ready returned HTTP " + ready.status + ".");
  }
  if (!db.ok) {
    report.failures.push("/api/health/db returned HTTP " + db.status + ".");
  }
  if (!performance.ok || !performance.body) {
    report.failures.push(
      "/api/health/performance.json returned HTTP " +
        performance.status +
        ". The account must have Admin or Developer access."
    );
  } else {
    report.performanceSnapshot = performance.body;
    const snapshot = performance.body;
    const summary = snapshot.summary || {};
    const requestCount = Number(summary.requests || 0);
    const errorPercent = Number(summary.errorPercent || 0);
    const overallP95 = Number(summary.p95Ms || 0);
    const rssMb = Number(snapshot.memoryMb?.rss || 0);
    const waiting = Number(snapshot.databasePool?.waiting || 0);
    const breaches = Array.isArray(snapshot.budgetBreaches)
      ? snapshot.budgetBreaches
      : [];

    if (requestCount < MIN_TOTAL_SAMPLES) {
      report.failures.push(
        "Only " +
          requestCount +
          " requests were present in the performance window; at least " +
          MIN_TOTAL_SAMPLES +
          " are required for certification."
      );
    }
    if (errorPercent > MAX_ERROR_PERCENT) {
      report.failures.push(
        "Performance-window 5xx rate is " +
          errorPercent +
          "%, above the " +
          MAX_ERROR_PERCENT +
          "% certification ceiling."
      );
    }
    if (MAX_OVERALL_P95_MS !== null && overallP95 > MAX_OVERALL_P95_MS) {
      report.failures.push(
        "Overall p95 is " +
          overallP95 +
          " ms, above ERP_PERF_CERT_MAX_OVERALL_P95_MS=" +
          MAX_OVERALL_P95_MS +
          "."
      );
    }
    if (MAX_RSS_MB !== null && rssMb > MAX_RSS_MB) {
      report.failures.push(
        "RSS is " +
          rssMb +
          " MB, above ERP_PERF_CERT_MAX_RSS_MB=" +
          MAX_RSS_MB +
          "."
      );
    }
    if (waiting > 0) {
      report.warnings.push(
        "Database pool reports " + waiting + " waiting connection(s) at snapshot time."
      );
    }

    report.qualifyingBudgetBreaches = breaches.filter(
      (row) => Number(row.count || 0) >= MIN_ROUTE_SAMPLES
    );
    for (const row of report.qualifyingBudgetBreaches) {
      report.failures.push(
        routeLabel(row) +
          " breached existing production budget(s): " +
          row.budgetBreaches.join(", ") +
          "."
      );
    }
  }

  report.failures.push(...report.browserErrors);
  report.failures = [...new Set(report.failures)];
  report.warnings = [...new Set(report.warnings)];
  await page.close();
} finally {
  await browser.close();
}

report.finishedAt = new Date().toISOString();

await fs.writeFile(
  path.join(OUTPUT_DIR, "report.json"),
  JSON.stringify(report, null, 2) + "\n"
);
await fs.writeFile(
  path.join(OUTPUT_DIR, "summary.md"),
  writeMarkdown(report)
);

if (report.failures.length > 0) {
  console.error(
    "Wave 5 production performance certification failed with " +
      report.failures.length +
      " issue(s):"
  );
  for (const failure of report.failures) console.error("- " + failure);
  console.error("Report: " + path.join(OUTPUT_DIR, "report.json"));
  process.exit(1);
}

console.log(
  "Wave 5 production performance certification passed: health, authenticated browser load, live performance window, and existing route budgets are within policy."
);
console.log("Report: " + path.join(OUTPUT_DIR, "report.json"));

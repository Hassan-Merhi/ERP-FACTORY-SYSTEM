/**
 * Phase 4 Factory theme browser matrix. Run against a local Vite preview
 * after a production build; API data is intercepted with synthetic fixtures.
 *
 * npm ci && npm run build
 * npx puppeteer browsers install chrome-headless-shell
 * npx vite preview --host 127.0.0.1 --port 4174
 * FACTORY_QA_CHROME_PATH=/path/to/chrome-headless-shell node tests/e2e/factory-theme-responsive-phase4.mjs
 *
 * This is an empty-state responsive test, NOT a production-data or authenticated
 * mobile/tablet screenshot certification. No real user data is accessed.
 */
import puppeteer from "puppeteer";
import { mkdir } from "node:fs/promises";

const baseUrl = process.env.FACTORY_QA_BASE_URL || "http://127.0.0.1:4174";
const chromePath = process.env.FACTORY_QA_CHROME_PATH || undefined;
const screenshotDir = process.env.FACTORY_QA_SCREENSHOT_DIR || "/tmp/factory-phase4-screenshots";
const browser = await puppeteer.launch({
  headless: true,
  ...(chromePath ? { executablePath: chromePath } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage();
await page.setBypassServiceWorker(true);
await page.evaluateOnNewDocument(() => {
  localStorage.setItem("theme", new URLSearchParams(location.search).get("qaTheme") || "light");
  localStorage.setItem("selectedCompanyId", "1");
});

const productionReport = {
  from: null, to: null, costsHidden: false, valuationMode: "cost",
  summary: {
    batchCost: 0, weightCost: 0, productionValue: 0, statusValue: 0, costValue: 0,
    sellingValue: 0, remainingMaterialValue: 0, consumedMaterialCost: 0, profitValue: 0,
    profitMarginPct: 0, missingSelectedPriceBales: 0, missingCostPriceBales: 0,
    missingSellingPriceBales: 0,
  },
  production: { totalBales: 0, totalWeightKg: 0, totalValue: 0, byProduct: [], byCategory: [] },
  wipersGarbage: {
    totalWipersQty: 0, totalWipersKg: 0, totalGarbageQty: 0, totalGarbageKg: 0,
    totalWeightKg: 0, totalValue: 0, rows: [], products: [],
  },
  rawMaterial: { totalBatches: 0, totalWeightKg: 0, totalCost: 0, blendedCostPerKg: 0, batches: [] },
  balanceOnTable: { weightKg: 0, costPerKg: 0, value: 0 },
  filteredBalanceOnTable: { weightKg: 0, netChangeKg: 0, direction: "unchanged", costPerKg: 0, value: 0 },
  kgComparison: { producedKg: 0, mixedKg: 0, diffKg: 0, diffLabel: "" },
};
const salarySummary = {
  currentDay: 1, daysInMonth: 30, totalWorkerBaseSalary: 0, totalWorkerTransport: 0,
  totalWorkerPaid: 0, totalEmployeeMonthlySalary: 0, totalEmployeeBalance: 0,
  workerBreakdown: [], employeeBreakdown: [],
};
await page.setRequestInterception(true);
page.on("request", (request) => {
  const path = new URL(request.url()).pathname;
  if (!path.startsWith("/api/")) {
    void request.continue().catch(() => {});
    return;
  }
  let result = [];
  if (path === "/api/auth/me") {
    result = { id: 1, username: "qa-admin", role: "Admin", currentCompanyId: 1, active: true };
  } else if (path === "/api/user/companies") {
    result = [{
      companyId: 1, companyCode: "FACTORY-QA", companyName: "Factory QA Fixture",
      companyType: "factory", companyActive: true, role: "Admin",
    }];
  } else if (path === "/api/auth/session-company") {
    result = { companyId: 1 };
  } else if (path === "/api/factory/my-access") {
    result = {
      fullAccess: true, hasFactoryAccess: true, hasErpAccess: true,
      companyId: 1, companyName: "Factory QA Fixture", pageKeys: [], hiddenCostFields: [],
    };
  } else if (path === "/api/factory/settings") {
    result = {};
  } else if (path === "/api/locations") {
    result = [{ id: 1, name: "QA Test Location", companyId: 1, active: true }];
  } else if (path === "/api/factory/production-value-report") {
    result = productionReport;
  } else if (path === "/api/factory/workers/attendance-report") {
    result = { dates: [], workers: [] };
  } else if (path === "/api/factory/monthly-salary-summary") {
    result = salarySummary;
  } else if (path.endsWith("unread-count") || path.includes("count") || path.includes("summary")) {
    result = { count: 0 };
  }
  void request.respond({ status: 200, contentType: "application/json", body: JSON.stringify(result) }).catch(() => {});
});

const routes = [
  "/factory/location-inventory",
  "/factory/invoicing",
  "/factory/parties?tab=suppliers",
  "/factory/production-report",
  "/factory/containers-hub",
  "/factory/payroll-hub?section=workers&tab=workers",
];
const results = [];
await mkdir(screenshotDir, { recursive: true });
try {
  for (const width of [390, 768, 1440]) {
    for (const theme of ["light", "dark"]) {
      await page.setViewport({ width, height: width === 390 ? 844 : 900, deviceScaleFactor: 1 });
      for (const route of routes) {
        const separator = route.includes("?") ? "&" : "?";
        const url = baseUrl + route + separator + "qaTheme=" + theme;
        let navigationError = null;
        try {
          await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        } catch (error) {
          navigationError = String(error);
        }
        await new Promise((resolve) => setTimeout(resolve, 2100));
        const state = await page.evaluate(() => {
          const text = document.body.innerText;
          return {
            appShell: document.documentElement.dataset.appShell || null,
            activeTheme: document.documentElement.classList.contains("dark") ? "dark" : "light",
            viewportWidth: innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            errorScreen: text.includes("Something went wrong on this page") ||
              text.includes("Application loading took too long"),
            pageTextLength: text.length,
          };
        });
        const passed = !navigationError &&
          state.appShell === "factory" && state.activeTheme === theme &&
          state.viewportWidth === width && state.documentWidth <= width && !state.errorScreen &&
          state.pageTextLength > 100;
        const name = route.split("?")[0].split("/").pop();
        await page.screenshot({ path: screenshotDir + "/" + name + "-" + width + "-" + theme + ".png" });
        const result = { route, width, theme, passed, ...state, navigationError };
        results.push(result);
        console.log("CASE " + JSON.stringify(result));
      }
    }
  }
  const passed = results.filter((result) => result.passed).length;
  console.log("SUMMARY " + JSON.stringify({ passed, total: results.length, screenshotDir }));
  if (passed !== results.length) process.exitCode = 1;
} finally {
  await browser.close();
}

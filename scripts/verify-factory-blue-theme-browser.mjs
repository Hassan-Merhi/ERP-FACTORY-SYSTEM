#!/usr/bin/env node
// Browser-rendered Factory palette contract. Run after npm run build.
// This is a CSS/UI fixture, not an authenticated full application E2E test.
import fs from "node:fs/promises";
import path from "node:path";
import puppeteer from "puppeteer";

const assetDir = path.resolve("dist/public/assets");
const outDir = path.resolve(process.env.FACTORY_THEME_QA_OUTPUT || "artifacts/factory-theme-phase4");
const prefixes = ["index-", "FactoryShell-", "ErpShell-", "PropertiesShell-", "FactoryLocationInventory-", "BaleStockEntry-", "DailyProductionReport-"];
const aliases = ["blue", "indigo", "purple", "violet", "sky", "fuchsia"];
const viewports = [
  { name: "phone-320", width: 320, height: 700 },
  { name: "phone-390", width: 390, height: 844 },
  { name: "tablet", width: 768, height: 1024 },
  { name: "desktop", width: 1440, height: 900 },
];
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };
const names = (await fs.readdir(assetDir)).filter((name) => name.endsWith(".css"));
const cssAssets = [...new Set([...prefixes.map((prefix) => names.find((name) => name.startsWith(prefix))).filter(Boolean), ...names])];
if (!cssAssets.some((name) => name.startsWith("index-")) || !cssAssets.some((name) => name.startsWith("FactoryShell-"))) {
  throw new Error("Missing compiled Factory CSS; run npm run build");
}
const css = await Promise.all(cssAssets.map((name) => fs.readFile(path.join(assetDir, name), "utf8")));
const swatches = aliases.map((name) => name === "fuchsia" ? '<div id="alias-fuchsia" class="h-11 rounded-md" style="background-color:var(--color-fuchsia-500)"></div>' : '<div id="alias-' + name + '" class="h-11 rounded-md bg-' + name + '-500"></div>').join("");
const html = '<!doctype html><html class="light" data-app-shell="factory"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head>' +
  '<body class="bg-background text-foreground"><main id="factory-qa-root" class="min-h-screen max-w-full space-y-4 bg-background p-3 sm:p-4 lg:p-6">' +
  '<header class="rounded-2xl border border-blue-200 bg-gradient-to-r from-blue-50 via-indigo-50 to-violet-50 p-4 dark:border-blue-500/30 dark:from-blue-950 dark:via-blue-900 dark:to-blue-800"><h1 class="text-xl font-bold text-foreground">Factory browser QA fixture</h1><p class="text-sm text-foreground">Blue Factory palette, dark mode, and responsive cards.</p></header>' +
  '<section class="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">' +
  '<article id="fixture-card" class="min-w-0 rounded-2xl border border-violet-200 bg-gradient-to-br from-violet-50 via-white to-fuchsia-100/80 p-4 dark:border-violet-500/50 dark:from-[hsl(var(--factory-hue)_45%_30%)] dark:via-[hsl(var(--factory-hue)_39%_23%)] dark:to-[hsl(var(--factory-hue)_38%_18%)]"><h2 class="font-semibold text-foreground">Customer Loading</h2><p class="text-sm text-foreground">Actual Factory card styling.</p></article>' +
  '<article class="min-w-0 rounded-2xl border bg-card p-4"><h2 class="mb-2 font-semibold text-foreground">Legacy palette aliases</h2><div class="grid grid-cols-3 gap-2">' + swatches + '</div></article>' +
  '<article id="fixture-shadow" class="min-w-0 rounded-2xl border bg-card p-4 shadow-[0_12px_30px_-22px_hsl(var(--factory-hue)_89%_48%_/_0.5)]"><h2 class="font-semibold text-foreground">Pressing shadow</h2><div id="fixture-stripes" class="factory-container-stripes mt-3 h-20 rounded-lg"></div></article></section>' +
  '<section class="flex min-w-0 flex-wrap gap-2 bg-card p-3"><button id="tap-target" class="min-h-11 rounded-lg bg-blue-700 px-5 text-white">Factory action</button><div id="status-green" class="h-11 w-11 bg-green-500"></div><div id="status-red" class="h-11 w-11 bg-red-500"></div><div id="status-amber" class="h-11 w-11 bg-amber-500"></div></section></main>' +
  '<aside id="portal" class="mx-3 mb-3 rounded-lg border bg-card p-3"><div id="portal-blue" class="h-11 w-11 rounded-lg bg-purple-500"></div><p class="text-foreground">Portalled dialog outside the Factory workspace</p></aside></body></html>';
await fs.mkdir(outDir, { recursive: true });
const browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
const report = { baseline: "compiled CSS", modes: ["light", "dark"], viewports, screenshotFolder: outDir, cases: [], failures };
try {
  const page = await browser.newPage();
  async function load(shell, mode) {
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    for (const content of css) await page.addStyleTag({ content });
    await page.evaluate((shell, mode) => { document.documentElement.dataset.appShell = shell; document.documentElement.className = mode; }, shell, mode);
  }
  async function observe() {
    return page.evaluate((aliases) => {
      const el = (id) => document.getElementById(id);
      const style = (id) => getComputedStyle(el(id));
      return {
        hue: getComputedStyle(document.documentElement).getPropertyValue("--factory-hue").trim(),
        colors: aliases.map((name) => style("alias-" + name).backgroundColor),
        statuses: ["green", "red", "amber"].map((name) => style("status-" + name).backgroundColor),
        portal: style("portal-blue").backgroundColor,
        background: style("factory-qa-root").backgroundColor,
        card: style("fixture-card").backgroundImage,
        stripes: style("fixture-stripes").backgroundImage,
        shadow: style("fixture-shadow").boxShadow,
        tap: el("tap-target").getBoundingClientRect().height,
        overflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
        foreground: style("factory-qa-root").color,
      };
    }, aliases);
  }
  
  let lightBackground;
  for (const mode of ["light", "dark"]) {
    for (const viewport of viewports) {
      await page.setViewport({ ...viewport, isMobile: viewport.width < 800, hasTouch: viewport.width < 800, deviceScaleFactor: 1 });
      await load("factory", mode);
      const value = await observe();
      report.cases.push({ mode, viewport: viewport.name, ...value });
      const key = mode + "/" + viewport.name;
      const color = value.colors[0];
      check(value.hue === "217", key + ": Factory hue missing");
      check(value.colors.every((item) => item === color && item !== "rgba(0, 0, 0, 0)"), key + ": blue/violet aliases differ");
      check(value.portal === color, key + ": portalled colors differ");
      check(value.stripes.includes("repeating-linear-gradient"), key + ": container stripes not rendered");
      check(value.card.includes("gradient"), key + ": page card gradient missing");
      check(value.shadow !== "none" && !value.shadow.includes("168, 85, 247"), key + ": shadow missing or purple");
      check(value.tap >= 44, key + ": touch target too small");
      check(value.overflow <= 1, key + ": horizontal overflow " + value.overflow);
      if (viewport.name === "desktop") {
        if (mode === "light") { lightBackground = value.background; }
        else check(value.background !== lightBackground, "Light/dark background identical");
      }
      const screenshot = mode + "-" + viewport.name + ".png";
      await page.screenshot({ path: path.join(outDir, screenshot), fullPage: true });
      console.log(key + " hue=" + value.hue + " aliases=" + color + " overflow=" + value.overflow + " screenshot=" + screenshot);
      if (mode === "light" && viewport.name === "desktop") {
        await page.evaluate(() => { document.documentElement.style.setProperty("--factory-hue", "260"); });
        const after = await observe();
        check(after.colors[0] !== color && after.stripes !== value.stripes && after.shadow !== value.shadow, "Changing Factory hue did not recolor accents, artwork and shadows");
        check(after.statuses.every((status, index) => status === value.statuses[index]), "Changing Factory hue changed semantic status colors");
      }
    }
  }
  for (const shell of ["erp", "properties"]) {
    await page.setViewport({ width: 1024, height: 768 });
    await load(shell, "light");
    const value = await observe();
    check(!value.hue, shell + ": leaked Factory hue");
    check(value.colors[0] !== report.cases[0].colors[0], shell + ": Factory color leaked");
    console.log(shell + ": isolated (" + value.colors[0] + ")");
  }
} finally { await browser.close(); }
await fs.writeFile(path.join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
if (failures.length) {
  failures.forEach((item) => console.error("FAIL: " + item));
  process.exitCode = 1;
} else {
  console.log("PASS: 8 viewport/mode renderings, Factory hue change, portals and ERP/Properties isolation");
}
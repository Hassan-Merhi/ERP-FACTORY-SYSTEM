/**
 * Real-device workflow probes for the ERP phone remediation (items 1–14 of
 * docs/erp-mobile-program.md, "Real-device remediation").
 *
 * The route sweep in verify-erp-mobile-program.mjs proves each page loads without
 * overflow; these probes drive the phone workflows themselves: open the record, the
 * sheet or the dialog, and check that the phone representation is used and its
 * actions are reachable. A probe whose fixture data is missing is recorded as
 * skipped with the reason, never as passed.
 */

const VOUCHER_TYPES = ["payment", "receipt", "journal", "transfer", "transferorder", "adjustment", "creditnote"];

class SkipWorkflow extends Error {}

function createContext(page, { baseUrl, timeoutMs, settle }) {
  const failures = [];
  const notes = [];

  const visibleHandle = async (selector) => {
    const handles = await page.$$(selector);
    for (const handle of handles) {
      const box = await handle.boundingBox().catch(() => null);
      if (box && box.width > 0 && box.height > 0) return handle;
    }
    return null;
  };

  const ctx = {
    failures,
    notes,
    page,
    fail(message) {
      failures.push(message);
    },
    note(message) {
      notes.push(message);
    },
    skip(reason) {
      throw new SkipWorkflow(reason);
    },
    async goto(route) {
      await page.goto(`${baseUrl}${route}`, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await page.waitForFunction(() => Boolean(document.getElementById("main-content")), { timeout: timeoutMs });
      await settle(page, 1200);
    },
    async exists(selector, { timeout = 6000 } = {}) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        if (await visibleHandle(selector)) return true;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return false;
    },
    /** Real pointer tap on the first visible match; false when there is none. */
    async tap(selector, { timeout = 6000 } = {}) {
      if (!(await ctx.exists(selector, { timeout }))) return false;
      const handle = await visibleHandle(selector);
      await handle.evaluate((el) => el.scrollIntoView({ block: "center", inline: "nearest" }));
      await settle(page, 150);
      await handle.click();
      await settle(page, 700);
      return true;
    },
    async require(selector, message, options) {
      if (!(await ctx.exists(selector, options))) ctx.fail(message ?? `missing ${selector}`);
    },
    async type(selector, text) {
      await page.click(selector);
      await page.type(selector, text);
      await settle(page, 600);
    },
    /**
     * Phone layout contract inside `scope` (main content plus open dialogs and sheets): the
     * document does not scroll sideways, and every visible table either uses the card layout or
     * fits the viewport.
     */
    async assertPhoneLayout(label) {
      const findings = await page.evaluate(() => {
        const vw = window.innerWidth;
        const out = [];
        const root = document.documentElement;
        if (Math.max(root.scrollWidth, document.body.scrollWidth) > vw + 2) {
          out.push(`document scrolls sideways (${root.scrollWidth}px)`);
        }
        const scopes = [
          document.getElementById("main-content"),
          ...document.querySelectorAll('[role="dialog"], [data-slot="sheet-content"]'),
        ].filter(Boolean);
        const seen = new Set();
        for (const scope of scopes) {
          for (const table of scope.querySelectorAll("table")) {
            if (seen.has(table)) continue;
            seen.add(table);
            const rect = table.getBoundingClientRect();
            const style = window.getComputedStyle(table);
            if (rect.width === 0 || rect.height === 0 || style.visibility === "hidden") continue;
            if (table.getAttribute("data-mobile-cards") === "true") continue;
            if (rect.width > vw + 8) {
              const heads = [...table.querySelectorAll("thead th")].map((th) => th.textContent.trim()).filter(Boolean);
              out.push(`table ${Math.round(rect.width)}px wide without cards (${heads.slice(0, 4).join(", ")})`);
            }
          }
        }
        return out;
      });
      for (const finding of findings) ctx.fail(`${label}: ${finding}`);
    },
    /** The last visible button of the open dialog or sheet can be scrolled into view and fits. */
    async assertDialogActionsReachable(label) {
      const result = await page.evaluate(() => {
        const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter((d) => {
          const r = d.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return { error: "no open dialog" };
        const rect = dialog.getBoundingClientRect();
        const vh = window.visualViewport?.height ?? window.innerHeight;
        if (rect.top < -2 || rect.bottom > vh + 2) return { error: `dialog exceeds viewport (${Math.round(rect.bottom)}/${vh})` };
        const buttons = [...dialog.querySelectorAll("button")].filter((b) => {
          const r = b.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && !b.closest("[data-slot='dialog-close'], [aria-label='Close']");
        });
        const last = buttons[buttons.length - 1];
        if (!last) return { ok: true };
        last.scrollIntoView({ block: "nearest" });
        const b = last.getBoundingClientRect();
        return b.bottom <= vh + 2 && b.top >= -2 ? { ok: true } : { error: `last action off-screen (${Math.round(b.top)}→${Math.round(b.bottom)})` };
      });
      if (result.error) ctx.fail(`${label}: ${result.error}`);
    },
    async closeOverlays() {
      await page.keyboard.press("Escape").catch(() => undefined);
      await settle(page, 400).catch(() => undefined);
    },
  };
  return ctx;
}

/** Workflow definitions: `item` is the remediation item number (1–14). */
export const ERP_MOBILE_WORKFLOWS = [
  {
    id: "git-tracking",
    item: 1,
    title: "GIT tracking: Truck/Location and Agent/Duty",
    async run(ctx) {
      await ctx.goto("/tracking?tab=git-tracking");
      await ctx.assertPhoneLayout("GIT tracking");
      const tabs = await ctx.page.$$eval('#main-content [role="tab"]', (els) => els.length);
      for (let index = 0; index < Math.min(tabs, 6); index += 1) {
        const handles = await ctx.page.$$('#main-content [role="tab"]');
        if (!handles[index]) break;
        await handles[index].click();
        await new Promise((resolve) => setTimeout(resolve, 900));
        const label = await handles[index].evaluate((el) => el.textContent.trim());
        await ctx.assertPhoneLayout(`GIT tab ${label}`);
      }
    },
  },
  {
    id: "location-inventory",
    item: 2,
    title: "Location Inventory: location, Stock Groups, group items",
    async run(ctx) {
      await ctx.goto("/location-inventory");
      await ctx.assertPhoneLayout("location list");
      if (!(await ctx.tap('[data-testid^="card-location-"]'))) ctx.skip("no locations in fixture");
      await ctx.assertPhoneLayout("location stock");
      const groups = await ctx.page.$$('#main-content [role="tab"]');
      for (const tab of groups) {
        const text = await tab.evaluate((el) => el.textContent.trim());
        if (!/group|مجموع|groupe/i.test(text)) continue;
        await tab.click();
        await new Promise((resolve) => setTimeout(resolve, 900));
        await ctx.assertPhoneLayout("stock groups");
        if (await ctx.tap('[data-testid^="row-group-"]')) await ctx.assertPhoneLayout("stock group items");
        break;
      }
    },
  },
  {
    id: "pos-item-sheet",
    item: 3,
    title: "POS: search, item sheet with quantity and price, add, search again",
    async run(ctx) {
      await ctx.goto("/pos");
      const search = '[data-testid="input-mobile-product-search"]';
      if (!(await ctx.exists(search, { timeout: 10000 }))) ctx.skip("POS phone layout not available (POS not set up)");
      await ctx.type(search, process.env.ERP_MOBILE_POS_QUERY || "a");
      if (!(await ctx.tap('[data-testid^="button-mobile-select-item-"]'))) ctx.skip("no sellable POS items in fixture");
      if (!(await ctx.exists('[data-testid="sheet-pos-mobile-item"]'))) {
        ctx.fail("tapping a result did not open the item sheet");
        return;
      }
      await ctx.require('[data-testid="input-pos-sheet-quantity"]', "item sheet has no quantity input");
      await ctx.require('[data-testid="input-pos-sheet-rate"]', "item sheet has no price input");
      await ctx.assertDialogActionsReachable("POS item sheet");
      await ctx.tap('[data-testid="button-pos-sheet-add"]');
      if (await ctx.exists('[data-testid="sheet-pos-mobile-item"]', { timeout: 800 })) ctx.fail("sheet stayed open after Add");
      const focused = await ctx.page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
      if (focused !== "input-mobile-product-search") ctx.fail(`focus did not return to search (${focused})`);
    },
  },
  {
    id: "account-statement",
    item: 4,
    title: "Accounts statement",
    async run(ctx) {
      await ctx.goto("/accounts");
      await ctx.assertPhoneLayout("account list");
      if (!(await ctx.tap('[data-testid^="row-account-"]'))) ctx.skip("no accounts in fixture");
      await ctx.require('[data-testid="account-statement-cards"]', "statement did not render phone cards", { timeout: 10000 });
      await ctx.assertPhoneLayout("account statement");
    },
  },
  {
    id: "mobile-navigation",
    item: 5,
    title: "Mobile navigation: More opens the page menu",
    async run(ctx) {
      await ctx.goto("/tracking");
      if (!(await ctx.tap('[data-testid="mobile-nav-more"]'))) {
        ctx.fail("bottom navigation More is missing");
        return;
      }
      await ctx.require('[data-testid="erp-mobile-nav-sheet"]', "More did not open the page menu");
      await ctx.type('[data-testid="erp-mobile-nav-search"]', "Payroll");
      if (!(await ctx.tap('[data-testid="erp-mobile-nav-link-/payroll"]'))) {
        ctx.fail("page search did not find Payroll");
        return;
      }
      const path = await ctx.page.evaluate(() => window.location.pathname);
      if (path !== "/payroll") ctx.fail(`menu link navigated to ${path}`);
      if (await ctx.exists('[data-testid="erp-mobile-nav-sheet"]', { timeout: 500 })) ctx.fail("menu stayed open after navigation");
    },
  },
  {
    id: "agent-ledger",
    item: 6,
    title: "Agent Ledger: list, then statement with Back",
    async run(ctx) {
      await ctx.goto("/agents");
      await ctx.require('[data-testid="agents-phone-layout"]', "agents page is not in the phone layout");
      if (!(await ctx.tap('[data-testid^="button-select-agent-"]'))) ctx.skip("no agents in fixture");
      await ctx.require('[data-testid="button-back-to-agents"]', "agent statement has no Back to agents");
      await ctx.assertPhoneLayout("agent statement");
      await ctx.tap('[data-testid="button-back-to-agents"]');
      await ctx.require('[data-testid="agent-list-panel"]', "Back did not return to the agent list");
    },
  },
  {
    id: "daybook-voucher",
    item: 7,
    title: "Daybook: view a voucher and reach its actions",
    async run(ctx) {
      await ctx.goto("/daybook");
      await ctx.assertPhoneLayout("daybook");
      if (!(await ctx.tap('[data-testid^="row-voucher-mobile-"] .cursor-pointer'))) ctx.skip("no vouchers on the fixture date");
      if (!(await ctx.exists('[role="dialog"]'))) {
        ctx.fail("tapping a voucher did not open it");
        return;
      }
      await ctx.assertPhoneLayout("voucher view");
      await ctx.assertDialogActionsReachable("voucher view");
      await ctx.closeOverlays();
    },
  },
  {
    id: "edits-activity",
    item: 8,
    title: "Edits & Activity",
    async run(ctx) {
      await ctx.goto("/daybook");
      const tabs = await ctx.page.$$('#main-content [role="tab"]');
      if (tabs.length < 2) ctx.skip("daybook tabs not available");
      await tabs[1].click();
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await ctx.assertPhoneLayout("edits & activity");
    },
  },
  {
    id: "all-daybook",
    item: 9,
    title: "All Daybook",
    async run(ctx) {
      await ctx.goto("/transaction-journal");
      await ctx.assertPhoneLayout("all daybook");
    },
  },
  {
    id: "voucher-types",
    item: 10,
    title: "All seven voucher types reach Save on a phone",
    async run(ctx) {
      await ctx.goto("/vouchers");
      if (!(await ctx.exists('[data-testid="button-voucher-type-select"]'))) {
        ctx.fail("voucher type selector is missing on phone");
        return;
      }
      for (const type of VOUCHER_TYPES) {
        await ctx.tap('[data-testid="button-voucher-type-select"]');
        if (!(await ctx.tap(`[data-testid="tab-mobile-${type}"]`, { timeout: 3000 }))) {
          ctx.note(`${type}: not offered to this user`);
          await ctx.closeOverlays();
          continue;
        }
        await ctx.assertPhoneLayout(`voucher ${type}`);
        const reachable = await ctx.page.evaluate(() => {
          const main = document.getElementById("main-content");
          main?.scrollTo({ top: main.scrollHeight });
          const vh = window.innerHeight;
          const candidates = [
            ...document.querySelectorAll('[data-voucher-sticky-actions] button, #main-content form button[type="submit"]'),
          ];
          return candidates.some((b) => {
            const r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= vh + 2;
          });
        });
        if (!reachable) ctx.fail(`voucher ${type}: no Save action reachable at the end of the form`);
      }
    },
  },
  {
    id: "profit-check",
    item: 11,
    title: "Profit Check",
    async run(ctx) {
      await ctx.goto("/supplier-profit-check");
      await ctx.assertPhoneLayout("profit check");
    },
  },
  {
    id: "payroll",
    item: 12,
    title: "Payroll: every tab",
    async run(ctx) {
      await ctx.goto("/payroll");
      await ctx.assertPhoneLayout("payroll");
      const count = await ctx.page.$$eval('#main-content [role="tab"]', (els) => els.length);
      for (let index = 0; index < count; index += 1) {
        const handles = await ctx.page.$$('#main-content [role="tab"]');
        if (!handles[index]) break;
        const label = await handles[index].evaluate((el) => el.textContent.trim());
        await handles[index].evaluate((el) => el.scrollIntoView({ block: "center" }));
        await handles[index].click();
        await new Promise((resolve) => setTimeout(resolve, 1000));
        await ctx.assertPhoneLayout(`payroll ${label}`);
      }
    },
  },
  {
    id: "rental-shops",
    item: 13,
    title: "Rentals Shops: unit cards and unit dialog",
    async run(ctx) {
      await ctx.goto("/erp/rental/shops");
      await ctx.assertPhoneLayout("rental shops");
      if (!(await ctx.exists('[data-testid="rental-unit-cards"]', { timeout: 4000 }))) ctx.skip("no rental units in fixture");
      await ctx.tap('[data-testid^="card-unit-"] button');
      if (!(await ctx.exists('[role="dialog"]'))) {
        ctx.fail("tapping a unit did not open it");
        return;
      }
      await ctx.assertPhoneLayout("unit dialog");
      const tabsOverflow = await ctx.page.evaluate(() =>
        [...document.querySelectorAll('[role="dialog"] [role="tablist"]')].some((t) => t.scrollWidth > t.clientWidth + 2)
      );
      if (tabsOverflow) ctx.fail("unit dialog tabs are cut off");
      await ctx.closeOverlays();
    },
  },
  {
    id: "settings",
    item: 14,
    title: "Settings: every section",
    async run(ctx) {
      await ctx.goto("/settings");
      const trigger = '#main-content [role="combobox"]';
      if (!(await ctx.exists(trigger))) {
        ctx.fail("settings section selector is missing on phone");
        return;
      }
      await ctx.tap(trigger);
      const sections = await ctx.page.$$eval('[role="option"]', (els) => els.map((el) => el.textContent.trim()));
      await ctx.closeOverlays();
      for (let index = 0; index < sections.length; index += 1) {
        await ctx.tap(trigger);
        const options = await ctx.page.$$('[role="option"]');
        if (!options[index]) break;
        await options[index].click();
        await new Promise((resolve) => setTimeout(resolve, 1300));
        await ctx.assertPhoneLayout(`settings ${sections[index]}`);
        const cut = await ctx.page.evaluate(() =>
          [...document.querySelectorAll('#main-content [role="tablist"]')].some((t) => t.scrollWidth > t.clientWidth + 2)
        );
        if (cut) ctx.fail(`settings ${sections[index]}: sub-tabs cut off`);
      }
    },
  },
];

/** Runs every workflow (or the ids in `only`) on the current page and viewport. */
export async function runErpMobileWorkflows(page, { baseUrl, timeoutMs, settle, only }) {
  const results = [];
  for (const workflow of ERP_MOBILE_WORKFLOWS) {
    if (only && !only.has(workflow.id)) continue;
    const ctx = createContext(page, { baseUrl, timeoutMs, settle });
    let status = "pass";
    let reason = "";
    try {
      await workflow.run(ctx);
      if (ctx.failures.length) status = "fail";
    } catch (error) {
      if (error instanceof SkipWorkflow) {
        status = ctx.failures.length ? "fail" : "skipped";
        reason = error.message;
      } else {
        status = "fail";
        ctx.fail(`error: ${String(error?.message || error).slice(0, 200)}`);
      }
    }
    await ctx.closeOverlays();
    results.push({ id: workflow.id, item: workflow.item, title: workflow.title, status, reason, failures: ctx.failures, notes: ctx.notes });
  }
  return results;
}

/**
 * Builds the Help & Training catalog from the same navigation the user's
 * sidebar shows, so every page (and Factory tab) a user can open has a guide
 * and nothing they cannot open is listed.
 *
 * The sidebars already apply company type, role, page permissions, feature
 * flags and hidden tabs; this module only turns their visible items into
 * training topics. It is not an authorization boundary: the server still
 * re-checks page access before streaming any recording.
 */
import { FACTORY_TAB_REGISTRY, isFactoryTabVisibleInProfile } from "@shared/factoryPermissionCatalog";
import { TRAINING_TOPICS, type TrainingTopic } from "./trainingCatalog";

export interface HelpNavItem {
  title: string;
  url: string;
}

export interface HelpNavSection {
  label: string;
  items: readonly HelpNavItem[];
}

/** Factory tab groups whose label is not itself a page label in the access registry. */
export const FACTORY_TAB_GROUP_ROUTE: Readonly<Record<string, string>> = {
  "Workers Hub": "/factory/payroll-hub",
  "Employees Hub": "/factory/payroll-hub",
  "Payroll & Benefits": "/factory/payroll-hub",
  Payroll: "/factory/payroll-hub",
  Advances: "/factory/payroll-hub",
  "Workers List": "/factory/payroll-hub",
  "Worker Profile": "/factory/payroll-hub",
  "Bales Hub": "/factory/bales-hub",
  "Parties Hub": "/factory/parties",
  "Customer Profile": "/factory/parties",
  "Stock Entry": "/factory/stock-entry",
  "Supplier Intel": "/factory/intelligence/supplier-hub",
  "Production Intel": "/factory/intelligence/production-hub",
  Overview: "/factory/production-report",
  Invoicing: "/factory/invoicing",
  Daybook: "/factory/daybook",
  Import: "/factory/import",
  "Dispatch Batches": "/factory/dispatch-batches",
  "Sheets & Sacks": "/factory/sheets-sacks",
  "Bale Relabeling": "/factory/bale-relabeling",
  Accounts: "/factory/accounts",
  Vouchers: "/factory/vouchers",
  KPIs: "/factory/intelligence/kpis",
};

const PATH_ONLY = (url: string) => url.split(/[?#]/, 1)[0] || "/";
const CURATED_BY_ROUTE = new Map(
  TRAINING_TOPICS.filter((topic) => topic.route).map((topic) => [PATH_ONLY(topic.route as string), topic])
);

/** Stable topic id for a page; pages with a published recording keep its id. */
export function helpTopicId(url: string): string {
  const path = PATH_ONLY(url);
  const curated = CURATED_BY_ROUTE.get(path);
  if (curated) return curated.id;
  return (
    "page-" +
    path
      .replace(/^\/+/, "")
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .toLowerCase()
  ).slice(0, 80);
}

/**
 * Factory tabs this user may open, grouped by the page that hosts them.
 * Privileged users (Admin, Owner, Developer, full access) see every tab, as in
 * the Factory hubs themselves.
 */
export function factoryTabsByRoute(
  hiddenFields: readonly string[] | undefined,
  privileged: boolean
): ReadonlyMap<string, readonly string[]> {
  const byRoute = new Map<string, string[]>();
  for (const tab of FACTORY_TAB_REGISTRY) {
    const route = FACTORY_TAB_GROUP_ROUTE[tab.group];
    if (!route) continue;
    if (!privileged && !isFactoryTabVisibleInProfile(tab, hiddenFields ?? [])) continue;
    const labels = byRoute.get(route) ?? [];
    if (!labels.includes(tab.label)) labels.push(tab.label);
    byRoute.set(route, labels);
  }
  return byRoute;
}

function genericSteps(title: string, tabs: readonly string[] | undefined): string[] {
  const steps = [
    `Open ${title} from the sidebar and confirm the company shown at the top is the one you mean to work in.`,
  ];
  if (tabs && tabs.length > 1) {
    steps.push(`Use the tabs to switch between the sections you have access to: ${tabs.join(", ")}.`);
  }
  steps.push("Use the search box, date range and filters to narrow the records on screen.");
  steps.push("Open a record to see its full details and history before you change anything.");
  steps.push("Check every amount, quantity and date before saving; saved entries post to stock or accounts.");
  return steps;
}

/**
 * Turns the user's visible navigation into training topics. Each page appears
 * once (the first section that lists it), the shared "Getting started" guide
 * comes first, and pages with curated guides keep their reviewed steps.
 */
export function buildHelpTopics(
  mode: TrainingTopic["mode"],
  sections: readonly HelpNavSection[],
  tabsByRoute?: ReadonlyMap<string, readonly string[]>
): TrainingTopic[] {
  const topics: TrainingTopic[] = [];
  const welcome = TRAINING_TOPICS.find((topic) => topic.id === "welcome");
  if (welcome) topics.push(welcome);
  const seen = new Set<string>();
  for (const section of sections) {
    for (const item of section.items) {
      const path = PATH_ONLY(item.url);
      if (seen.has(path) || path.endsWith("/help-training")) continue;
      seen.add(path);
      const tabs = tabsByRoute?.get(path);
      const curated = CURATED_BY_ROUTE.get(path);
      topics.push({
        id: helpTopicId(path),
        title: curated?.title ?? item.title,
        category: section.label,
        mode,
        route: item.url,
        description: curated?.description ?? `How to use ${item.title}.`,
        steps: curated?.steps ?? genericSteps(item.title, tabs),
        tabs: tabs && tabs.length > 0 ? tabs : undefined,
        keywords: curated?.keywords,
      });
    }
  }
  return topics;
}

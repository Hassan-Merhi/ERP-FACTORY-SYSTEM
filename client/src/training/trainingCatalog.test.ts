import { describe, expect, it } from "vitest";
import { TRAINING_TOPICS } from "./trainingCatalog";
import { buildHelpTopics, factoryTabsByRoute, helpTopicId } from "./helpTrainingTopics";
import { posHelpTopics } from "./useHelpTrainingTopics";
import type { PosNavItem } from "@/app/usePosNavigationItems";

describe("curated training topics", () => {
  it("have unique ids and actionable content", () => {
    expect(new Set(TRAINING_TOPICS.map((topic) => topic.id)).size).toBe(TRAINING_TOPICS.length);
    for (const topic of TRAINING_TOPICS) {
      expect(topic.steps.length).toBeGreaterThan(1);
      expect(topic.description.length).toBeGreaterThan(10);
    }
  });
});

describe("Help & Training catalog built from the user's navigation", () => {
  it("lists exactly the pages the sidebar shows, once each, after Getting started", () => {
    const topics = buildHelpTopics("factory", [
      { label: "Quick access", items: [{ title: "Overview", url: "/factory/production-report" }] },
      {
        label: "Production",
        items: [
          { title: "Overview", url: "/factory/production-report" },
          { title: "Stock Entry", url: "/factory/stock-entry" },
          { title: "Help & Training", url: "/factory/help-training" },
        ],
      },
    ]);
    expect(topics.map((topic) => topic.id)).toEqual(["welcome", "factory-overview", "factory-stock-entry"]);
  });

  it("keeps the ids of pages that already have published recordings", () => {
    expect(helpTopicId("/factory/stock-allocation-v5")).toBe("factory-stock-allocation");
    expect(helpTopicId("/vouchers")).toBe("erp-vouchers");
    expect(helpTopicId("/properties/rentals")).toBe("page-properties-rentals");
    expect(helpTopicId("/vouchers?tab=transfer")).toBe("erp-vouchers");
  });

  it("gives pages without a curated guide generic steps that name their visible tabs", () => {
    const [, topic] = buildHelpTopics(
      "factory",
      [{ label: "People", items: [{ title: "Parties", url: "/factory/parties" }] }],
      new Map([["/factory/parties", ["Customers", "Suppliers"]]])
    );
    expect(topic.category).toBe("People");
    expect(topic.tabs).toEqual(["Customers", "Suppliers"]);
    expect(topic.steps.some((step) => step.includes("Customers, Suppliers"))).toBe(true);
  });

  it("omits Factory tabs the user has hidden and opt-in tabs they were not granted", () => {
    const tabs = factoryTabsByRoute(["hide_tab_bales_history"], false);
    const bales = tabs.get("/factory/bales-hub") ?? [];
    expect(bales).not.toContain("Bales History");
    expect(bales).toContain("Barcode Lookup");
    expect(bales).not.toContain("Customer Loading");
    const granted = factoryTabsByRoute(["show_tab_bales_customer_loading"], false);
    expect(granted.get("/factory/bales-hub")).toContain("Customer Loading");
  });

  it("shows privileged users every Factory tab, as the hubs do", () => {
    const tabs = factoryTabsByRoute(["hide_tab_bales_history"], true);
    expect(tabs.get("/factory/bales-hub")).toEqual(
      expect.arrayContaining(["Bales History", "Barcode Lookup", "Bale Products", "Customer Loading"])
    );
  });

  it("builds POS guides from the POS menu the user actually has", () => {
    const item = (label: string, path: string, group: PosNavItem["group"]): PosNavItem => ({
      label,
      path,
      group,
      icon: () => null,
      active: false,
      testId: label,
      onClick: () => undefined,
    });
    const topics = posHelpTopics([
      item("Point of Sale", "/pos", "primary"),
      item("Settings", "/pos-settings", "tools"),
      item("Help & Training", "/help-training", "tools"),
    ]);
    expect(topics.map((topic) => topic.route)).toEqual([undefined, "/pos", "/pos-settings"]);
    expect(topics[1]?.id).toBe("erp-pos");
  });
});

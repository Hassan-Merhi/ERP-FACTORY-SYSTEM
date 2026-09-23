// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";

import { resolveFactoryPage, resolveFactoryPageKey } from "@/app/factoryAccessRegistry";
import {
  canAccessAnyErpFeature,
  canAccessErpFeature,
  canonicalErpAccessPath,
  getErpRouteFeatureKeys,
} from "@/app/erpAccess";
import { canonicalizeHubLocation } from "@/hooks/use-hub-query-state";
import { canonicalNavigationPath } from "@/hooks/use-recent-nav";

describe("Wave 3 frontend access enforcement", () => {
  beforeEach(() => {
    window.history.replaceState({}, "", "/");
  });

  it("matches Factory page permissions even when query strings and hashes are present", () => {
    expect(resolveFactoryPageKey("/factory/invoicing?tab=pending")).toBe("factory/invoicing");
    expect(resolveFactoryPageKey("/factory/invoicing#pending")).toBe("factory/invoicing");
    expect(resolveFactoryPage("/factory/accounts?tab=find#ignored")?.key).toBe("factory/accounts");
  });

  it("replaces a restricted query tab with the first permitted child", () => {
    window.history.replaceState({}, "", "/factory/invoicing?tab=pending&customerId=17");

    const tab = canonicalizeHubLocation({
      key: "tab",
      allowedValues: ["invoices"] as const,
      knownValues: ["proformas", "invoices", "loadings", "pending"] as const,
      defaultValue: "invoices" as const,
    });

    expect(tab).toBe("invoices");
    expect(window.location.search).toBe("?tab=invoices&customerId=17");
  });

  it("scrubs a restricted legacy hash and preserves the permitted tab", () => {
    window.history.replaceState({}, "", "/factory/bales-hub#customer-loading");

    const tab = canonicalizeHubLocation({
      key: "tab",
      allowedValues: ["history"] as const,
      knownValues: ["history", "barcode", "products", "customer-loading"] as const,
      defaultValue: "history" as const,
    });

    expect(tab).toBe("history");
    expect(window.location.search).toBe("?tab=history");
    expect(window.location.hash).toBe("");
  });

  it("removes child selection state entirely when all children are disabled", () => {
    window.history.replaceState({}, "", "/factory/supplier-hub?section=ageing#ageing");

    canonicalizeHubLocation({
      key: "section",
      allowedValues: [] as readonly ("report" | "ageing")[],
      knownValues: ["report", "ageing"] as const,
      defaultValue: "report" as const,
    });

    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("");
  });

  it("maps composite ERP hubs to the child permissions that can make them visible", () => {
    expect(getErpRouteFeatureKeys("/inventory?tab=containers#legacy")).toEqual([
      "stock_items",
      "location_inventory",
      "stock_otw",
      "containers",
    ]);
    expect(getErpRouteFeatureKeys("/parties?tab=customers")).toEqual(["suppliers", "customers"]);
    expect(canonicalErpAccessPath("/stock?tab=query#old")).toBe("/stock");
  });

  it("requires an allowed ERP feature without widening a restricted allow-list", () => {
    const access = { fullAccess: false, pageKeys: ["customers"] };
    expect(canAccessErpFeature(access, "customers")).toBe(true);
    expect(canAccessErpFeature(access, "suppliers")).toBe(false);
    expect(canAccessAnyErpFeature(access, ["suppliers", "customers"])).toBe(true);
    expect(canAccessAnyErpFeature(access, ["stock_items", "stock_query"])).toBe(false);
  });

  it("canonicalizes Recent URLs so query/hash variants cannot survive as stale entries", () => {
    expect(canonicalNavigationPath("/inventory?tab=containers")).toBe("/inventory");
    expect(canonicalNavigationPath("/factory/bales-hub#customer-loading")).toBe("/factory/bales-hub");
    expect(canonicalNavigationPath("/tracking")).toBe("/tracking");
  });
});

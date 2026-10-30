/**
 * The shared Factory tab and page permission catalogue: opt-in tab grants,
 * effective hidden fields, page-key canonicalisation (lenient, fail-closed
 * and Settings-assignable) and stale hidden-field cleanup.
 */
import { describe, expect, it } from "vitest";
import { FACTORY_ACCESS_REGISTRY, FACTORY_SETTINGS_PAGES } from "../shared/factoryAccessRegistry";
import {
  canonicalFactoryPageKey,
  FACTORY_TAB_GRANT_KEYS,
  FACTORY_TAB_KEYS,
  FACTORY_TAB_REGISTRY,
  isFactoryTabVisibleInProfile,
  normalizeAssignableFactoryPageKeys,
  normalizeFactoryHiddenFields,
  normalizeFactoryPageKeys,
  normalizePersistedFactoryPageKeysFailClosed,
  resolveFactoryEffectiveHiddenFields,
  setFactoryTabVisibleInProfile,
} from "../shared/factoryPermissionCatalog";

const optIn = FACTORY_TAB_REGISTRY.find((tab) => tab.grantKey)!;
const plain = FACTORY_TAB_REGISTRY.find((tab) => !tab.grantKey)!;
const assignable = FACTORY_SETTINGS_PAGES[0];
const notAssignable = FACTORY_ACCESS_REGISTRY.find((page) => !FACTORY_SETTINGS_PAGES.includes(page))!;

describe("factory tab permissions", () => {
  it("has unique keys and lists every opt-in grant", () => {
    expect(FACTORY_TAB_KEYS.size).toBe(FACTORY_TAB_REGISTRY.length);
    expect(FACTORY_TAB_GRANT_KEYS.has(optIn.grantKey!)).toBe(true);
    expect(FACTORY_TAB_GRANT_KEYS.size).toBe(FACTORY_TAB_REGISTRY.filter((tab) => tab.grantKey).length);
  });

  it("shows a plain tab unless hidden and an opt-in tab only when granted and not hidden", () => {
    expect(isFactoryTabVisibleInProfile(plain, [])).toBe(true);
    expect(isFactoryTabVisibleInProfile(plain, [plain.key])).toBe(false);
    expect(isFactoryTabVisibleInProfile(optIn, [])).toBe(false);
    expect(isFactoryTabVisibleInProfile(optIn, [optIn.grantKey!])).toBe(true);
    expect(isFactoryTabVisibleInProfile(optIn, [optIn.grantKey!, optIn.key])).toBe(false);
  });

  it("toggles a tab by storing its hide key or its grant", () => {
    expect(setFactoryTabVisibleInProfile(["cost", plain.key], plain, true)).toEqual(["cost"]);
    expect(setFactoryTabVisibleInProfile(["cost"], plain, false)).toEqual(["cost", plain.key]);
    expect(setFactoryTabVisibleInProfile([optIn.key], optIn, true)).toEqual([optIn.grantKey]);
    expect(setFactoryTabVisibleInProfile([optIn.grantKey!, "cost"], optIn, false)).toEqual(["cost", optIn.key]);
  });

  it("hides every opt-in tab not explicitly granted", () => {
    const hidden = resolveFactoryEffectiveHiddenFields([plain.key]);
    expect(hidden).toContain(plain.key);
    expect(hidden).toContain(optIn.key);
    expect(resolveFactoryEffectiveHiddenFields([optIn.grantKey!])).not.toContain(optIn.key);
  });
});

describe("factory page keys", () => {
  it("canonicalises known and legacy keys and rejects everything else", () => {
    expect(canonicalFactoryPageKey(` /${assignable.route.replace(/^\//, "")} `)).toBe(assignable.key);
    expect(canonicalFactoryPageKey("factory/stock-allocation-v2")).toBe("factory/stock-allocation-v5");
    expect(canonicalFactoryPageKey("//factory/sales/loading/new")).toBe("factory/invoicing");
    expect(canonicalFactoryPageKey("factory/does-not-exist-anywhere")).toBeNull();
    expect(canonicalFactoryPageKey("erp/dashboard")).toBeNull();
    expect(canonicalFactoryPageKey(42)).toBeNull();
  });

  it("keeps unrestricted [] and drops unknown keys leniently", () => {
    expect(normalizeFactoryPageKeys("factory/x")).toEqual([]);
    expect(
      normalizeFactoryPageKeys([
        assignable.key,
        "factory/stock-allocation-v2",
        "factory/stock-allocation-v5",
        "bogus",
        null,
      ])
    ).toEqual([assignable.key, "factory/stock-allocation-v5"]);
  });

  it("keeps unknown factory keys when reading persisted rows so restrictions fail closed", () => {
    expect(normalizePersistedFactoryPageKeysFailClosed(null)).toEqual([]);
    expect(
      normalizePersistedFactoryPageKeysFailClosed([
        " /factory/old-removed-page ",
        "factory/stock-allocation-v2",
        7,
        "erp/x",
        "factory/stock-allocation-v5",
      ])
    ).toEqual(["factory/old-removed-page", "factory/stock-allocation-v5"]);
  });

  it("assigns only Settings-manageable pages", () => {
    expect(normalizeAssignableFactoryPageKeys([assignable.key, notAssignable.key])).toEqual([assignable.key]);
  });
});

describe("normalizeFactoryHiddenFields", () => {
  it("drops deprecated and unknown tab keys but keeps other visibility fields", () => {
    expect(normalizeFactoryHiddenFields("x")).toEqual([]);
    expect(
      normalizeFactoryHiddenFields([
        plain.key,
        plain.key,
        "hide_tab_agents",
        "hide_tab_removed_feature",
        "hide_invoicing_unknown_tab",
        "hide_invoicing_invoices_tab",
        "hide_cost_price",
        "daybook_own_only",
        "",
        5,
      ])
    ).toEqual([plain.key, "hide_invoicing_invoices_tab", "hide_cost_price", "daybook_own_only"]);
  });
});

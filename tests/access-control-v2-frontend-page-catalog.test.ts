import { describe, expect, it } from "vitest";
import pageCatalog from "../config/permissions-v2-page-catalog.json";
import {
  PERMISSION_PAGE_CATALOG,
  decideReadOnlyRoleRoute,
  findPermissionPage,
  matchPagePattern,
  permissionPageCatalogSummary,
} from "@shared/permissionPageCatalog";
import { ACCESS_CONTROL_ACTIONS, ACCESS_CONTROL_RESOURCES } from "@shared/accessControlV2";
import { CREATE_ONLY_VERIFIED_CREATE_SIGNATURES, isCreateOnlyVerifiedCreateName } from "@shared/createOnlyRolePolicy";

const LEGACY_ROLES = ["Developer", "Admin", "Owner", "Manager", "POS", "Normal User", "ERP Tester"] as const;

function concrete(pattern: string): string {
  return pattern.replace(/:[A-Za-z]+/g, "42");
}

describe("Permissions V2 frontend page catalog", () => {
  it("covers ERP, Factory, POS/Retail and Properties with valid, unique entries", () => {
    const ids = PERMISSION_PAGE_CATALOG.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const summary = permissionPageCatalogSummary();
    expect(summary.byArea.erp).toBeGreaterThan(20);
    expect(summary.byArea.factory).toBeGreaterThan(20);
    expect(summary.byArea.pos_retail).toBeGreaterThan(0);
    expect(summary.byArea.properties).toBeGreaterThan(0);
    for (const entry of PERMISSION_PAGE_CATALOG) {
      expect(ACCESS_CONTROL_RESOURCES).toContain(entry.resource);
      for (const action of entry.actions) expect(ACCESS_CONTROL_ACTIONS).toContain(action);
      if (entry.inPage === "component") expect(entry.files?.length ?? 0).toBeGreaterThan(0);
      if (entry.createOnlyCreate !== undefined)
        expect(isCreateOnlyVerifiedCreateName(entry.createOnlyCreate)).toBe(true);
    }
  });

  it("names every page for the audit report", () => {
    for (const row of pageCatalog.pages as Array<{ id: string; label?: string }>) {
      expect(row.label, row.id).toBeTruthy();
    }
    expect(pageCatalog.pages.map((row) => row.id)).toEqual(PERMISSION_PAGE_CATALOG.map((entry) => entry.id));
  });

  it("never assigns one route to two pages", () => {
    const seen = new Map<string, string>();
    for (const entry of PERMISSION_PAGE_CATALOG) {
      for (const path of entry.paths) {
        expect(seen.get(path), `${path} in ${entry.id} and ${seen.get(path)}`).toBeUndefined();
        seen.set(path, entry.id);
      }
    }
  });

  it("matches patterns by segment and ignores query strings", () => {
    expect(matchPagePattern("/vouchers/:id/edit", "/vouchers/17/edit?tab=x")).toEqual({ id: "17" });
    expect(matchPagePattern("/vouchers/:id/edit", "/vouchers/17")).toBeNull();
    expect(matchPagePattern("/vouchers", "/vouchers/")).toEqual({});
    expect(findPermissionPage("/vouchers")?.entry.id).toBe("erp.vouchers.create");
    expect(findPermissionPage("/unknown/page")).toBeNull();
  });

  it("leaves every legacy role untouched on every catalogued route", () => {
    for (const role of LEGACY_ROLES) {
      for (const entry of PERMISSION_PAGE_CATALOG) {
        for (const path of entry.paths) {
          expect(decideReadOnlyRoleRoute(role, concrete(path)), `${role} ${path}`).toEqual({ kind: "allow" });
        }
      }
    }
    expect(decideReadOnlyRoleRoute(null, "/vouchers/1/edit")).toEqual({ kind: "allow" });
  });

  it("closes change pages to View Only and Create Only", () => {
    for (const role of ["View Only", "Create Only"]) {
      for (const entry of PERMISSION_PAGE_CATALOG.filter((item) => item.mode === "change")) {
        for (const path of entry.paths) {
          expect(decideReadOnlyRoleRoute(role, concrete(path)).kind, `${role} ${path}`).not.toBe("allow");
        }
      }
    }
    expect(decideReadOnlyRoleRoute("View Only", "/import-stock-items")).toMatchObject({
      kind: "explain",
      reason: "existing_record_change",
    });
    expect(decideReadOnlyRoleRoute("Create Only", "/factory/settings")).toMatchObject({ kind: "explain" });
  });

  it("sends voucher and POS edit links to the read-only voucher view", () => {
    expect(decideReadOnlyRoleRoute("Create Only", "/vouchers/55/edit")).toEqual({
      kind: "redirect",
      to: "/voucher-detail/55",
      pageId: "erp.vouchers.edit",
    });
    expect(decideReadOnlyRoleRoute("View Only", "/pos/edit/9")).toMatchObject({
      kind: "redirect",
      to: "/voucher-detail/9",
    });
    expect(decideReadOnlyRoleRoute("View Only", "/factory/vouchers/3/edit")).toMatchObject({
      to: "/factory/voucher-detail/3",
    });
    expect(decideReadOnlyRoleRoute("Create Only", "/properties/vouchers/8/edit")).toMatchObject({
      to: "/properties/voucher-detail/8",
    });
    // A crafted id cannot inject another path.
    expect(decideReadOnlyRoleRoute("View Only", "/vouchers/a%2F..%2Fsettings/edit")).toMatchObject({
      to: "/voucher-detail/a%252F..%252Fsettings",
    });
  });

  it("keeps Create Only off unverified create pages and on verified ones", () => {
    for (const path of [
      "/vouchers",
      "/pos",
      "/retail/pos",
      "/stock-transfer-order",
      "/factory/containers/new",
      "/factory/vouchers",
      "/factory/stock-entry",
      "/properties/create",
    ]) {
      expect(decideReadOnlyRoleRoute("Create Only", path), path).toMatchObject({
        kind: "explain",
        reason: "unverified_create",
      });
      // View Only keeps its legacy behaviour on create pages: the server refuses the write.
      expect(decideReadOnlyRoleRoute("View Only", path), path).toEqual({ kind: "allow" });
    }
    for (const path of [
      "/create",
      "/factory/create",
      "/factory/sales/new",
      "/parties",
      "/stock",
      "/retail/inventory",
      "/properties/rentals",
    ]) {
      expect(decideReadOnlyRoleRoute("Create Only", path), path).toEqual({ kind: "allow" });
    }
  });

  it("only names verified creates whose signatures exist on the server catalog", () => {
    const named = new Set(
      PERMISSION_PAGE_CATALOG.flatMap((entry) => (entry.createOnlyCreate ? [entry.createOnlyCreate] : []))
    );
    for (const name of named) expect(CREATE_ONLY_VERIFIED_CREATE_SIGNATURES[name].length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  INTERCOMPANY_CANONICAL_DESTINATIONS,
  LEGACY_PROPERTIES_INTERCOMPANY_ROUTES,
  legacyErpIntercompanyPaymentDestination,
  legacyPropertiesIntercompanyDestination,
} from "../client/src/pages/intercompany/intercompanyLegacyNavigation";
import {
  PROPERTIES_NAVIGATION,
  canNavigateProperties,
  findPropertiesNavigationEntry,
  getPropertiesParentRoute,
} from "../client/src/properties/config/propertiesNavigation";
import {
  PROPERTIES_NAV_SECTIONS,
  PROPERTIES_PINNED_DEFAULTS,
  getPropertiesVisibleNavSections,
} from "../client/src/components/PropertiesSidebar";

const owner = { companyType: "properties" as const, role: "Owner" };
const viewer = { companyType: "properties" as const, role: "View Only" };
const erp = { companyType: "erp" as const, role: "Owner" };

describe("Phase 7 retired intercompany navigation and protected compatibility", () => {
  it("keeps Properties logistics, supplier and normal voucher entry points", () => {
    for (const path of [
      "/properties/containers",
      "/properties/tracking",
      "/properties/suppliers",
      "/properties/po-import",
      "/properties/vouchers",
    ]) {
      expect(findPropertiesNavigationEntry(path)).toBeDefined();
      expect(canNavigateProperties(path, owner, owner)).toBe(true);
      expect(canNavigateProperties(path, erp, erp)).toBe(false);
    }
    expect(PROPERTIES_PINNED_DEFAULTS.map((entry) => entry.url)).toContain("/properties/vouchers");
    const allItems = getPropertiesVisibleNavSections(false, true).flatMap((section) => section.items);
    for (const path of [
      "/properties/containers",
      "/properties/tracking",
      "/properties/suppliers",
      "/properties/po-import",
    ]) {
      expect(allItems.some((entry) => entry.url === path)).toBe(true);
    }
    expect(
      getPropertiesVisibleNavSections(false, false)
        .flatMap((section) => section.items)
        .some((entry) => entry.url === "/properties/po-import")
    ).toBe(false);
  });

  it("removes all three duplicate Properties Trading sidebar entries, including the Recent menu sources", () => {
    expect(PROPERTIES_NAV_SECTIONS.some((section) => section.label === "Trading")).toBe(false);
    const visible = getPropertiesVisibleNavSections(true, true).flatMap((section) => section.items);
    for (const legacy of Object.values(LEGACY_PROPERTIES_INTERCOMPANY_ROUTES)) {
      expect(visible.some((entry) => entry.url === legacy)).toBe(false);
      expect(PROPERTIES_PINNED_DEFAULTS.some((entry) => entry.url === legacy)).toBe(false);
      const registry = PROPERTIES_NAVIGATION.find((entry) => entry.path === legacy);
      expect(registry?.navigation).toBe("hidden");
      expect(registry?.capability).toBe("trading");
    }
  });

  it("replaces legacy Properties links with exact canonical destinations, preserving a verified physical ID", () => {
    expect(legacyPropertiesIntercompanyDestination("linked-trades")).toBe("/properties/containers");
    expect(legacyPropertiesIntercompanyDestination("intercompany-lifecycle")).toBe("/properties/containers");
    for (const screen of ["linked-trades", "intercompany-lifecycle"] as const) {
      expect(legacyPropertiesIntercompanyDestination(screen, "?containerId=432")).toBe("/properties/containers/432");
      expect(legacyPropertiesIntercompanyDestination(screen, "?physicalContainerId=432")).toBe(
        "/properties/containers/432"
      );
      expect(legacyPropertiesIntercompanyDestination(screen, "?containerId=432&physicalContainerId=432")).toBe(
        "/properties/containers/432"
      );
      for (const search of [
        "?containerId=0",
        "?containerId=-1",
        "?containerId=1.0",
        "?containerId=001",
        "?containerId=1%2F..",
        "?containerId=9007199254740992",
        "?containerId=abc",
        "?containerId=32&physicalContainerId=33",
        "?tradeId=432",
      ]) {
        expect(legacyPropertiesIntercompanyDestination(screen, search)).toBe("/properties/containers");
      }
    }
    expect(legacyPropertiesIntercompanyDestination("intercompany-payments")).toBe(
      INTERCOMPANY_CANONICAL_DESTINATIONS.propertiesVouchers
    );
    expect(legacyErpIntercompanyPaymentDestination()).toBe(INTERCOMPANY_CANONICAL_DESTINATIONS.erpVouchers);
  });

  it("retains the original trading permissions for bookmarks rather than making redirects a privilege bypass", () => {
    for (const route of Object.values(LEGACY_PROPERTIES_INTERCOMPANY_ROUTES)) {
      expect(canNavigateProperties(route, owner, owner)).toBe(true);
      expect(canNavigateProperties(route, viewer, viewer)).toBe(false);
      expect(canNavigateProperties(route, erp, erp)).toBe(false);
    }
    expect(getPropertiesParentRoute("/properties/linked-trades")).toBe("/properties/containers");
    expect(getPropertiesParentRoute("/properties/intercompany-lifecycle")).toBe("/properties/containers");
    expect(getPropertiesParentRoute("/properties/intercompany-payments")).toBe(
      INTERCOMPANY_CANONICAL_DESTINATIONS.propertiesVouchers
    );
  });

  it("keeps old Properties route handlers guarded and redirect-only, while preserving new canonical screens", () => {
    const routes = readFileSync("client/src/app/PropertiesRoutes.tsx", "utf8");
    expect(routes).toContain("canTrade &&");
    expect(routes).toContain('legacyPropertiesIntercompanyDestination("linked-trades"');
    expect(routes).toContain('legacyPropertiesIntercompanyDestination("intercompany-payments"');
    expect(routes).toContain('legacyPropertiesIntercompanyDestination("intercompany-lifecycle"');
    expect(routes).toContain('<Route path="/properties/containers/:id" component={ContainerDetailPage} />');
    expect(routes).toContain('<Route path="/properties/vouchers">');
    expect(routes).not.toContain("component={IntercompanyPayments}");
    expect(routes).not.toContain("component={LinkedTradesEditor}");
    expect(routes).not.toContain("component={IntercompanyLifecycle}");
    expect(routes).toContain('<Redirect replace to="/properties/po-import" />');
  });

  it("moves the ERP payment page into Vouchers without removing destination ERP receiving access", () => {
    const routes = readFileSync("client/src/routes/ErpRoutes.tsx", "utf8");
    expect(routes).toContain("LegacyIntercompanyPaymentRedirect");
    expect(routes).toContain('canAccess("vouchers") && canAccess("containers")');
    expect(routes).toContain('"/intercompany/payments"');
    expect(routes).toContain('"/intercompany/lifecycle"');
    expect(routes).toContain("IntercompanyLifecycle");
    expect(routes).toContain('"/intercompany/linked-trades"');
    expect(routes).toContain("LinkedTradesEditor");
    expect(routes).toContain('"/vouchers"');
  });

  it("retains linked PO, freight, receiving and cancellation in the real Properties container", () => {
    const details = readFileSync("client/src/pages/containerdetail/components/ContainerDetailErpView.tsx", "utf8");
    const panel = readFileSync("client/src/pages/containerdetail/PropertiesIntercompanyContainerWorkflow.tsx", "utf8");
    const vouchers = readFileSync("client/src/pages/Vouchers.tsx", "utf8");
    const payment = readFileSync("client/src/pages/intercompany/IntercompanyPayments.tsx", "utf8");
    expect(details).toContain("PropertiesIntercompanyContainerWorkflow containerId={container.id}");
    expect(panel).toContain("<LinkedTradesEditor physicalContainerId={containerId} embedded />");
    expect(panel).toContain("<IntercompanyLifecycle physicalContainerId={containerId} embedded />");
    expect(vouchers).not.toContain('activeTab === "intercompany"');
    expect(vouchers).toContain("useNormalIntercompanyVoucher");
    expect(vouchers).toContain("normalIntercompany.buildMirror()");
    expect(vouchers).toContain("<PaymentVoucherTab");
    expect(payment).toContain('BASE + "/confirm"');
    expect(payment).toContain('BASE + "/" + reversing + "/reverse"');
    expect(payment).toContain("intercompanyVoucherDetailPath");
  });

  it("leaves accounting-side transaction and audit protections in place", () => {
    const posting = readFileSync("server/services/intercompany/paymentSync.ts", "utf8");
    const receipt = readFileSync("server/services/intercompany/phase5Receipt.ts", "utf8");
    const cancel = readFileSync("server/services/intercompany/phase5Cancel.ts", "utf8");
    const role = readFileSync("server/services/intercompany/pairedPaymentAuthorization.ts", "utf8");
    expect(posting).toContain("await requirePairedCashAuthorization(pair, actor)");
    expect(posting).toContain("db.transaction(async (tx)");
    expect(posting).toContain("postErpVoucherTx(tx");
    expect(role).toContain("canAccessPairedCash");
    expect(receipt).toContain("await requireReceivingPairPermission(trade, actor)");
    expect(cancel).toContain("confirmNoRealCashReversal");
  });
});

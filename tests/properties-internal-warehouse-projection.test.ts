import { describe, expect, it } from "vitest";
import {
  isPropertiesInternalSourceReference,
  sharedRentalDisplayTab,
} from "../server/routes/rental/units-contracts/internalProjection";

describe("Properties rental internal source projections", () => {
  const erpWarehouse = { module: "ERP", isInternal: true };
  const factoryWarehouse = { module: "FACTORY", isInternal: true };
  const factoryShop = { module: "FACTORY", isInternal: true };

  it("shows an ERP internal warehouse in the Properties Warehouses tab", () => {
    expect(isPropertiesInternalSourceReference("PROPERTIES", erpWarehouse)).toBe(true);
    expect(sharedRentalDisplayTab("PROPERTIES", erpWarehouse, { unitType: "WAREHOUSE" })).toBe("WAREHOUSE");
  });

  it("shows a Factory internal warehouse in the Properties Warehouses tab", () => {
    expect(isPropertiesInternalSourceReference("PROPERTIES", factoryWarehouse)).toBe(true);
    expect(sharedRentalDisplayTab("PROPERTIES", factoryWarehouse, { unitType: "WAREHOUSE" })).toBe("WAREHOUSE");
  });

  it("keeps internal Factory shops in the Properties Shops tab", () => {
    expect(sharedRentalDisplayTab("PROPERTIES", factoryShop, { unitType: "SHOP" })).toBe("SHOP");
  });

  it("does not move ordinary linked warehouse leases out of Shops", () => {
    const ordinaryLinkedWarehouse = { module: "ERP", isInternal: false };
    expect(isPropertiesInternalSourceReference("PROPERTIES", ordinaryLinkedWarehouse)).toBe(false);
    expect(sharedRentalDisplayTab("PROPERTIES", ordinaryLinkedWarehouse, { unitType: "WAREHOUSE" })).toBe("SHOP");
  });

  it("preserves ERP/Factory shop view behavior for linked contracts", () => {
    expect(isPropertiesInternalSourceReference("ERP", erpWarehouse)).toBe(false);
    expect(sharedRentalDisplayTab("ERP", erpWarehouse, { unitType: "WAREHOUSE" })).toBe("SHOP");
    expect(sharedRentalDisplayTab("FACTORY", erpWarehouse, { unitType: "WAREHOUSE" })).toBe("SHOP");
  });

  it("never marks a Properties-owned lease as an external reference", () => {
    expect(isPropertiesInternalSourceReference("PROPERTIES", { module: "PROPERTIES", isInternal: true })).toBe(false);
  });
});

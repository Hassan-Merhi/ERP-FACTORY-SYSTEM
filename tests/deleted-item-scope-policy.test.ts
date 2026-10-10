import { describe, expect, it } from "vitest";
import { classifyDeletedItemScope } from "../server/services/security/deletedItemScopePolicy";

describe("deleted item scope policy", () => {
  it("classifies restore and permanent-delete operations", () => {
    expect(classifyDeletedItemScope("/api/deleted-items/stockItem/15/restore")).toEqual({
      type: "stockItem",
      id: 15,
      operation: "restore",
      globalMaintenance: false,
    });
    expect(classifyDeletedItemScope("/api/deleted-items/voucher/99/permanent")).toEqual({
      type: "voucher",
      id: 99,
      operation: "permanent",
      globalMaintenance: false,
    });
  });

  it("scopes suppliers to the active company like every other type (wave 18 B)", () => {
    expect(classifyDeletedItemScope("/api/deleted-items/supplier/8/permanent")).toEqual({
      type: "supplier",
      id: 8,
      operation: "permanent",
      globalMaintenance: false,
    });
  });

  it("rejects unknown types and invalid IDs", () => {
    expect(classifyDeletedItemScope("/api/deleted-items/unknown/8/restore")).toBeNull();
    expect(classifyDeletedItemScope("/api/deleted-items/customer/0/permanent")).toBeNull();
    expect(classifyDeletedItemScope("/api/deleted-items/customer/not-a-number/restore")).toBeNull();
  });
});

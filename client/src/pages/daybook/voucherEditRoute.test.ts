import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveVoucherEditDestination, voucherDetailPath, voucherEditPath } from "./voucherEditRoute";

describe("voucherEditPath", () => {
  it("opens the matching Vouchers tab in edit mode", () => {
    expect(voucherEditPath({ id: 7, voucherType: "Journal" })).toBe("/vouchers?edit=7&tab=journal&from=daybook");
    expect(voucherEditPath({ id: 8, voucherType: "Stock Transfer" })).toBe(
      "/vouchers?edit=8&tab=transferorder&from=daybook"
    );
    expect(voucherEditPath({ id: 9, voucherType: "Debit Note" }, "/properties/vouchers")).toBe(
      "/properties/vouchers?edit=9&tab=creditnote&from=daybook"
    );
  });

  it("sends Sales/POS to the POS editor and Purchase to its tab", () => {
    expect(voucherEditPath({ id: 3, voucherType: "POS" })).toBe("/pos/edit/3");
    expect(voucherEditPath({ id: 4, voucherType: "Purchase" })).toBe("/vouchers?edit=4&tab=purchase&from=daybook");
  });

  it("returns null for types without an editor", () => {
    expect(voucherEditPath({ id: 5, voucherType: "Opening" })).toBeNull();
  });
});

describe("resolveVoucherEditDestination", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("uses voucherEditPath for editable types and the read-only voucher otherwise", async () => {
    expect(await resolveVoucherEditDestination({ id: 7, voucherType: "Production" })).toBe(
      "/vouchers?edit=7&tab=adjustment&from=daybook"
    );
    expect(await resolveVoucherEditDestination({ id: 3, voucherType: "Sales" })).toBe("/pos/edit/3");
    expect(await resolveVoucherEditDestination({ id: 5, voucherType: "Opening" }, "/factory/vouchers")).toBe(
      "/factory/voucher-detail/5"
    );
    expect(voucherDetailPath(6, "/properties/vouchers")).toBe("/properties/voucher-detail/6");
  });

  it("opens a purchase's container, or its read-only voucher when it has none", async () => {
    const fetchMock = vi.fn(async (url: string) => ({
      ok: true,
      json: async () => (url.includes("/41/") ? { purchaseOrder: { containerId: 12 } } : { purchaseOrder: null }),
    }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveVoucherEditDestination({ id: 41, voucherType: "Purchase" })).toBe("/containers/12");
    expect(await resolveVoucherEditDestination({ id: 42, voucherType: "Purchase" })).toBe("/voucher-detail/42");
    expect(fetchMock).toHaveBeenCalledWith("/api/vouchers/41/view-entries", { credentials: "include" });
  });

  it("never opens an ERP container from Factory or Properties", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveVoucherEditDestination({ id: 9, voucherType: "Purchase" }, "/factory/vouchers")).toBe(
      "/factory/voucher-detail/9"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

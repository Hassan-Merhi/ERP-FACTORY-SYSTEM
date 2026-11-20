/**
 * Successful-activity audit classification: id-less and zero-id paths, every
 * table / action variant of the factory repair, offload, container-charge and
 * bale families, identifier fallbacks, structured-item compaction, actor and
 * company fallbacks and the non-Error write failure. The audit writer and
 * logger are stubbed at their module boundaries.
 */
import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ logAudit: vi.fn(), warn: vi.fn() }));
vi.mock("../server/routes/helpers/auditWriteAdapter", () => ({ logAudit: h.logAudit }));
vi.mock("../server/lib/logger", () => ({ logger: { warn: h.warn } }));

import { writeSuccessfulActivityAudit } from "../server/middleware/activityAudit";

const SESSION = { userId: "u-1", username: "Op", currentCompanyId: 7 };
const req = (method: string, path: string, body?: unknown, session: unknown = SESSION, user?: unknown) =>
  ({ method, path, body, session, user }) as unknown as Request;
const audit = (method: string, path: string, body?: unknown) => {
  h.logAudit.mockClear();
  writeSuccessfulActivityAudit(req(method, path, body), 200);
  return h.logAudit.mock.calls[0]?.[0];
};

beforeEach(() => {
  h.logAudit.mockReset();
  h.logAudit.mockResolvedValue(undefined);
  h.warn.mockReset();
});

describe("identifier fallbacks without a route id", () => {
  it.each([
    ["POST", "/api/factory/customer-orders/x/whatsapp", "Customer order #unknown"],
    ["POST", "/api/factory/customer-orders/x/email", "Customer order #unknown"],
    ["POST", "/api/pos/sale/return", "POS sale #unknown"],
    ["POST", "/api/pos/sale/void", "POS sale #unknown"],
    ["POST", "/api/factory/pos/sale/cancel", "POS sale #unknown"],
    ["DELETE", "/api/pos/sale", "POS sale #unknown"],
    ["PUT", "/api/pos/sale/payment", "POS sale payment #unknown"],
    ["POST", "/api/pos/sale/0/payment", "POS sale payment #unknown"],
    ["POST", "/api/factory/raw-stock/recalc/apply", "Factory recalculation"],
    ["POST", "/api/factory/fx/replay/apply", "Factory repair"],
    ["PUT", "/api/factory/post_offload", "Post-offload charge #unknown"],
    ["POST", "/api/factory/reverse_offload", "Container/offload #unknown"],
    ["POST", "/api/factory/containers/x/other-charge", "Container adjustment #unknown"],
    ["POST", "/api/factory/bale/relabel", "Bale #unknown"],
    ["POST", "/api/factory/bales/reentry", "Bale #unknown"],
    ["POST", "/api/factory/bales/merge", "Bale merge"],
    ["POST", "/api/factory/bales/split", "Bale split"],
    ["DELETE", "/api/factory/bales/x", "Bale #unknown"],
  ])("%s %s -> %s", (method, path, identifier) => {
    expect(audit(method, path)).toMatchObject({ recordId: null, recordIdentifier: identifier });
  });

  it("names merges and splits with their id", () => {
    expect(audit("POST", "/api/factory/bales/9/merge").recordIdentifier).toBe("Bale merge #9");
    expect(audit("POST", "/api/factory/bales/9/split").recordIdentifier).toBe("Bale split #9");
  });
});

describe("action and table variants", () => {
  it.each([
    ["POST", "/api/factory/raw/recalculate", { dryRun: false }, "recalculate", "factory_raw_stock"],
    ["POST", "/api/factory/fx/repair", { apply: true }, "repair", "factory_fx_repairs"],
    ["POST", "/api/factory/landed/repair/apply", undefined, "repair", "factory_landed_cost_repairs"],
    ["POST", "/api/factory/cost/replay", { dryRun: false }, "repair", "factory_landed_cost_repairs"],
    ["POST", "/api/factory/stock/repair/apply", undefined, "repair", "factory_repairs"],
    ["POST", "/api/factory/post-offload/3", undefined, "create", "factory_post_offload_charges"],
    ["DELETE", "/api/factory/post-offload/3", undefined, "delete", "factory_post_offload_charges"],
    ["PATCH", "/api/factory/post-offload/3", undefined, "update", "factory_post_offload_charges"],
    ["POST", "/api/factory/containers/3/offload/reverse", undefined, "reverse", "factory_containers"],
    ["POST", "/api/factory/containers/3/commission", undefined, "create", "factory_container_commissions"],
    ["PUT", "/api/factory/containers/3/freight", undefined, "update", "factory_container_freight"],
    ["DELETE", "/api/factory/containers/3/extra-charge", undefined, "delete", "factory_container_extra_charges"],
  ])("%s %s", (method, path, body, action, tableName) => {
    expect(audit(method, path, body)).toMatchObject({ action, tableName });
  });

  it("ignores repair and recalc paths that are not applied or are diagnostics", () => {
    expect(audit("POST", "/api/factory/raw/recalculate", { dryRun: true })).toBeUndefined();
    expect(audit("POST", "/api/factory/fx/repair/dryrun", { apply: true })).toBeUndefined();
    expect(audit("POST", "/api/factory/fx/repair/dry-run/apply")).toBeUndefined();
    expect(audit("POST", "/api/factory/fx/repair/diagnostic/apply")).toBeUndefined();
  });

  it("ignores unmatched POS, bale and generic writes", () => {
    expect(audit("GET", "/api/pos/sale/1/payment")).toBeUndefined();
    expect(audit("POST", "/api/pos/sale/1")).toBeUndefined();
    expect(audit("PUT", "/api/factory/bales/1")).toBeUndefined();
    expect(audit("POST", "/api/vouchers/1")).toBeUndefined();
  });
});

describe("change compaction and bale identifiers", () => {
  it("prefers reference number, then barcode, for relabel, restore and delete", () => {
    expect(audit("POST", "/api/factory/bales/5/recode", { referenceNumber: "REF-1" }).recordIdentifier).toBe("REF-1");
    expect(audit("POST", "/api/factory/bales/5/restore", { barcode: "BC-1" }).recordIdentifier).toBe("BC-1");
    expect(audit("POST", "/api/factory/bales/5/re-entry", { referenceNumber: "R2" }).recordIdentifier).toBe("R2");
    expect(audit("DELETE", "/api/factory/bales/5", { barcode: "BC-2" }).recordIdentifier).toBe("BC-2");
    expect(audit("DELETE", "/api/factory/bales/5").recordIdentifier).toBe("Bale #5");
  });

  it("keeps safe scalars, compacts item arrays and drops objects, nulls and empty arrays", () => {
    const entry = audit("POST", "/api/pos/sale/4/void", {
      reason: "x".repeat(200),
      amount: 12,
      status: null,
      scope: { nested: true },
      items: [{ quantity: 2, secret: { a: 1 } }, "junk"],
      lines: [],
      lineItems: [{ nothing: { a: 1 } }],
    });
    expect(entry.changes.reason.new).toHaveLength(160);
    expect(entry.changes.amount).toEqual({ old: null, new: 12 });
    expect(entry.changes).not.toHaveProperty("status");
    expect(entry.changes).not.toHaveProperty("scope");
    expect(entry.changes).not.toHaveProperty("lines");
    expect(entry.changes).not.toHaveProperty("lineItems");
    expect(Object.keys(entry.changes)).toContain("items");
  });

  it("records no changes for an empty body", () => {
    expect(audit("POST", "/api/pos/sale/4/void", {}).changes).toBeNull();
  });
});

describe("actor resolution and write failures", () => {
  it("skips informational statuses and requests without a company", () => {
    writeSuccessfulActivityAudit(req("POST", "/api/pos/sale/1/void"), 101);
    writeSuccessfulActivityAudit(req("POST", "/api/pos/sale/1/void", {}, { userId: "u" }), 200);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("falls back to req.user, the factory company and the user id as username", () => {
    writeSuccessfulActivityAudit(
      req("POST", "/api/pos/sale/1/void", {}, { factoryCompanyId: "12", currentCompanyId: 3 }, { id: "u-9" }),
      204
    );
    expect(h.logAudit.mock.calls[0][0]).toMatchObject({ userId: "u-9", username: "u-9", companyId: 12 });
  });

  it("works without a session object at all when the user and company are missing", () => {
    writeSuccessfulActivityAudit(req("POST", "/api/pos/sale/1/void", {}, null, { id: "u" }), 200);
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("logs a non-Error audit rejection as text", async () => {
    h.logAudit.mockRejectedValueOnce("db down");
    writeSuccessfulActivityAudit(req("POST", "/api/pos/sale/1/void"), 200);
    await vi.waitFor(() => expect(h.warn).toHaveBeenCalled());
    expect(h.warn.mock.calls[0][1]).toMatchObject({ error: "db down", action: "void" });
  });
});

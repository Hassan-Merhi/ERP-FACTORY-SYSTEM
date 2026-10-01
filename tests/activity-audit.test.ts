import type { Request } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  logAudit: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../server/routes/helpers/auditWriteAdapter", () => ({
  logAudit: harness.logAudit,
}));

vi.mock("../server/lib/logger", () => ({
  logger: { warn: harness.warn },
}));

import { writeSuccessfulActivityAudit } from "../server/middleware/activityAudit";

function request(
  method: string,
  path: string,
  body: Record<string, unknown> = {},
  session: Record<string, unknown> = {
    userId: "user-1",
    username: "Operator",
    currentCompanyId: 7,
  }
): Request {
  return {
    method,
    path,
    body,
    session,
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  harness.logAudit.mockResolvedValue(undefined);
});

describe("successful activity audit", () => {
  it("ignores unsuccessful, read-only, preview, and anonymous requests", () => {
    writeSuccessfulActivityAudit(request("POST", "/api/pos/sale/11/void"), 500);
    writeSuccessfulActivityAudit(request("GET", "/api/pos/sale/11/void"), 200);
    writeSuccessfulActivityAudit(request("POST", "/api/factory/repair/preview", { apply: true }), 200);
    writeSuccessfulActivityAudit(request("POST", "/api/pos/sale/11/void", {}, {}), 200);

    expect(harness.logAudit).not.toHaveBeenCalled();
  });

  it.each([
    ["POST", "/api/factory/customer-orders/41/whatsapp", {}, "send_whatsapp", "factory_customer_orders", 41],
    ["POST", "/api/factory/customer-orders/42/email", {}, "send_email", "factory_customer_orders", 42],
    ["POST", "/api/pos/sale/43/return", { reason: "damaged" }, "return", "pos_sales", 43],
    ["POST", "/api/pos/sale/44/void", {}, "void", "pos_sales", 44],
    ["POST", "/api/pos/sale/45/cancel", {}, "cancel", "pos_sales", 45],
    ["DELETE", "/api/pos/sale/46", {}, "delete", "pos_sales", 46],
    ["PATCH", "/api/pos/sale/47/payment", { amount: 12 }, "update", "pos_sales", 47],
    ["POST", "/api/factory/raw-stock/48/recalculate/apply", { apply: true }, "recalculate", "factory_raw_stock", 48],
    ["POST", "/api/factory/fx/49/repair/apply", { dryRun: false }, "repair", "factory_fx_repairs", 49],
    ["POST", "/api/factory/landed-cost/50/replay/apply", { apply: true }, "repair", "factory_landed_cost_repairs", 50],
    ["POST", "/api/factory/other/51/repair/apply", { apply: true }, "repair", "factory_repairs", 51],
    ["POST", "/api/factory/post-offload/52", { amount: 4 }, "create", "factory_post_offload_charges", 52],
    ["PATCH", "/api/factory/post_offload/53", {}, "update", "factory_post_offload_charges", 53],
    ["DELETE", "/api/factory/post-offload/54", {}, "delete", "factory_post_offload_charges", 54],
    ["POST", "/api/factory/containers/55/reverse-offload", {}, "reverse", "factory_containers", 55],
    ["POST", "/api/factory/container/56/commission", {}, "create", "factory_container_commissions", 56],
    ["PATCH", "/api/factory/container/57/freight", {}, "update", "factory_container_freight", 57],
    ["DELETE", "/api/factory/container/58/extra-charge", {}, "delete", "factory_container_extra_charges", 58],
    ["POST", "/api/factory/bales/59/relabel", { referenceNumber: "B-59" }, "update", "factory_bales", 59],
    ["POST", "/api/factory/bales/60/restore", {}, "restore", "factory_bales", 60],
    ["POST", "/api/factory/bales/61/merge", {}, "update", "factory_bales", 61],
    ["POST", "/api/factory/bales/62/split", {}, "create", "factory_bales", 62],
    ["DELETE", "/api/factory/bales/63", { barcode: "BC-63" }, "delete", "factory_bales", 63],
  ])("classifies %s %s", async (method, path, body, action, tableName, recordId) => {
    writeSuccessfulActivityAudit(request(method, path, body), 204);

    await vi.waitFor(() => expect(harness.logAudit).toHaveBeenCalledTimes(1));
    expect(harness.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        username: "Operator",
        companyId: 7,
        action,
        tableName,
        recordId,
      })
    );
  });

  it("uses factory company identity and compacts safe scalar changes", async () => {
    writeSuccessfulActivityAudit(
      request(
        "POST",
        "/api/factory/post-offload/77",
        {
          amount: 19.5,
          currency: "USD",
          scope: "container",
          ignoredObject: { secret: true },
        },
        {
          userId: "u-77",
          username: "Factory Admin",
          factoryCompanyId: 12,
          currentCompanyId: 7,
        }
      ),
      201
    );

    await vi.waitFor(() => expect(harness.logAudit).toHaveBeenCalledTimes(1));
    expect(harness.logAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        companyId: 12,
        changes: {
          amount: { old: null, new: 19.5 },
          currency: { old: null, new: "USD" },
          scope: { old: null, new: "container" },
        },
      })
    );
  });

  it("never breaks the successful request when audit persistence fails", async () => {
    harness.logAudit.mockRejectedValueOnce(new Error("audit storage unavailable"));

    expect(() => writeSuccessfulActivityAudit(request("POST", "/api/pos/sale/88/void"), 200)).not.toThrow();
    await vi.waitFor(() => expect(harness.warn).toHaveBeenCalledTimes(1));
    expect(harness.warn).toHaveBeenCalledWith(
      "Activity audit write failed after successful request",
      expect.objectContaining({ action: "void", path: "/api/pos/sale/88/void" })
    );
  });
});

/**
 * Stock Transfer Order WhatsApp approval webhook readiness and SQL-failure
 * metadata (server/routes/registerStockTransferOrderWaApprovalRoutesPart1.ts).
 * The readiness route runs through the real HTTP app in a rolled-back
 * company; the GREEN API reads are mocked at the whatsappService boundary.
 *
 * Pinned: Managers are refused; missing or disabled MAIN credentials and an
 * unreadable provider report not-ready without probing further; each provider
 * mismatch yields its own message, for both the supervisor (incoming webhook)
 * and the self-approval (outgoing phone webhook) modes; ready needs the ERP
 * webhook secret as well. The SQL-failure projection returns only driver
 * metadata, walks error causes, and truncates long values.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const wa = vi.hoisted(() => ({ settings: vi.fn(), readiness: vi.fn() }));
vi.mock("../server/services/whatsappService", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/services/whatsappService")>()),
  getWaSettings: wa.settings,
  getStrictGreenMainWebhookReadiness: wa.readiness,
}));

import {
  stockTransferApprovalSqlFailure,
  idOf,
} from "../server/routes/registerStockTransferOrderWaApprovalRoutesPart1";
import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

const URL = "/api/stock-transfer-order/wa-approval/webhook-readiness";
const PHONE = "+243810000555";
const savedToken = process.env.STO_WA_GREEN_API_WEBHOOK_TOKEN;

const provider = (overrides: Record<string, unknown> = {}) => ({
  webhookUrlConfigured: true,
  webhookEndpointMatches: true,
  webhookHost: "erp.example.test",
  webhookTokenMatches: true,
  incomingWebhookEnabled: true,
  outgoingPhoneWebhookEnabled: false,
  mainAccountChatId: "243810000111@c.us",
  ...overrides,
});

beforeEach(() => {
  wa.settings.mockReset().mockResolvedValue({ enabled: true, instanceId: "1101", apiToken: "tok" });
  wa.readiness.mockReset().mockResolvedValue(provider());
  process.env.STO_WA_GREEN_API_WEBHOOK_TOKEN = "w".repeat(40);
});
afterEach(() => {
  if (savedToken === undefined) delete process.env.STO_WA_GREEN_API_WEBHOOK_TOKEN;
  else process.env.STO_WA_GREEN_API_WEBHOOK_TOKEN = savedToken;
});

const authorize = (w: FactoryWorld) =>
  w.q(
    `INSERT INTO stock_transfer_order_approval_settings (company_id, enabled, authorized_phone_e164) VALUES ($1, false, $2)`,
    [w.companyId, PHONE]
  );

describe("webhook readiness", () => {
  it("refuses a Manager", () =>
    withFactoryWorld(async (w) => {
      const manager = await w.agentFor("Manager");
      expect((await manager.get(URL)).status).toBe(403);
      expect(wa.settings).not.toHaveBeenCalled();
    }));

  it("reports missing or disabled MAIN credentials and an unreadable provider", () =>
    withFactoryWorld(async (w) => {
      for (const settings of [
        null,
        { enabled: false, instanceId: "1", apiToken: "t" },
        { enabled: true, instanceId: "1" },
      ]) {
        wa.settings.mockResolvedValueOnce(settings);
        const res = await w.agent.get(URL);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ready: false, mainConfigured: false, providerChecked: false });
      }
      expect(wa.readiness).not.toHaveBeenCalled();
      wa.readiness.mockRejectedValueOnce(new Error("timeout"));
      const failed = await w.agent.get(URL);
      expect(failed.body).toMatchObject({ ready: false, mainConfigured: true, providerChecked: false });
      expect(failed.body.message).toMatch(/Could not read MAIN GREEN API webhook settings/);
    }));

  it("is ready in supervisor mode only with matching endpoint, token, incoming webhook and ERP secret", () =>
    withFactoryWorld(async (w) => {
      const read = async () => (await w.agent.get(URL)).body;
      const ready = await read();
      expect(ready).toMatchObject({ ready: true, providerChecked: true, selfApprovalAccount: false });
      expect(ready.message).toMatch(/configured for the authorized approval mode/);

      wa.readiness.mockResolvedValueOnce(provider({ webhookEndpointMatches: false }));
      expect((await read()).message).toMatch(/not sending callbacks/);
      wa.readiness.mockResolvedValueOnce(provider({ webhookTokenMatches: false }));
      expect((await read()).message).toMatch(/bearer does not match/);
      wa.readiness.mockResolvedValueOnce(provider({ incomingWebhookEnabled: false }));
      expect((await read()).message).toMatch(/Enable GREEN API incomingWebhook/);

      delete process.env.STO_WA_GREEN_API_WEBHOOK_TOKEN;
      const noSecret = await read();
      expect(noSecret).toMatchObject({ ready: false });
      expect(noSecret.message).toBe("Main webhook setup is incomplete.");
    }));

  it("uses the outgoing phone webhook when the authorized phone is the linked account", () =>
    withFactoryWorld(async (w) => {
      await authorize(w);
      const self = provider({ mainAccountChatId: "243810000555@c.us" });
      wa.readiness.mockResolvedValueOnce(self);
      const disabled = (await w.agent.get(URL)).body;
      expect(disabled).toMatchObject({ ready: false, selfApprovalAccount: true });
      expect(disabled.message).toMatch(/Enable outgoingMessageWebhook/);
      wa.readiness.mockResolvedValueOnce({ ...self, outgoingPhoneWebhookEnabled: true, incomingWebhookEnabled: false });
      expect((await w.agent.get(URL)).body).toMatchObject({ ready: true, selfApprovalAccount: true });
      // A different linked account keeps supervisor mode.
      wa.readiness.mockResolvedValueOnce(provider({ mainAccountChatId: null }));
      expect((await w.agent.get(URL)).body).toMatchObject({ ready: true, selfApprovalAccount: false });
    }));
});

describe("SQL failure metadata", () => {
  it("returns driver metadata from the error or one of its causes, without SQL text", () => {
    const driver = {
      code: "23505",
      table: "t".repeat(150),
      constraint: "uq_batch",
      dataType: "integer",
      column: "batch_id",
      routine: "_bt_check_unique",
      position: "17",
    };
    const wrapped = Object.assign(new Error("Failed query: INSERT ... secret"), {
      cause: { message: "wrap", cause: driver },
      stoApprovalStep: "s".repeat(100),
    });
    const result = stockTransferApprovalSqlFailure(wrapped);
    expect(result).toEqual({
      sqlState: "23505",
      table: "t".repeat(100),
      constraint: "uq_batch",
      dataType: "integer",
      column: "batch_id",
      routine: "_bt_check_unique",
      position: 17,
      step: "s".repeat(80),
    });
    expect(JSON.stringify(result)).not.toContain("secret");
  });

  it("nulls non-string fields and gives up on non-driver errors", () => {
    expect(stockTransferApprovalSqlFailure({ code: "XX000", table: 5, position: "abc" })).toMatchObject({
      sqlState: "XX000",
      table: null,
      constraint: null,
      dataType: null,
      column: null,
      routine: null,
      position: null,
      step: null,
    });
    const empty = {
      sqlState: null,
      table: null,
      constraint: null,
      dataType: null,
      column: null,
      routine: null,
      position: null,
      step: null,
    };
    expect(stockTransferApprovalSqlFailure(new Error("plain"))).toEqual(empty);
    expect(stockTransferApprovalSqlFailure("text")).toEqual(empty);
    expect(stockTransferApprovalSqlFailure(null)).toEqual(empty);
    expect(stockTransferApprovalSqlFailure({ code: "not-a-sqlstate", stoApprovalStep: 3 })).toEqual(empty);
    // The cause chain is followed at most five levels deep.
    let deep: Record<string, unknown> = { code: "40001" };
    for (let i = 0; i < 5; i += 1) deep = { cause: deep };
    expect(stockTransferApprovalSqlFailure(deep).sqlState).toBeNull();
  });

  it("parses positive safe integer ids only", () => {
    expect(idOf("12")).toBe(12);
    for (const bad of ["0", "-1", "1.5", "abc", null, 2 ** 60]) expect(idOf(bad)).toBeNull();
  });
});

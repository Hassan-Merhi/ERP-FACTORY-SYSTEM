/**
 * Normal Payment/Receipt interception for configured intercompany accounts
 * (server/routes/vouchers/normalIntercompanyVoucherRoutes.ts) over real HTTP
 * inside one rolled-back transaction: preview (unmatched, matched, refused),
 * the paired posting refusals (missing schema, unmatched explicit mirror,
 * offline LAN primary, draft, entry count, mirror details, request identity),
 * a successful mirrored receipt and its replay, and the edit guards (immutable
 * paired vouchers, linked accounts, other company's voucher).
 */
import type { PoolClient } from "pg";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";

const toggles = vi.hoisted(() => ({ lanPrimary: false, policyTable: true }));
vi.mock("../server/edge/phase9PosOutbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/edge/phase9PosOutbox")>()),
  isPhase9LanPrimary: () => toggles.lanPrimary,
}));
vi.mock("../server/lib/intercompanyTradeAvailability", async (importOriginal) => {
  const real = await importOriginal<typeof import("../server/lib/intercompanyTradeAvailability")>();
  return {
    ...real,
    hasIntercompanyVoucherPoliciesTable: async () =>
      toggles.policyTable ? real.hasIntercompanyVoucherPoliciesTable() : false,
  };
});

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { rolledBackApp } from "./helpers/rolledBackFactoryApp";
import { createIntercompanyTradeWorld, type IntercompanyTradeWorld } from "./helpers/intercompanyTradeFixture";

const PASSWORD = "ic-voucher-pass-123";
let loginSeq = 0;

afterEach(() => {
  toggles.lanPrimary = false;
  toggles.policyTable = true;
});

type Ctx = IntercompanyTradeWorld & {
  agent: ReturnType<typeof request.agent>;
  bankId: number;
  counterpartCashId: number;
};

async function signIn(world: IntercompanyTradeWorld, userId: string, companyId: number) {
  const bcrypt = await import("bcryptjs");
  const [user] = await world.q<{ username: string }>(
    `UPDATE users SET password = $2 WHERE id = $1 RETURNING username`,
    [userId, await bcrypt.hash(PASSWORD, 4)]
  );
  const agent = request.agent(await rolledBackApp());
  loginSeq += 1;
  const login = await agent
    .post("/api/auth/login")
    .set("X-Forwarded-For", `10.77.${(loginSeq >> 8) & 255}.${loginSeq & 255}`)
    .send({ username: user.username, password: PASSWORD });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${login.text}`);
  const set = await agent.post("/api/auth/set-company").send({ companyId });
  if (set.status !== 200) throw new Error(`set-company failed: ${set.status} ${set.text}`);
  return agent;
}

function inWorld(work: (ctx: Ctx) => Promise<void>) {
  return withRolledBackPool(async (client: PoolClient) => {
    const world = await createIntercompanyTradeWorld(client);
    const bankId = await world.one(
      `INSERT INTO bank_accounts (company_id, code, name, bank_name, account_number, active)
       VALUES ($1, $2, 'Main', 'Bank', '001', TRUE) RETURNING id`,
      [world.sourceCompanyId, `${world.tag}BK`]
    );
    const counterpartCashId = await world.ledger(world.destinationCompanyId, "CASH", "Cash");
    const agent = await signIn(world, world.userId, world.sourceCompanyId);
    await work({ ...world, agent, bankId, counterpartCashId });
  });
}

const receipt = (ctx: Ctx, extra: Record<string, unknown> = {}) => ({
  voucherType: "Receipt",
  voucherDate: "2026-06-15",
  paymentAccountType: "bank",
  paymentAccountId: ctx.bankId,
  entries: [{ accountType: "ledger", accountId: ctx.accounts.sourceReceivableAccountId, amount: "40.00" }],
  ...extra,
});
const mirror = (ctx: Ctx) => ({
  counterpartCashAccount: { type: "cash", id: ctx.counterpartCashId },
  transferReference: "TRF-778899",
  confirmationEvidence: "Bank statement line 12",
  reason: "Rent settlement",
  confirmedBoth: true,
});

describe("voucher preview", () => {
  it("validates input, ignores unlinked accounts and resolves the counterpart for linked ones", () =>
    inWorld(async (ctx) => {
      const url = "/api/intercompany-container-trading/payments/voucher-preview";
      const invalid = await ctx.agent.post(url).send({ voucherType: "Journal" });
      expect(invalid.status).toBe(422);
      expect(invalid.body.code).toBe("IC_VOUCHER_INPUT");

      const plain = await ctx.agent
        .post(url)
        .send(receipt(ctx, { entries: [{ accountType: "ledger", accountId: ctx.accounts.sourceSalesAccountId }] }));
      expect(plain.body).toEqual({ matched: false });

      const matched = await ctx.agent.post(url).send(receipt(ctx));
      expect(matched.status).toBe(200);
      expect(matched.body.match).toMatchObject({ relationshipId: ctx.relationshipId, role: "source-receipt" });
      expect(matched.body.counterpartCashAccounts.map((a: { id: number }) => a.id)).toEqual([ctx.counterpartCashId]);

      const wrongDirection = await ctx.agent.post(url).send(receipt(ctx, { voucherType: "Payment" }));
      expect(wrongDirection.status).toBe(422);
      expect(wrongDirection.body.code).toBe("IC_VOUCHER_DIRECTION");
    }));

  it("previews the payer side from the destination company", () =>
    inWorld(async (ctx) => {
      const agent = await signIn(ctx, ctx.userId, ctx.destinationCompanyId);
      const res = await agent.post("/api/intercompany-container-trading/payments/voucher-preview").send({
        voucherType: "Payment",
        paymentAccountType: "ledger",
        paymentAccountId: ctx.counterpartCashId,
        entries: [{ accountType: "supplier", accountId: ctx.partnerSupplierId }],
      });
      expect(res.status).toBe(200);
      expect(res.body.match.role).toBe("destination-payment");
      expect(res.body.counterpartCashAccounts.map((a: { id: number }) => a.id)).toEqual([ctx.bankId]);
    }));
});

describe("paired posting refusals", () => {
  it("refuses an explicit mirror when the policy table is missing or the account is not linked", () =>
    inWorld(async (ctx) => {
      toggles.policyTable = false;
      const missing = await ctx.agent
        .post("/api/vouchers/payment-receipt")
        .send(receipt(ctx, { intercompanyMirror: mirror(ctx) }));
      expect(missing.status).toBe(503);
      expect(missing.body.code).toBe("IC_VOUCHER_SCHEMA_UNAVAILABLE");
      toggles.policyTable = true;

      const unlinked = await ctx.agent.post("/api/vouchers/payment-receipt").send(
        receipt(ctx, {
          entries: [{ accountType: "ledger", accountId: ctx.accounts.sourceSalesAccountId, amount: "1" }],
          intercompanyMirror: mirror(ctx),
        })
      );
      expect(unlinked.status).toBe(409);
      expect(unlinked.body.code).toBe("IC_VOUCHER_UNMATCHED");
    }));

  it("refuses offline, draft, multi-entry, unconfirmed and unidentified paired postings", () =>
    inWorld(async (ctx) => {
      const post = (body: Record<string, unknown>) => ctx.agent.post("/api/vouchers/payment-receipt").send(body);
      toggles.lanPrimary = true;
      expect((await post(receipt(ctx))).body.code).toBe("IC_VOUCHER_OFFLINE");
      toggles.lanPrimary = false;

      expect((await post(receipt(ctx, { optional: true }))).body.code).toBe("IC_VOUCHER_DRAFT");
      const noAmount = receipt(ctx, {
        entries: [{ accountType: "ledger", accountId: ctx.accounts.sourceReceivableAccountId }],
      });
      expect((await post(noAmount)).body.code).toBe("IC_VOUCHER_ENTRY");
      const unconfirmed = await post(receipt(ctx, { intercompanyMirror: { ...mirror(ctx), confirmedBoth: false } }));
      expect(unconfirmed.status).toBe(422);
      expect(unconfirmed.body.code).toBe("IC_VOUCHER_INPUT");
      for (const clientRequestId of [undefined, "short", "bad id with spaces!"]) {
        const res = await post(receipt(ctx, { intercompanyMirror: mirror(ctx), clientRequestId }));
        expect(res.status).toBe(422);
        expect(res.body.code).toBe("IC_VOUCHER_IDEMPOTENCY");
      }
      const [{ count }] = await ctx.q(
        `SELECT count(*)::int AS count FROM intercompany_container_payments WHERE relationship_id = $1`,
        [ctx.relationshipId]
      );
      expect(count).toBe(0);
    }));
});

describe("mirrored receipt", () => {
  it("posts both company vouchers once, replays the same request and blocks editing them", () =>
    inWorld(async (ctx) => {
      const body = receipt(ctx, { intercompanyMirror: mirror(ctx), clientRequestId: `req-${ctx.tag}` });
      const first = await ctx.agent.post("/api/vouchers/payment-receipt").send(body);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        intercompanyMirrored: true,
        relationshipId: ctx.relationshipId,
        replayed: false,
      });
      const replay = await ctx.agent.post("/api/vouchers/payment-receipt").send(body);
      // The request-level replay cache answers with the original status and marks the body replayed.
      expect(replay.status).toBe(201);
      expect(replay.body).toMatchObject({ paymentId: first.body.paymentId, replayed: true });
      const payments = await ctx.q(`SELECT id FROM intercompany_container_payments WHERE relationship_id = $1`, [
        ctx.relationshipId,
      ]);
      expect(payments).toHaveLength(1);

      const edit = await ctx.agent
        .patch(`/api/vouchers/${first.body.sourceVoucherId}/payment-receipt`)
        .send(receipt(ctx));
      expect(edit.status).toBe(409);
      expect(edit.body.code).toBe("IC_VOUCHER_IMMUTABLE");
      // The destination voucher belongs to the other company, so this session cannot see it as paired.
      const other = await ctx.agent
        .patch(`/api/vouchers/${first.body.destinationVoucherId}/payment-receipt`)
        .send(receipt(ctx));
      expect(other.body.code).not.toBe("IC_VOUCHER_IMMUTABLE");
    }));

  it("refuses a confirmed transfer when the counterpart cash account is not the partner's", () =>
    inWorld(async (ctx) => {
      const res = await ctx.agent.post("/api/vouchers/payment-receipt").send(
        receipt(ctx, {
          currency: "CFA",
          exchangeRate: "600",
          intercompanyMirror: { ...mirror(ctx), counterpartCashAccount: { type: "bank", id: ctx.bankId } },
          clientRequestId: `req-bad-${ctx.tag}`,
        })
      );
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.body.code).toMatch(/^IC_/);
    }));
});

describe("edit guard", () => {
  it("refuses editing an ordinary voucher into a linked account and passes other edits through", () =>
    inWorld(async (ctx) => {
      const voucherId = await ctx.one(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
         VALUES ($1, $2, 'Receipt', '2026-06-01', '5') RETURNING id`,
        [ctx.sourceCompanyId, `${ctx.tag}-RC`]
      );
      const linked = await ctx.agent.patch(`/api/vouchers/${voucherId}/payment-receipt`).send(receipt(ctx));
      expect(linked.status).toBe(409);
      expect(linked.body.code).toBe("IC_VOUCHER_EDIT");

      const notNumeric = await ctx.agent.patch(`/api/vouchers/abc/payment-receipt`).send(receipt(ctx));
      expect(notNumeric.body.code).toBeUndefined();
      const ordinary = await ctx.agent
        .patch(`/api/vouchers/${voucherId}/payment-receipt`)
        .send({ voucherType: "Journal" });
      expect(ordinary.body.code).toBeUndefined();
    }));
});

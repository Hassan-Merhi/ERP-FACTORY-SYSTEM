/**
 * FX agent EUR wallet lifecycle against real PostgreSQL rows:
 * activation from a USD agent ledger, USD -> EUR conversion, partial and final
 * EUR settlements to a USD ledger beneficiary, idempotent replay, the
 * book-vs-wallet reconciliation and the generic voucher edit/reversal/retirement lock.
 *
 * The wallet tables come from a manual SQL migration, so the test applies it.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { toMoney } from "../server/lib/money";
import { getPartyBalance } from "../server/services/accounting/balances/ledgerBalanceEngine";
import { assertVoucherEditableTx } from "../server/services/accounting/voucherCorrection";
import { retireVouchersTx } from "../server/services/accounting/voucherRetirement";
import { FX_AGENT_VOUCHER_LOCKED_MESSAGE } from "../server/services/accounting/fxAgentVoucherLock";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIX = "fxagentwallet";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let agentAccountId: number;
let beneficiaryId: number;
let walletId: number;

async function ledgerAccount(code: string, name: string, type: string, opening: string) {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, $5, 'Dr') RETURNING id`,
    [ctx.companyId, `${PREFIX}-${code}`, `${PREFIX} ${name}`, type, opening]
  );
  return result.rows[0].id;
}

async function bookUsd(accountId: number) {
  const balance = await getPartyBalance(db, { kind: "ledger", companyId: ctx.companyId, id: accountId });
  return toMoney(balance?.historicalBaseClosing ?? 0);
}

async function voucherTotals(voucherId: number) {
  const result = await pool.query<{ debit: string; credit: string }>(
    `SELECT COALESCE(SUM(debit_amount), 0)::text AS debit, COALESCE(SUM(credit_amount), 0)::text AS credit
       FROM voucher_entries WHERE voucher_id = $1`,
    [voucherId]
  );
  return result.rows[0];
}

async function walletSnapshot() {
  const response = await agent.get("/api/factory/fx-agent-wallets");
  expect(response.status, response.text).toBe(200);
  return response.body.wallets.find((w: { wallet: { id: number } }) => w.wallet.id === walletId);
}

beforeAll(async () => {
  ctx = await seedTestData(PREFIX);
  await pool.query(`UPDATE companies SET company_type = 'factory' WHERE id = $1`, [ctx.companyId]);
  await pool.query(readFileSync(path.join(__dirname, "../migrations/20261019_factory_fx_agent_wallets.sql"), "utf8"));
  await pool.query(
    readFileSync(path.join(__dirname, "../migrations/20261020_factory_fx_agent_conversion_reversals.sql"), "utf8")
  );
  agent = request.agent(ctx.app) as request.SuperAgentTest;
  const login = await agent
    .post("/api/auth/login")
    .send({ username: `${PREFIX}_testuser`, password: "testpassword123" });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status} ${login.text}`);
  const selected = await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
  if (selected.status !== 200) throw new Error(`set-company failed: ${selected.status} ${selected.text}`);

  agentAccountId = await ledgerAccount("AGENT", "Ramadan FX", "Asset", "10000");
  beneficiaryId = await ledgerAccount("BENEF", "USD Beneficiary", "Asset", "0");
}, 120_000);

afterAll(async () => {
  if (ctx) {
    const cid = ctx.companyId;
    await pool
      .query(`DELETE FROM factory_fx_agent_wallet_operations WHERE company_id = $1`, [cid])
      .catch(() => undefined);
    await pool.query(`DELETE FROM factory_fx_agent_wallets WHERE company_id = $1`, [cid]).catch(() => undefined);
    await cleanupTestData(PREFIX);
  }
  closeTestServer();
}, 120_000);

describe("FX agent EUR wallet lifecycle", () => {
  it("POST /api/factory/fx-agent-wallets activates only with explicit USD confirmation and captures the USD book balance", async () => {
    const unconfirmed = await agent.post("/api/factory/fx-agent-wallets").send({ ledgerAccountId: agentAccountId });
    expect(unconfirmed.status).toBe(400);

    const created = await agent
      .post("/api/factory/fx-agent-wallets")
      .send({ ledgerAccountId: agentAccountId, confirmUsdSource: true });
    expect(created.status, created.text).toBe(201);
    expect(created.body.openingUsd).toBe("10000.000000");
    walletId = created.body.walletId;

    const again = await agent
      .post("/api/factory/fx-agent-wallets")
      .send({ ledgerAccountId: agentAccountId, confirmUsdSource: true });
    expect(again.status).toBe(400);
  });

  it("POST /api/factory/fx-agent-wallets/:id/convert converts USD to EUR at the negotiated rate without posting a journal", async () => {
    const body = { usdAmount: "10000", rateUsdPerEur: "1.1115", requestKey: `${PREFIX}-convert-1` };
    const converted = await agent.post(`/api/factory/fx-agent-wallets/${walletId}/convert`).send(body);
    expect(converted.status, converted.text).toBe(201);
    expect(converted.body.conversion.eur).toBe("8996.851102");

    const replay = await agent.post(`/api/factory/fx-agent-wallets/${walletId}/convert`).send(body);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ id: converted.body.id, replayed: true });

    const overdraw = await agent
      .post(`/api/factory/fx-agent-wallets/${walletId}/convert`)
      .send({ usdAmount: "1", rateUsdPerEur: "1.1115", requestKey: `${PREFIX}-convert-2` });
    expect(overdraw.status).toBe(400);

    const snapshot = await walletSnapshot();
    expect(snapshot.state).toMatchObject({ usd: "0.000000", eur: "8996.851102", eurBookUsd: "10000.000000" });
    expect(snapshot.synchronized).toBe(true);
    expect((await bookUsd(agentAccountId)).toFixed(2)).toBe("10000.00");
  });

  let partialVoucherId: number;

  it("POST /api/factory/fx-agent-wallets/:id/settle posts a balanced partial settlement with the realized FX gain", async () => {
    const body = {
      eurAmount: "4000",
      rateUsdPerEur: "1.16",
      targetKind: "ledger",
      targetId: beneficiaryId,
      requestKey: `${PREFIX}-settle-1`,
    };
    const settled = await agent.post(`/api/factory/fx-agent-wallets/${walletId}/settle`).send(body);
    expect(settled.status, settled.text).toBe(201);
    partialVoucherId = settled.body.voucherId;
    const { quote } = settled.body;
    expect(quote.usd).toBe("4640.00");
    // 4000 / 8996.851102 of the 10000 USD basis.
    expect(toMoney(quote.bookUsd).toFixed(2)).toBe("4446.00");
    expect(toMoney(quote.gainUsd).toFixed(2)).toBe("194.00");

    const totals = await voucherTotals(partialVoucherId);
    expect(toMoney(totals.debit).eq(totals.credit)).toBe(true);
    expect(toMoney(totals.debit).toFixed(2)).toBe("4640.00");
    expect((await bookUsd(beneficiaryId)).toFixed(2)).toBe("4640.00");
    expect((await bookUsd(agentAccountId)).toFixed(2)).toBe("5554.00");

    const replay = await agent.post(`/api/factory/fx-agent-wallets/${walletId}/settle`).send(body);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ voucherId: partialVoucherId, replayed: true });
    const reusedKey = await agent
      .post(`/api/factory/fx-agent-wallets/${walletId}/settle`)
      .send({ ...body, eurAmount: "1" });
    expect(reusedKey.status).toBe(400);

    const snapshot = await walletSnapshot();
    expect(snapshot.state.eur).toBe("4996.851102");
    expect(snapshot.synchronized).toBe(true);
  });

  it("blocks generic edit, reversal and retirement of the settlement voucher", async () => {
    await expect(
      db.transaction((tx) => assertVoucherEditableTx(tx, partialVoucherId, { companyId: ctx.companyId }))
    ).rejects.toMatchObject({ code: "FX_AGENT_VOUCHER_LOCKED" });
    await expect(
      db.transaction((tx) =>
        retireVouchersTx(tx, { companyId: ctx.companyId, voucherIds: [partialVoucherId], reason: "test" })
      )
    ).rejects.toThrow(FX_AGENT_VOUCHER_LOCKED_MESSAGE);
  });

  it("refuses to pay the agent's own ledger and overdrawing the EUR wallet", async () => {
    const own = await agent.post(`/api/factory/fx-agent-wallets/${walletId}/settle`).send({
      eurAmount: "1",
      rateUsdPerEur: "1.1",
      targetKind: "ledger",
      targetId: agentAccountId,
      requestKey: `${PREFIX}-settle-own`,
    });
    expect(own.status).toBe(400);
    const overdraw = await agent.post(`/api/factory/fx-agent-wallets/${walletId}/settle`).send({
      eurAmount: "5000",
      rateUsdPerEur: "1.1",
      targetKind: "ledger",
      targetId: beneficiaryId,
      requestKey: `${PREFIX}-settle-over`,
    });
    expect(overdraw.status).toBe(400);
  });

  it("depletes the final EUR with the remaining book basis and a realized loss", async () => {
    const settled = await agent.post(`/api/factory/fx-agent-wallets/${walletId}/settle`).send({
      eurAmount: "4996.851102",
      rateUsdPerEur: "1.10",
      targetKind: "ledger",
      targetId: beneficiaryId,
      requestKey: `${PREFIX}-settle-2`,
    });
    expect(settled.status, settled.text).toBe(201);
    expect(settled.body.quote.usd).toBe("5496.54");
    expect(toMoney(settled.body.quote.gainUsd).toFixed(2)).toBe("-57.46");

    const totals = await voucherTotals(settled.body.voucherId);
    expect(toMoney(totals.debit).eq(totals.credit)).toBe(true);

    expect((await bookUsd(agentAccountId)).abs().lte("0.01")).toBe(true);
    const snapshot = await walletSnapshot();
    expect(snapshot.state).toMatchObject({ usd: "0.000000", eur: "0.000000", eurBookUsd: "0.000000" });
    expect(snapshot.synchronized).toBe(true);
  });

  it("POST /api/factory/fx-agent-wallets/:id/reverse-conversion restores unused USD and refuses settled EUR", async () => {
    const reversalAccount = await ledgerAccount("REVERSAL", "FX reversal", "Asset", "1000");
    const activation = await agent.post("/api/factory/fx-agent-wallets").send({
      ledgerAccountId: reversalAccount,
      confirmUsdSource: true,
    });
    expect(activation.status, activation.text).toBe(201);
    const wid = activation.body.walletId;
    const initial = await agent.post(`/api/factory/fx-agent-wallets/${wid}/convert`).send({
      usdAmount: "1000",
      rateUsdPerEur: "1.25",
      requestKey: `${PREFIX}-reversal-convert1`,
    });
    expect(initial.status, initial.text).toBe(201);
    const conversions = await agent.get(`/api/factory/fx-agent-wallets/${wid}/conversions`);
    expect(conversions.status).toBe(200);
    expect(conversions.body.conversions[0]).toMatchObject({
      id: initial.body.id,
      reversed: false,
      hasLaterSettlement: false,
    });

    const reason = {
      conversionId: initial.body.id,
      reason: "Wrong conversion confirmed by agent",
      requestKey: `${PREFIX}-reverse-convert1`,
    };
    const reversed = await agent.post(`/api/factory/fx-agent-wallets/${wid}/reverse-conversion`).send(reason);
    expect(reversed.status, reversed.text).toBe(201);
    expect(reversed.body).toMatchObject({
      restoredUsd: "1000.000000",
      deductedEur: "800.000000",
      replayed: false,
    });
    const current = await agent.get("/api/factory/fx-agent-wallets");
    expect(current.status).toBe(200);
    const wallet = current.body.wallets.find((w: { wallet: { id: number } }) => w.wallet.id === wid);
    expect(wallet.state).toMatchObject({ usd: "1000.000000", eur: "0.000000", eurBookUsd: "0.000000" });
    expect(wallet.synchronized).toBe(true);
    expect((await bookUsd(reversalAccount)).toFixed(2)).toBe("1000.00");
    const replay = await agent.post(`/api/factory/fx-agent-wallets/${wid}/reverse-conversion`).send(reason);
    expect(replay.status).toBe(201);
    expect(replay.body).toMatchObject({ id: reversed.body.id, replayed: true });
    const alteredReason = await agent.post(`/api/factory/fx-agent-wallets/${wid}/reverse-conversion`).send({
      ...reason, reason: "Changed audit reason",
    });
    expect(alteredReason.status).toBe(400);
    const double = await agent.post(`/api/factory/fx-agent-wallets/${wid}/reverse-conversion`).send({
      ...reason,
      requestKey: `${PREFIX}-reverse-duplicate`,
    });
    expect(double.status).toBe(400);

    const next = await agent.post(`/api/factory/fx-agent-wallets/${wid}/convert`).send({
      usdAmount: "500",
      rateUsdPerEur: "1.25",
      requestKey: `${PREFIX}-reversal-convert2`,
    });
    expect(next.status, next.text).toBe(201);
    const paid = await agent.post(`/api/factory/fx-agent-wallets/${wid}/settle`).send({
      eurAmount: "100",
      rateUsdPerEur: "1.25",
      targetKind: "ledger",
      targetId: beneficiaryId,
      requestKey: `${PREFIX}-reversal-settle`,
    });
    expect(paid.status, paid.text).toBe(201);
    const forbidden = await agent.post(`/api/factory/fx-agent-wallets/${wid}/reverse-conversion`).send({
      conversionId: next.body.id,
      reason: "Cannot undo spent EUR",
      requestKey: `${PREFIX}-reverse-spent`,
    });
    expect(forbidden.status).toBe(400);
    expect(forbidden.body.message).toMatch(/paid out/i);
  });

  it("refuses further operations once ordinary journals drift the agent ledger", async () => {
    await pool.query(`UPDATE ledger_accounts SET opening_balance = '10100' WHERE id = $1`, [agentAccountId]);
    const snapshot = await walletSnapshot();
    expect(snapshot.synchronized).toBe(false);
    const blocked = await agent.post(`/api/factory/fx-agent-wallets/${walletId}/convert`).send({
      usdAmount: "50",
      rateUsdPerEur: "1.1",
      requestKey: `${PREFIX}-convert-drift`,
    });
    expect(blocked.status).toBe(400);
  });
});

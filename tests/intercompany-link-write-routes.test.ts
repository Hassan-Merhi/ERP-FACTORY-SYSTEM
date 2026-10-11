/**
 * Behavioural coverage for the intercompany link and payment-request routes.
 *
 * All five were guard-only. A link pairs a ledger account in one company with
 * one in another; when a payment is posted against the source account a request
 * is raised, and approving it posts the matching Receipt in the destination
 * company. That approval is the one that writes money into a second set of
 * books, so its guards are what this file is mostly about.
 *
 * What is pinned here:
 *
 *   - **Approval is a single claim.** The status is flipped by an
 *     `UPDATE ... WHERE status = 'pending'` inside the same transaction as the
 *     voucher, so two recipients racing produce one voucher, not two. Both the
 *     second attempt and the reverse order (dismiss after approve) are checked.
 *   - **Only a recipient with a role in the destination company may act**, and
 *     the account they nominate must belong to that company. Without the last
 *     check the Receipt's debit leg lands in whichever company the id happens
 *     to belong to while the credit stays in the destination — a voucher split
 *     across two companies' books.
 *   - **The Receipt is Dr chosen account / Cr the link's destination account**,
 *     for the request's amount, dated to the source voucher. Reversed, the
 *     destination company would look like it had paid rather than received.
 *   - **Recipients must be members of the destination company.** They are the
 *     people who get to approve, so the membership check on create and update
 *     is what keeps approval rights inside the receiving company.
 *
 * Not pinned, deliberately: the link routes carry `requireRole("Admin")` but no
 * check that the admin belongs to either linked company, so an admin of an
 * unrelated company can edit or delete any link by id. That is an authorisation
 * question about who owns intercompany configuration, not something to settle
 * from a test file.
 */
import request from "supertest";
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

import { pool } from "../server/db";
import { seedTestData, cleanupTestData, closeTestServer, type TestContext } from "./setup";

const TEST_PREFIX = "iclink";

let ctx: TestContext;
let agent: request.SuperAgentTest;
let destCompanyId: number;
let destAccountId: number;
let destCashAccountId: number;
let outsiderCompanyId: number;
let outsiderAccountId: number;
let linkId: number;
let sourceVoucherId: number;

async function createLink(recipients: string[] = [ctx.userId]): Promise<number> {
  const response = await agent.post("/api/intercompany-links").send({
    label: `${TEST_PREFIX} link`,
    sourceCompanyId: ctx.companyId,
    sourceLedgerAccountId: ctx.cashAccountId,
    destCompanyId,
    destLedgerAccountId: destAccountId,
    recipientUserIds: recipients,
  });
  if (response.status !== 200) throw new Error(`Seed link failed: ${response.status} ${response.text}`);
  return response.body.id;
}

async function createRequest(linkIdArg: number, amount = "500.00"): Promise<number> {
  const result = await pool.query<{ id: number }>(
    `INSERT INTO intercompany_payment_requests
       (link_id, from_company_id, from_voucher_id, from_voucher_number, from_voucher_date, amount, status)
     VALUES ($1, $2, $3, $4, '2026-06-01', $5, 'pending') RETURNING id`,
    [linkIdArg, ctx.companyId, sourceVoucherId, `${TEST_PREFIX}-SRC`, amount]
  );
  return result.rows[0].id;
}

async function requestRow(id: number) {
  const result = await pool.query<{
    status: string;
    dest_voucher_id: number | null;
    dest_ledger_account_id: number | null;
    approved_by_user_id: string | null;
    dismiss_note: string | null;
  }>(
    `SELECT status, dest_voucher_id, dest_ledger_account_id, approved_by_user_id, dismiss_note
     FROM intercompany_payment_requests WHERE id = $1`,
    [id]
  );
  return result.rows[0] ?? null;
}

async function voucherLegs(voucherId: number) {
  const result = await pool.query<{ ledger_account_id: number; debit_amount: string; credit_amount: string }>(
    `SELECT ledger_account_id, debit_amount, credit_amount FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
    [voucherId]
  );
  return result.rows;
}

async function recipientsOf(linkIdArg: number): Promise<string[]> {
  const result = await pool.query<{ user_id: string }>(
    `SELECT user_id FROM intercompany_link_recipients WHERE link_id = $1 ORDER BY user_id`,
    [linkIdArg]
  );
  return result.rows.map((row) => row.user_id);
}

async function destVoucherCount(): Promise<number> {
  const result = await pool.query<{ count: string }>(
    // Phase 22 (B): the receipt is numbered by the engine (RV-...); found by its type.
    `SELECT COUNT(*)::text AS count FROM vouchers WHERE company_id = $1 AND voucher_type = 'Receipt' AND deleted_at IS NULL`,
    [destCompanyId]
  );
  return Number(result.rows[0].count);
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  agent = request.agent(ctx.app);

  const login = await agent.post("/api/auth/login").send({
    username: `${TEST_PREFIX}_testuser`,
    password: "testpassword123",
  });
  if (login.status !== 200) throw new Error(`Login failed: ${login.status}`);
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });

  // The destination company, which the fixture user also belongs to — approval
  // requires a role there.
  const dest = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, base_currency)
     VALUES ($1, $2, 'erp', 'USD') RETURNING id`,
    [`${TEST_PREFIX.slice(0, 4).toUpperCase()}DST`, `${TEST_PREFIX}_DestCompany`]
  );
  destCompanyId = dest.rows[0].id;
  await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [
    ctx.userId,
    destCompanyId,
  ]);

  const destAccounts = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type) VALUES
       ($1, '9001', $2, 'Liability'), ($1, '9002', $3, 'Asset') RETURNING id`,
    [destCompanyId, `${TEST_PREFIX} IC Account`, `${TEST_PREFIX} Dest Cash`]
  );
  destAccountId = destAccounts.rows[0].id;
  destCashAccountId = destAccounts.rows[1].id;

  // A third company the fixture user has no role in, for the "wrong company"
  // cases.
  const outsider = await pool.query<{ id: number }>(
    `INSERT INTO companies (code, name, company_type, base_currency)
     VALUES ($1, $2, 'erp', 'USD') RETURNING id`,
    [`${TEST_PREFIX.slice(0, 4).toUpperCase()}OUT`, `${TEST_PREFIX}_OutsiderCompany`]
  );
  outsiderCompanyId = outsider.rows[0].id;
  const outsiderAccount = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type)
     VALUES ($1, '9003', $2, 'Asset') RETURNING id`,
    [outsiderCompanyId, `${TEST_PREFIX} Outsider Cash`]
  );
  outsiderAccountId = outsiderAccount.rows[0].id;

  const sourceVoucher = await pool.query<{ id: number }>(
    `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency)
     VALUES ($1, $2, 'Payment', '2026-06-01', '500.00', 'USD') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-SRC`]
  );
  sourceVoucherId = sourceVoucher.rows[0].id;
}, 120000);

beforeEach(async () => {
  await pool.query(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [
    destCompanyId,
  ]);
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1`, [destCompanyId]);
  await pool.query(
    `DELETE FROM intercompany_payment_requests WHERE link_id IN
       (SELECT id FROM intercompany_account_links WHERE source_company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(
    `DELETE FROM intercompany_link_recipients WHERE link_id IN
       (SELECT id FROM intercompany_account_links WHERE source_company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM intercompany_account_links WHERE source_company_id = $1`, [ctx.companyId]);
  linkId = await createLink();
});

afterAll(async () => {
  await pool.query(
    `DELETE FROM intercompany_payment_requests WHERE link_id IN
       (SELECT id FROM intercompany_account_links WHERE source_company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(
    `DELETE FROM intercompany_link_recipients WHERE link_id IN
       (SELECT id FROM intercompany_account_links WHERE source_company_id = $1)`,
    [ctx.companyId]
  );
  await pool.query(`DELETE FROM intercompany_account_links WHERE source_company_id = $1`, [ctx.companyId]);
  await pool.query(
    `DELETE FROM voucher_entries WHERE voucher_id IN
       (SELECT id FROM vouchers WHERE company_id = ANY($1))`,
    [[destCompanyId, outsiderCompanyId]]
  );
  await pool.query(`DELETE FROM vouchers WHERE company_id = ANY($1)`, [[destCompanyId, outsiderCompanyId]]);
  await pool.query(`DELETE FROM ledger_accounts WHERE company_id = ANY($1)`, [[destCompanyId, outsiderCompanyId]]);
  await pool.query(`DELETE FROM user_company_roles WHERE company_id = ANY($1)`, [[destCompanyId, outsiderCompanyId]]);
  await pool.query(`DELETE FROM companies WHERE id = ANY($1)`, [[destCompanyId, outsiderCompanyId]]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 60000);

describe("POST /api/intercompany-links", () => {
  it("stores the pairing and its recipients", async () => {
    const row = await pool.query<{ source_company_id: number; dest_company_id: number; active: boolean }>(
      `SELECT source_company_id, dest_company_id, active FROM intercompany_account_links WHERE id = $1`,
      [linkId]
    );
    expect(row.rows[0].source_company_id).toBe(ctx.companyId);
    expect(row.rows[0].dest_company_id).toBe(destCompanyId);
    expect(row.rows[0].active).toBe(true);
    expect(await recipientsOf(linkId)).toEqual([ctx.userId]);
  });

  it("refuses a recipient with no role in the destination company", async () => {
    const foreignUser = await pool.query<{ id: string }>(`SELECT id FROM users WHERE id <> $1 ORDER BY id LIMIT 1`, [
      ctx.userId,
    ]);
    if (foreignUser.rowCount === 0) return;

    const response = await agent.post("/api/intercompany-links").send({
      sourceCompanyId: ctx.companyId,
      sourceLedgerAccountId: ctx.cashAccountId,
      destCompanyId,
      destLedgerAccountId: destAccountId,
      recipientUserIds: [foreignUser.rows[0].id],
    });

    // Recipients are the people who get to approve money into the destination
    // company; membership there is what keeps that right inside it.
    expect(response.status).toBe(400);
  });

  it("is refused outright for a company the session cannot reach", async () => {
    const response = await agent.post("/api/intercompany-links").send({
      sourceCompanyId: outsiderCompanyId,
      sourceLedgerAccountId: outsiderAccountId,
      destCompanyId,
      destLedgerAccountId: destAccountId,
    });

    // A body companyId naming a company the session has no role in is rejected
    // by middleware before the handler sees it — a stronger guarantee than the
    // handler's own checks, and worth holding as one.
    expect(response.status).toBe(403);
  });

  it("requires both sides of the pairing", async () => {
    const response = await agent
      .post("/api/intercompany-links")
      .send({ sourceCompanyId: ctx.companyId, sourceLedgerAccountId: ctx.cashAccountId });
    expect(response.status).toBe(400);
  });
});

describe("PUT /api/intercompany-links/:id", () => {
  it("replaces the recipient list wholesale rather than adding to it", async () => {
    const response = await agent.put(`/api/intercompany-links/${linkId}`).send({ recipientUserIds: [] });

    expect(response.status).toBe(200);
    // Removing someone has to actually remove them — a merge would leave a
    // revoked approver still able to approve.
    expect(await recipientsOf(linkId)).toEqual([]);
  });

  it("deactivates the link without deleting it", async () => {
    const response = await agent.put(`/api/intercompany-links/${linkId}`).send({ active: false });

    expect(response.status).toBe(200);
    const row = await pool.query<{ active: boolean }>(`SELECT active FROM intercompany_account_links WHERE id = $1`, [
      linkId,
    ]);
    expect(row.rows[0].active).toBe(false);
  });

  it("refuses a recipient with no role in the destination company", async () => {
    const foreignUser = await pool.query<{ id: string }>(`SELECT id FROM users WHERE id <> $1 ORDER BY id LIMIT 1`, [
      ctx.userId,
    ]);
    if (foreignUser.rowCount === 0) return;

    const response = await agent
      .put(`/api/intercompany-links/${linkId}`)
      .send({ recipientUserIds: [foreignUser.rows[0].id] });

    expect(response.status).toBe(400);
    expect(await recipientsOf(linkId)).toEqual([ctx.userId]);
  });

  it("returns 404 for an unknown link", async () => {
    expect((await agent.put("/api/intercompany-links/99999999").send({ active: false })).status).toBe(404);
  });
});

describe("DELETE /api/intercompany-links/:id", () => {
  it("removes the link", async () => {
    const response = await agent.delete(`/api/intercompany-links/${linkId}`);
    expect(response.status).toBe(200);

    const rows = await pool.query(`SELECT id FROM intercompany_account_links WHERE id = $1`, [linkId]);
    expect(rows.rowCount).toBe(0);
  });
});

describe("POST /api/intercompany-requests/:id/approve", () => {
  it("posts Dr chosen account / Cr the link's account in the destination company", async () => {
    const requestId = await createRequest(linkId, "500.00");

    const response = await agent
      .post(`/api/intercompany-requests/${requestId}/approve`)
      .send({ destLedgerAccountId: destCashAccountId });
    expect(response.status).toBe(200);

    const row = await requestRow(requestId);
    expect(row?.status).toBe("approved");
    expect(row?.dest_voucher_id).toBe(response.body.voucherId);
    expect(row?.approved_by_user_id).toBe(ctx.userId);

    const voucher = await pool.query<{ company_id: number; voucher_type: string; voucher_date: string }>(
      `SELECT company_id, voucher_type, voucher_date::text AS voucher_date FROM vouchers WHERE id = $1`,
      [response.body.voucherId]
    );
    expect(voucher.rows[0].company_id).toBe(destCompanyId);
    expect(voucher.rows[0].voucher_type).toBe("Receipt");
    expect(voucher.rows[0].voucher_date).toBe("2026-06-01");

    const legs = await voucherLegs(response.body.voucherId);
    expect(legs).toHaveLength(2);
    const debitLeg = legs.find((leg) => leg.ledger_account_id === destCashAccountId);
    const creditLeg = legs.find((leg) => leg.ledger_account_id === destAccountId);
    // The destination company received the money: the account it landed in is
    // debited, the intercompany account credited. Reversed, the receiving
    // company reads as having paid.
    expect(Number(debitLeg?.debit_amount)).toBeCloseTo(500, 2);
    expect(Number(creditLeg?.credit_amount)).toBeCloseTo(500, 2);
  });

  it("posts only once when the same request is approved twice", async () => {
    const requestId = await createRequest(linkId);
    expect(
      (
        await agent
          .post(`/api/intercompany-requests/${requestId}/approve`)
          .send({ destLedgerAccountId: destCashAccountId })
      ).status
    ).toBe(200);

    const second = await agent
      .post(`/api/intercompany-requests/${requestId}/approve`)
      .send({ destLedgerAccountId: destCashAccountId });

    // Two recipients can be looking at the same notification. The status claim
    // and the voucher share a transaction so only one of them can post.
    expect(second.status).toBe(400);
    expect(await destVoucherCount()).toBe(1);
  });

  it("refuses an account that belongs to another company", async () => {
    const requestId = await createRequest(linkId);

    const response = await agent
      .post(`/api/intercompany-requests/${requestId}/approve`)
      .send({ destLedgerAccountId: outsiderAccountId });

    // Without this check the debit leg lands in a third company while the
    // credit stays in the destination — one voucher across two sets of books.
    expect(response.status).toBe(400);
    expect((await requestRow(requestId))?.status).toBe("pending");
    expect(await destVoucherCount()).toBe(0);
  });

  it("refuses a user who is not a recipient of the link", async () => {
    await agent.put(`/api/intercompany-links/${linkId}`).send({ recipientUserIds: [] });
    const requestId = await createRequest(linkId);

    const response = await agent
      .post(`/api/intercompany-requests/${requestId}/approve`)
      .send({ destLedgerAccountId: destCashAccountId });

    expect(response.status).toBe(403);
    expect(await destVoucherCount()).toBe(0);
  });

  it("requires an account, and 404s an unknown request", async () => {
    const requestId = await createRequest(linkId);
    expect((await agent.post(`/api/intercompany-requests/${requestId}/approve`).send({})).status).toBe(400);
    expect(
      (await agent.post("/api/intercompany-requests/99999999/approve").send({ destLedgerAccountId: destCashAccountId }))
        .status
    ).toBe(404);
  });
});

describe("POST /api/intercompany-requests/:id/dismiss", () => {
  it("closes the request with its note and posts nothing", async () => {
    const requestId = await createRequest(linkId);

    const response = await agent
      .post(`/api/intercompany-requests/${requestId}/dismiss`)
      .send({ note: `${TEST_PREFIX} not ours` });
    expect(response.status).toBe(200);

    const row = await requestRow(requestId);
    expect(row?.status).toBe("dismissed");
    expect(row?.dismiss_note).toBe(`${TEST_PREFIX} not ours`);
    expect(row?.approved_by_user_id).toBe(ctx.userId);
    // Dismissing is a decision not to receive; nothing may reach the ledger.
    expect(await destVoucherCount()).toBe(0);
  });

  it("cannot dismiss a request that was already approved", async () => {
    const requestId = await createRequest(linkId);
    await agent
      .post(`/api/intercompany-requests/${requestId}/approve`)
      .send({ destLedgerAccountId: destCashAccountId });

    const response = await agent.post(`/api/intercompany-requests/${requestId}/dismiss`).send({});

    // The receipt is already posted. Flipping the status now would leave a
    // voucher in the destination company with nothing claiming it.
    expect(response.status).toBe(400);
    expect((await requestRow(requestId))?.status).toBe("approved");
  });

  it("refuses a user who is not a recipient of the link", async () => {
    await agent.put(`/api/intercompany-links/${linkId}`).send({ recipientUserIds: [] });
    const requestId = await createRequest(linkId);

    const response = await agent.post(`/api/intercompany-requests/${requestId}/dismiss`).send({});

    expect(response.status).toBe(403);
    expect((await requestRow(requestId))?.status).toBe("pending");
  });

  it("returns 404 for an unknown request", async () => {
    expect((await agent.post("/api/intercompany-requests/99999999/dismiss").send({})).status).toBe(404);
  });
});

/**
 * Wave 16 (A) — boot-time repairs and voucher hard deletes (accounting audit 2026-10):
 *
 *   1  the insurance direction repair and the SP supplier link repair no longer
 *      run at boot; each is an Owner preview (plan hash) / apply (one
 *      transaction, company-scoped, closed periods skipped, audited); the SP
 *      container trigger no longer moves the supplier of posted lines and the
 *      integrity diagnostic lists the mismatch; the Phase 3 historical repair
 *      is a preview/apply too;
 *   2  POST /api/reverse-po-credits is gone; a system-removed voucher is
 *      retired (soft delete with its lines, audited, number and posting
 *      identity released) and a linked journal posted again keeps its old
 *      voucher in the history; a replay of a deleted voucher's request is
 *      refused instead of posting it again; a retired voucher is not
 *      restorable;
 *   3  a location holding stock cannot be permanently deleted.
 */
import { sql } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { MoneyDecimal } from "../server/lib/money";
import { runAccountingIntegrityDiagnostic } from "../server/services/accounting/integrity/accountingIntegrityDiagnostic";
import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../server/services/accounting/infrastructureVoucherIdentity";
import {
  postLinkedJournalTx,
  removeLinkedJournalTx,
} from "../server/services/accounting/perpetualInventory/linkedJournal";
import { isRetiredVoucherNumber, retiredVoucherNumber } from "../server/services/accounting/voucherRetirement";
import { ensureSpSupplierVoucherSyncTrigger } from "../server/routes/sp/spSupplierVoucherSync";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const TEST_PREFIX = "w16a";
let ctx: TestContext;
let agent: request.SuperAgentTest;
let sequence = 0;

const next = () => {
  sequence += 1;
  return sequence;
};

async function ledgerAccount(name: string, accountType: string, subType: string | null = null): Promise<number> {
  const { rows } = await pool.query<{ id: number }>(
    `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
     VALUES ($1, $2, $3, $4, $5, 0, 'Dr') RETURNING id`,
    [ctx.companyId, `${TEST_PREFIX}-A${next()}`, name, accountType, subType]
  );
  return rows[0].id;
}

/** A balanced voucher with its lines, written in one transaction. */
async function voucher(
  number: string,
  date: string,
  lines: Array<{ account: number; debit: string; credit: string; supplierId?: number | null }>,
  extra: { sourceModule?: string; supplierId?: number | null; legacy?: boolean } = {}
): Promise<number> {
  return withFixtureTransaction(
    async (client) => {
      const total = lines.reduce((sum, line) => sum.plus(line.debit), new MoneyDecimal(0)).toFixed(2);
      const { rows } = await client.query<{ id: number }>(
        `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, source_module)
       VALUES ($1, $2, 'Journal', $3, $4, 'USD', $5) RETURNING id`,
        [ctx.companyId, number, date, total, extra.sourceModule ?? "ERP"]
      );
      const id = rows[0].id;
      if (extra.supplierId !== undefined) {
        await client.query(`UPDATE vouchers SET supplier_id = $2 WHERE id = $1`, [id, extra.supplierId]);
      }
      for (const line of lines) {
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount, supplier_id)
         VALUES ($1, $2, $3, $4, $5)`,
          [id, line.account, line.debit, line.credit, line.supplierId ?? null]
        );
      }
      return id;
    },
    { legacyUnbalanced: extra.legacy === true }
  );
}

async function auditRows(where: string, params: unknown[]) {
  const { rows } = await pool.query(
    `SELECT action, table_name, record_id, record_identifier, changes FROM audit_log
      WHERE company_id = $1 AND ${where} ORDER BY id`,
    [ctx.companyId, ...params]
  );
  return rows as Array<{ action: string; table_name: string; record_id: number; changes: Record<string, unknown> }>;
}

beforeAll(async () => {
  ctx = await seedTestData(TEST_PREFIX);
  await pool.query(`UPDATE user_company_roles SET role = 'Owner' WHERE user_id = $1 AND company_id = $2`, [
    ctx.userId,
    ctx.companyId,
  ]);
  agent = request.agent(ctx.app);
  await agent.post("/api/auth/login").send({ username: `${TEST_PREFIX}_testuser`, password: "testpassword123" });
  await agent.post("/api/auth/set-company").send({ companyId: ctx.companyId });
}, 120_000);

afterAll(async () => {
  const id = ctx.companyId;
  await pool.query(`DELETE FROM fiscal_period_closures WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM sp_containers WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM accounting_posting_requests WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM voucher_entries WHERE voucher_id IN (SELECT id FROM vouchers WHERE company_id = $1)`, [
    id,
  ]);
  await pool.query(`DELETE FROM vouchers WHERE company_id = $1`, [id]);
  await pool.query(`DELETE FROM suppliers WHERE company_id = $1`, [id]);
  await deleteAuditLogRowsForTests(pool, "company_id = $1", [id]);
  await cleanupTestData(TEST_PREFIX);
  closeTestServer();
}, 120_000);

describe("voucher retirement and linked journals posted again (decision 2)", () => {
  it("keeps the old journal soft-deleted with its lines, gives up its number and identity, and audits it", async () => {
    const number = `${TEST_PREFIX}-LJ-${next()}`;
    const lines = (amount: string) => [
      {
        ledgerAccountId: ctx.cashAccountId,
        debit: new MoneyDecimal(amount),
        credit: new MoneyDecimal(0),
        narration: "t",
      },
      {
        ledgerAccountId: ctx.salesAccountId,
        debit: new MoneyDecimal(0),
        credit: new MoneyDecimal(amount),
        narration: "t",
      },
    ];
    const params = (amount: string) => ({
      companyId: ctx.companyId,
      voucherNumber: number,
      voucherDate: "2026-09-01",
      description: "w16 linked journal",
      identity: { sourceType: "w16-linked", sourceId: number },
      lines: lines(amount),
    });
    const firstId = await db.transaction((tx) => postLinkedJournalTx(tx, params("10.00")));
    const secondId = await db.transaction(async (tx) => {
      await removeLinkedJournalTx(tx, ctx.companyId, number);
      return postLinkedJournalTx(tx, params("12.00"));
    });
    expect(secondId).not.toBe(firstId);

    const { rows } = await pool.query(
      `SELECT id, voucher_number, deleted_at IS NOT NULL AS deleted,
              (SELECT COUNT(*)::int FROM voucher_entries ve WHERE ve.voucher_id = v.id) AS lines
         FROM vouchers v WHERE company_id = $1 AND id = ANY($2::int[]) ORDER BY id`,
      [ctx.companyId, [firstId, secondId]]
    );
    expect(rows).toEqual([
      { id: firstId, voucher_number: retiredVoucherNumber(number, firstId!), deleted: true, lines: 2 },
      { id: secondId, voucher_number: number, deleted: false, lines: 2 },
    ]);
    expect(isRetiredVoucherNumber(rows[0].voucher_number)).toBe(true);

    const markers = await pool.query(
      `SELECT voucher_id, idempotency_key FROM accounting_posting_requests WHERE company_id = $1 AND voucher_id = ANY($2::int[]) ORDER BY voucher_id`,
      [ctx.companyId, [firstId, secondId]]
    );
    expect(markers.rows[0].idempotency_key).toContain(`#retired:${firstId}`);
    expect(markers.rows[1].idempotency_key).not.toContain("#retired:");

    const audit = await auditRows("table_name = 'vouchers' AND record_id = $2 AND action = 'delete'", [firstId]);
    expect(audit).toHaveLength(1);
    const changes = audit[0].changes as {
      entries: { old: unknown[] };
      voucherNumber: { old: string; new: string };
      reason: { new: string };
    };
    expect(changes.entries.old).toHaveLength(2);
    expect(changes.voucherNumber).toEqual({ old: number, new: retiredVoucherNumber(number, firstId!) });
    expect(changes.reason.new).toBe("linked-journal-replaced");

    // A retired voucher is not restorable from Deleted Items.
    const restore = await agent.post(`/api/deleted-items/voucher/${firstId}/restore`).send({});
    expect(restore.status).toBe(409);
    expect(restore.body.code).toBe("RETIRED_VOUCHER_NOT_RESTORABLE");
  });

  it("refuses to post again a request whose voucher was deleted (posting identity replay)", async () => {
    const sourceId = `${TEST_PREFIX}-replay-${next()}`;
    const identity = infrastructurePostingIdentity("w16-replay", sourceId);
    const header = {
      companyId: ctx.companyId,
      voucherNumber: sourceId,
      voucherType: "Journal",
      voucherDate: "2026-09-02",
      totalAmount: "5.00",
      currency: "USD",
    };
    const post = () =>
      db.transaction(async (tx) => {
        const { voucher: posted } = await insertInfrastructureVoucherTx(tx, header, identity);
        await tx.execute(
          // Lines in the same transaction as the voucher (balance guard).
          sql`INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
            VALUES (${posted.id}, ${ctx.cashAccountId}, 5, 0), (${posted.id}, ${ctx.salesAccountId}, 0, 5)`
        );
        return posted.id;
      });
    const id = await post();
    // The user deletes the voucher (soft delete; the marker stays).
    await pool.query(`UPDATE vouchers SET deleted_at = now() WHERE id = $1`, [id]);
    await expect(post()).rejects.toMatchObject({ code: "POSTING_SOURCE_VOUCHER_DELETED" });
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM vouchers WHERE company_id = $1 AND voucher_number = $2`,
      [ctx.companyId, sourceId]
    );
    expect(rows[0].n).toBe(1);
  });
});

describe("retired routes and location permanent delete (decisions 2 and 3)", () => {
  it("POST /api/reverse-po-credits no longer exists", async () => {
    const response = await agent.post("/api/reverse-po-credits").send({ companyId: ctx.companyId, parentCompanyId: 1 });
    expect(response.status).toBe(404);
  });

  it("refuses to permanently delete a location that still holds stock", async () => {
    const { rows } = await pool.query<{ id: number }>(
      `INSERT INTO locations (company_id, code, name, active, deleted_at) VALUES ($1, $2, $3, false, now()) RETURNING id`,
      [ctx.companyId, `${TEST_PREFIX}-LOC${next()}`, `${TEST_PREFIX} location`]
    );
    const locationId = rows[0].id;
    await pool.query(
      `INSERT INTO inventory (company_id, location_id, stock_item_id, quantity, average_rate, total_value)
       VALUES ($1, $2, $3, 0, 0, 4.50)`,
      [ctx.companyId, locationId, ctx.stockItemIds[0]]
    );
    const refused = await agent.delete(`/api/deleted-items/location/${locationId}/permanent`);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toContain("still holds stock");
    expect((await pool.query(`SELECT 1 FROM locations WHERE id = $1`, [locationId])).rowCount).toBe(1);

    await pool.query(`DELETE FROM inventory WHERE location_id = $1`, [locationId]);
    const deleted = await agent.delete(`/api/deleted-items/location/${locationId}/permanent`);
    expect(deleted.status).toBe(200);
    expect((await pool.query(`SELECT 1 FROM locations WHERE id = $1`, [locationId])).rowCount).toBe(0);
    expect(await auditRows("table_name = 'locations' AND record_id = $2", [locationId])).toHaveLength(1);
  });
});

describe("insurance direction repair as a reviewed tool (decision 1)", () => {
  it("previews, refuses a changed plan, skips a closed period, and applies with audit", async () => {
    const expense = await ledgerAccount("Insurance Expense", "Expense");
    const liability = await ledgerAccount(`Insurance - ${TEST_PREFIX} member`, "Liability");
    const open = await voucher(`INS-${TEST_PREFIX}-${next()}`, "2026-09-05", [
      { account: expense, debit: "100.00", credit: "0" },
      { account: liability, debit: "0", credit: "100.00" },
    ]);
    const closed = await voucher(`INS-${TEST_PREFIX}-${next()}`, "2025-01-05", [
      { account: expense, debit: "40.00", credit: "0" },
      { account: liability, debit: "0", credit: "40.00" },
    ]);
    await pool.query(
      `INSERT INTO fiscal_period_closures (company_id, period_start_date, period_end_date, closed_by_user_id,
         closing_voucher_id, retained_earnings_account_id, total_income, total_expense, net_income, status)
       VALUES ($1, '2025-01-01', '2025-01-31', $2, $3, $4, 0, 0, 0, 'CLOSED')`,
      [ctx.companyId, ctx.userId, closed, ctx.cashAccountId]
    );

    const preview = await agent.get("/api/insurance/admin/journal-direction/plan");
    expect(preview.status).toBe(200);
    expect(preview.body.candidates.map((c: { voucherId: number }) => c.voucherId)).toEqual([open]);
    expect(preview.body.skipped).toContainEqual(
      expect.objectContaining({ voucherId: closed, reason: "PERIOD_CLOSED" })
    );
    const line = preview.body.candidates[0].lines.find(
      (l: { ledgerAccountId: number }) => l.ledgerAccountId === expense
    );
    expect(line).toMatchObject({ debit: "100.00", credit: "0.00", newDebit: "0.00", newCredit: "100.00" });

    const stale = await agent
      .post("/api/insurance/admin/journal-direction/apply")
      .send({ confirm: true, planHash: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe("PLAN_CHANGED");

    const applied = await agent
      .post("/api/insurance/admin/journal-direction/apply")
      .send({ confirm: true, planHash: preview.body.planHash });
    expect(applied.status).toBe(200);
    expect(applied.body.repairedVoucherIds).toEqual([open]);

    const { rows } = await pool.query(
      `SELECT voucher_id, ledger_account_id, debit_amount::text AS d, credit_amount::text AS c
         FROM voucher_entries WHERE voucher_id = ANY($1::int[]) ORDER BY voucher_id, ledger_account_id`,
      [[open, closed]]
    );
    const byVoucher = (id: number, account: number) =>
      rows.find(
        (r: { voucher_id: number; ledger_account_id: number }) => r.voucher_id === id && r.ledger_account_id === account
      );
    expect(byVoucher(open, expense)).toMatchObject({ d: "0.00", c: "100.00" });
    expect(byVoucher(open, liability)).toMatchObject({ d: "100.00", c: "0.00" });
    // The closed-period voucher is untouched.
    expect(byVoucher(closed, expense)).toMatchObject({ d: "40.00", c: "0.00" });
    expect(await auditRows("record_identifier = 'insurance-journal-direction-repair'", [])).toHaveLength(1);
  });
});

describe("SP supplier links: no rewrite of posted lines, listed, reviewed apply (decision 1)", () => {
  it("leaves a posted voucher's supplier when the container's changes, lists it and repairs it audited", async () => {
    await ensureSpSupplierVoucherSyncTrigger();
    const supplier = async (name: string) =>
      (
        await pool.query<{ id: number }>(
          `INSERT INTO suppliers (company_id, code, legal_name, email, active) VALUES ($1, $2, $3, $4, true) RETURNING id`,
          [ctx.companyId, `${TEST_PREFIX}-S${next()}`, name, `${TEST_PREFIX}${sequence}@example.test`]
        )
      ).rows[0].id;
    const supplierA = await supplier("w16 A");
    const supplierB = await supplier("w16 B");
    const otw = await ledgerAccount(`${TEST_PREFIX} Goods OTW`, "Asset", "sp_otw");
    const clearing = await ledgerAccount(`${TEST_PREFIX} OTW clearing`, "Liability", "sp_otw_clearing");
    const voucherId = await voucher(
      `SP-OTW-${TEST_PREFIX}-${next()}`,
      "2026-09-06",
      [
        { account: otw, debit: "70.00", credit: "0" },
        { account: clearing, debit: "0", credit: "70.00", supplierId: supplierA },
      ],
      // A legacy OTW line names its clearing account and its supplier (the
      // line-target guard of wave 16 B refuses that shape for new lines).
      { sourceModule: "SP", supplierId: supplierA, legacy: true }
    );
    const container = await pool.query<{ id: number }>(
      `INSERT INTO sp_containers (company_id, supplier_id, supplier_name, invoice_number, invoice_date, goods_otw_voucher_id)
       VALUES ($1, $2, 'w16 A', $3, '2026-09-06', $4) RETURNING id`,
      [ctx.companyId, supplierA, `${TEST_PREFIX}-INV`, voucherId]
    );
    await pool.query(`UPDATE sp_containers SET supplier_id = $2 WHERE id = $1`, [container.rows[0].id, supplierB]);

    const read = async () =>
      (
        await pool.query(
          `SELECT v.supplier_id AS header, ve.supplier_id AS line
             FROM vouchers v JOIN voucher_entries ve ON ve.voucher_id = v.id AND ve.ledger_account_id = $2
            WHERE v.id = $1`,
          [voucherId, clearing]
        )
      ).rows[0];
    expect(await read()).toEqual({ header: supplierA, line: supplierA });

    const report = await runAccountingIntegrityDiagnostic(ctx.companyId);
    const listed = report.checks.find((c) => c.key === "sp_supplier_voucher_link_mismatch");
    expect(listed?.status).toBe("warn");
    expect(listed?.samples).toContainEqual(expect.objectContaining({ voucher_id: voucherId }));

    // The line-target guard (wave 16 B) refuses any write to a line naming
    // both its clearing account and a supplier, so the apply is shown on the
    // header: the legacy line is moved to the new supplier here, as legacy.
    await withFixtureTransaction(
      (client) =>
        client.query(`UPDATE voucher_entries SET supplier_id = $2 WHERE voucher_id = $1 AND ledger_account_id = $3`, [
          voucherId,
          supplierB,
          clearing,
        ]),
      { legacyUnbalanced: true }
    );

    // The SP routes answer for a supplier-partner company only.
    const { rows: typeRows } = await pool.query(`SELECT company_type FROM companies WHERE id = $1`, [ctx.companyId]);
    await pool.query(`UPDATE companies SET company_type = 'supplier_partner' WHERE id = $1`, [ctx.companyId]);
    try {
      const preview = await agent.get("/api/sp/admin/supplier-voucher-links/plan");
      expect(preview.status).toBe(200);
      const planned = preview.body.vouchers.find((v: { voucherId: number }) => v.voucherId === voucherId);
      expect(planned.header).toEqual({ from: supplierA, to: supplierB });
      expect(planned.lines).toEqual([]);
      const stale = await agent
        .post("/api/sp/admin/supplier-voucher-links/apply")
        .send({ confirm: true, planHash: "0".repeat(64) });
      expect(stale.status).toBe(409);
      const applied = await agent
        .post("/api/sp/admin/supplier-voucher-links/apply")
        .send({ confirm: true, planHash: preview.body.planHash });
      expect(applied.status).toBe(200);
      expect(await read()).toEqual({ header: supplierB, line: supplierB });
      expect(await auditRows("record_identifier = 'sp-supplier-voucher-link-repair'", [])).toHaveLength(1);
    } finally {
      await pool.query(`UPDATE companies SET company_type = $2 WHERE id = $1`, [
        ctx.companyId,
        typeRows[0].company_type,
      ]);
    }
  });
});

describe("Phase 3 historical repair is no longer a boot step (decision 1)", () => {
  it("previews a legacy PO without a debit and applies it with the reviewed hash, audited", async () => {
    const credit = await ledgerAccount(`${TEST_PREFIX} PO credit`, "Liability");
    const purchases = await ledgerAccount("Purchases", "Expense");
    const po = await withFixtureTransaction(
      async (client) => {
        const { rows } = await client.query<{ id: number }>(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, currency, source_module)
           VALUES ($1, $2, 'Purchase', '2026-09-07', 25, 'USD', 'ERP') RETURNING id`,
          [ctx.companyId, `PO-PO-${TEST_PREFIX}-${next()}`]
        );
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 0, 25)`,
          [rows[0].id, credit]
        );
        return rows[0].id;
      },
      { legacyUnbalanced: true }
    );
    const preview = await agent.get("/api/accounting/phase3-historical/plan");
    expect(preview.status).toBe(200);
    expect(preview.body.purchaseDebits).toContainEqual(expect.objectContaining({ voucherId: po, amount: "25.00" }));
    const applied = await agent
      .post("/api/accounting/phase3-historical/apply")
      .send({ confirm: true, planHash: preview.body.planHash });
    expect(applied.status).toBe(200);
    const { rows } = await pool.query(
      `SELECT ledger_account_id, debit_amount::text AS d FROM voucher_entries WHERE voucher_id = $1 AND debit_amount > 0`,
      [po]
    );
    expect(rows).toEqual([{ ledger_account_id: purchases, d: "25.00" }]);
    expect(await auditRows("record_identifier = 'phase3-historical-repair'", [])).toHaveLength(1);
  });
});

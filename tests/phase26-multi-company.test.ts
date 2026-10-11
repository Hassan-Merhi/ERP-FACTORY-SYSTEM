/**
 * Phase 26 — multi-company and consolidation (accounting audit 2026-10).
 *
 *   MC-1  transfers post against Intercompany-typed accounts recorded on the link;
 *   MC-3  the rental auto-transfer posts inside the payment's transaction;
 *   MC-4  the POS cash mirror posts inside the sale's transaction, always two-sided;
 *   MC-6  consolidation: eliminations by pair, balanced;
 *   MC-7  the parent comes from companies.parent_company_id;
 *   MC-9  the PO-import parent pair by id;
 *   MC-10 lines on another company's accounts: Owner plan/apply (retire + re-post);
 *   MC-11 transfer links are soft-deleted;
 *   leftover: legacy SHA-256 supervisor passwords rehashed to bcrypt on success.
 */
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import { storage } from "../server/storage";
import { postIntercompanyTransferTx } from "../server/services/accounting/intercompany/intercompanyTransferPosting";
import { simpleCompanyTransferService } from "../server/routes/transfers/simpleCompanyTransferService";
import { interCompanyTransferService } from "../server/routes/transfers/interCompanyTransferService";
import { postIntercompanyPosMirrorTx } from "../server/routes/helpers/intercompanyHelpers";
import { runRentalAutoTransferTx } from "../server/routes/rental/shared/auto-transfer";
import { loadCompanyIntercompanyAccounts } from "../server/helpers/groupIntercompany";
import { buildConsolidation } from "../server/services/accounting/consolidation/consolidationService";
import {
  applyCrossCompanyLineReclass,
  planCrossCompanyLineReclass,
} from "../server/services/accounting/intercompany/crossCompanyLineReclass";
import { runMultiCompanyDiagnostic } from "../server/services/accounting/intercompany/multiCompanyDiagnostic";
import { verifySupervisorPasswordForUser } from "../server/routes/factory/_helpers";
import { listLegacyPasswordHashUsers } from "../server/services/security/legacyPasswordRehash";
import { deleteAuditLogRowsForTests } from "./helpers/auditLogCleanup";
import { withFixtureTransaction } from "./helpers/voucherFixtureTransaction";
import { cleanupTestData, closeTestServer, seedTestData, type TestContext } from "./setup";

const PREFIXES = ["p26mcA", "p26mcB", "p26mcC"] as const;
let parent: TestContext;
let child: TestContext;
let other: TestContext;
let seq = 0;

async function one<T extends Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T> {
  const result = await pool.query(text, params);
  return result.rows[0] as T;
}

async function account(companyId: number, code: string, type: string, subType: string | null = null) {
  return (
    await one<{ id: number }>(
      `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance)
       VALUES ($1, $2, $3, $4, $5, '0') RETURNING id`,
      [companyId, code, code, type, subType]
    )
  ).id;
}

/** A balanced, live fixture voucher (raw rows, like legacy data). */
async function voucher(
  companyId: number,
  date: string,
  lines: { accountId: number; debit?: string; credit?: string }[],
  type = "Journal"
): Promise<number> {
  seq += 1;
  return withFixtureTransaction(async (client) => {
    const total = lines.reduce((sum, line) => sum + Number(line.debit ?? 0), 0).toFixed(2);
    const { rows } = await client.query(
      `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [companyId, `P26-${companyId}-${seq}-${Date.now()}`, type, date, total]
    );
    for (const line of lines) {
      await client.query(
        `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4)`,
        [rows[0].id, line.accountId, line.debit ?? "0", line.credit ?? "0"]
      );
    }
    return Number(rows[0].id);
  });
}

beforeAll(async () => {
  parent = await seedTestData(PREFIXES[0]);
  child = await seedTestData(PREFIXES[1]);
  other = await seedTestData(PREFIXES[2]);
  await pool.query(`UPDATE companies SET parent_company_id = $1 WHERE id = $2`, [parent.companyId, child.companyId]);
  // The seeded user is a member of its own company only; transfers need both.
  for (const companyId of [child.companyId, other.companyId]) {
    await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Admin')`, [
      parent.userId,
      companyId,
    ]);
  }
}, 180_000);

afterAll(async () => {
  const ids = [parent?.companyId, child?.companyId, other?.companyId].filter(Boolean);
  await pool.query(`DELETE FROM inter_company_transfers WHERE from_company_id = ANY($1) OR to_company_id = ANY($1)`, [
    ids,
  ]);
  await pool.query(`DELETE FROM intercompany_pos_configs WHERE source_company_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM intercompany_account_links WHERE source_company_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM rental_auto_transfer_configs WHERE company_id = ANY($1)`, [ids]);
  await pool.query(`DELETE FROM company_settings WHERE company_id = ANY($1)`, [ids]);
  await pool.query(`UPDATE companies SET parent_company_id = NULL WHERE id = ANY($1)`, [ids]);
  for (const prefix of PREFIXES) await cleanupTestData(prefix);
  closeTestServer();
}, 180_000);

describe("MC-1 / MC-11: transfers through the intercompany service", () => {
  it("posts both legs against Intercompany-typed accounts and records their ids on the link", async () => {
    const transfer = await interCompanyTransferService.create(parent.userId, {
      transferType: "Cash",
      fromCompanyId: parent.companyId,
      toCompanyId: child.companyId,
      transferDate: "2026-06-01",
      amount: "150.00",
      fromLedgerAccountId: parent.cashAccountId,
      toLedgerAccountId: child.cashAccountId,
      clientRequestId: `p26-ict-${Date.now()}`,
    });
    expect(transfer.fromIcAccountId).toBeTruthy();
    expect(transfer.toIcAccountId).toBeTruthy();
    expect(transfer.sourceType).toBe("inter-company-transfer");
    const from = await one<{ company_id: number; code: string; account_type: string; sub_type: string }>(
      `SELECT company_id, code, account_type, sub_type FROM ledger_accounts WHERE id = $1`,
      [transfer.fromIcAccountId]
    );
    const to = await one<{ company_id: number; code: string; account_type: string; sub_type: string }>(
      `SELECT company_id, code, account_type, sub_type FROM ledger_accounts WHERE id = $1`,
      [transfer.toIcAccountId]
    );
    expect(from).toMatchObject({ company_id: parent.companyId, account_type: "Intercompany", sub_type: "Due From" });
    expect(to).toMatchObject({ company_id: child.companyId, account_type: "Intercompany", sub_type: "Due To" });
    const fromLines = await pool.query(
      `SELECT ledger_account_id, debit_amount::text AS d, credit_amount::text AS c FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
      [transfer.fromVoucherId]
    );
    expect(fromLines.rows).toEqual([
      { ledger_account_id: transfer.fromIcAccountId, d: "150.00", c: "0.00" },
      { ledger_account_id: parent.cashAccountId, d: "0.00", c: "150.00" },
    ]);
    const audit = await pool.query(
      `SELECT 1 FROM audit_log WHERE table_name = 'inter_company_transfers' AND record_id = $1 AND action = 'create'`,
      [transfer.id]
    );
    expect(audit.rows).toHaveLength(1);
  });

  it("a simple transfer uses the intercompany accounts and its delete soft-deletes the link", async () => {
    const transfer = await simpleCompanyTransferService.create(parent.userId, {
      fromCompanyId: parent.companyId,
      toCompanyId: child.companyId,
      transferDate: "2026-06-02",
      amount: "40.00",
      fromLedgerAccountId: parent.cashAccountId,
      toLedgerAccountId: child.cashAccountId,
      clientRequestId: `p26-simple-${Date.now()}`,
    });
    expect(transfer.sourceType).toBe("simple-company-transfer");
    expect(transfer.fromIcAccountId).toBeTruthy();
    const clearing = await pool.query(
      `SELECT 1 FROM voucher_entries ve JOIN ledger_accounts la ON la.id = ve.ledger_account_id
        WHERE ve.voucher_id = ANY($1) AND la.code = 'TRANSFER-CLEARING'`,
      [[transfer.fromVoucherId, transfer.toVoucherId]]
    );
    expect(clearing.rows).toHaveLength(0);

    const result = await simpleCompanyTransferService.delete(parent.userId, transfer.id);
    expect(result.success).toBe(true);
    const link = await one<{ deleted_at: Date | null; delete_reason: string | null }>(
      `SELECT deleted_at, delete_reason FROM inter_company_transfers WHERE id = $1`,
      [transfer.id]
    );
    expect(link.deleted_at).not.toBeNull();
    expect(link.delete_reason).toContain(String(transfer.id));
    // A second delete is a replay, not a second reversal.
    expect(await simpleCompanyTransferService.delete(parent.userId, transfer.id)).toMatchObject({ replayed: true });
  });

  it("refuses companies keeping their books in different currencies", async () => {
    await pool.query(`UPDATE companies SET base_currency = 'EUR' WHERE id = $1`, [other.companyId]);
    try {
      await expect(
        db.transaction((tx) =>
          postIntercompanyTransferTx(tx, {
            fromCompanyId: parent.companyId,
            toCompanyId: other.companyId,
            amount: "1.00",
            transferDate: "2026-06-03",
            sourceType: "test",
            authorization: "membership-checked",
            from: { accountId: parent.cashAccountId, source: { type: "p26-x-out", id: "1" } },
            to: { accountId: other.cashAccountId, source: { type: "p26-x-in", id: "1" } },
          })
        )
      ).rejects.toMatchObject({ code: "INTERCOMPANY_BASE_CURRENCY_DIFFERS" });
    } finally {
      await pool.query(`UPDATE companies SET base_currency = 'USD' WHERE id = $1`, [other.companyId]);
    }
  });
});

describe("MC-4: POS cash mirror inside the sale's transaction", () => {
  let sourceInterco: number;
  let destInterco: number;

  beforeAll(async () => {
    sourceInterco = await account(other.companyId, `P26-SRC-IC-${Date.now()}`, "Intercompany", "Due From");
    destInterco = await account(parent.companyId, `P26-DST-IC-${Date.now()}`, "Intercompany", "Due To");
    await pool.query(
      `INSERT INTO intercompany_pos_configs (source_company_id, dest_company_id, source_interco_account_id,
         dest_interco_account_id, enabled, skip_source_voucher) VALUES ($1, $2, $3, $4, true, true)`,
      [other.companyId, parent.companyId, sourceInterco, destInterco]
    );
  });

  it("posts nothing on either side without a configured destination cash account", async () => {
    const sale = await voucher(other.companyId, "2026-06-05", [
      { accountId: other.cashAccountId, debit: "9.00" },
      { accountId: other.salesAccountId, credit: "9.00" },
    ]);
    const posted = await db.transaction((tx) =>
      postIntercompanyPosMirrorTx(tx, {
        sourceCompanyId: other.companyId,
        cashAccountId: other.cashAccountId,
        saleAmount: "9.00",
        saleDate: "2026-06-05",
        saleVoucherId: sale,
      })
    );
    expect(posted).toBe(false);
    const links = await pool.query(`SELECT 1 FROM inter_company_transfers WHERE from_company_id = $1`, [
      other.companyId,
    ]);
    expect(links.rows).toHaveLength(0);
  });

  it("is two-sided (even with skip-source set), rolls back with the sale, and records the link", async () => {
    await pool.query(
      `INSERT INTO intercompany_account_links (label, source_company_id, source_ledger_account_id, dest_company_id,
         dest_ledger_account_id, active) VALUES ('p26 cash', $1, $2, $3, $4, true)`,
      [other.companyId, other.cashAccountId, parent.companyId, parent.cashAccountId]
    );
    const sale = await voucher(other.companyId, "2026-06-06", [
      { accountId: other.cashAccountId, debit: "12.50" },
      { accountId: other.salesAccountId, credit: "12.50" },
    ]);
    const input = {
      sourceCompanyId: other.companyId,
      cashAccountId: other.cashAccountId,
      saleAmount: "12.50",
      saleDate: "2026-06-06",
      saleVoucherId: sale,
    };
    await expect(
      db.transaction(async (tx) => {
        await postIntercompanyPosMirrorTx(tx, input);
        throw new Error("sale failed");
      })
    ).rejects.toThrow("sale failed");
    expect(
      (await pool.query(`SELECT 1 FROM inter_company_transfers WHERE from_company_id = $1`, [other.companyId])).rows
    ).toHaveLength(0);

    expect(await db.transaction((tx) => postIntercompanyPosMirrorTx(tx, input))).toBe(true);
    const link = await one<{
      from_voucher_id: number;
      to_voucher_id: number;
      from_ic_account_id: number;
      to_ic_account_id: number;
      source_type: string;
    }>(
      `SELECT from_voucher_id, to_voucher_id, from_ic_account_id, to_ic_account_id, source_type
         FROM inter_company_transfers WHERE from_company_id = $1 AND deleted_at IS NULL`,
      [other.companyId]
    );
    expect(link).toMatchObject({
      from_ic_account_id: sourceInterco,
      to_ic_account_id: destInterco,
      source_type: "intercompany-pos",
    });
    const src = await pool.query(
      `SELECT ledger_account_id, debit_amount::text AS d, credit_amount::text AS c FROM voucher_entries WHERE voucher_id = $1 ORDER BY id`,
      [link.from_voucher_id]
    );
    expect(src.rows).toEqual([
      { ledger_account_id: sourceInterco, d: "12.50", c: "0.00" },
      { ledger_account_id: other.cashAccountId, d: "0.00", c: "12.50" },
    ]);
    // A replay posts nothing twice.
    await db.transaction((tx) => postIntercompanyPosMirrorTx(tx, input));
    expect(
      (
        await pool.query(`SELECT 1 FROM inter_company_transfers WHERE from_company_id = $1 AND deleted_at IS NULL`, [
          other.companyId,
        ])
      ).rows
    ).toHaveLength(1);
  });
});

describe("MC-3: rental auto-transfer inside the payment's transaction", () => {
  it("posts through the intercompany service with the payment as identity, once", async () => {
    const dest = await account(child.companyId, `P26-RCV-${Date.now()}`, "Cash");
    await pool.query(
      `INSERT INTO rental_auto_transfer_configs (company_id, module, dest_company_id, dest_ledger_account_id, enabled)
       VALUES ($1, 'PROPERTIES', $2, $3, true)`,
      [parent.companyId, child.companyId, dest]
    );
    const input = {
      companyId: parent.companyId,
      module: "PROPERTIES" as const,
      fromLedgerAccountId: parent.cashAccountId,
      amount: "75.00",
      transferDate: "2026-06-07",
      unitLabel: "P26/1",
      sourcePaymentId: 926_000_001,
    };
    const first = await db.transaction((tx) => runRentalAutoTransferTx(tx, input));
    const second = await db.transaction((tx) => runRentalAutoTransferTx(tx, input));
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    const link = await one<{ source_type: string; from_ic_account_id: number | null; to_ledger_account_id: number }>(
      `SELECT source_type, from_ic_account_id, to_ledger_account_id FROM inter_company_transfers WHERE id = $1`,
      [first]
    );
    expect(link).toMatchObject({ source_type: "rental-auto-transfer", to_ledger_account_id: dest });
    expect(link.from_ic_account_id).toBeTruthy();
  });
});

describe("MC-1 / MC-9: group elimination accounts", () => {
  it("names the intercompany accounts (never the cash accounts), derives legacy links, pairs the PO import by id", async () => {
    // A legacy link (before phase 26): no intercompany ids, a TRANSFER-CLEARING leg.
    const clearingP = await account(parent.companyId, "TRANSFER-CLEARING", "Equity");
    const legacyFrom = await voucher(parent.companyId, "2026-06-08", [
      { accountId: clearingP, debit: "5.00" },
      { accountId: parent.cashAccountId, credit: "5.00" },
    ]);
    const clearingC = await account(child.companyId, "TRANSFER-CLEARING", "Equity");
    const legacyTo = await voucher(child.companyId, "2026-06-08", [
      { accountId: child.cashAccountId, debit: "5.00" },
      { accountId: clearingC, credit: "5.00" },
    ]);
    await pool.query(
      `INSERT INTO inter_company_transfers (transfer_type, from_company_id, to_company_id, transfer_date, amount,
         from_ledger_account_id, to_ledger_account_id, from_voucher_id, to_voucher_id)
       VALUES ('Cash', $1, $2, '2026-06-08', 5, $3, $4, $5, $6)`,
      [parent.companyId, child.companyId, parent.cashAccountId, child.cashAccountId, legacyFrom, legacyTo]
    );
    const receivable = await account(parent.companyId, `P26-CHILD-CREDIT-${Date.now()}`, "Asset");
    await storage.upsertCompanySettings({ companyId: child.companyId, parentReceivableAccountId: receivable });

    const companies = await storage.getAllCompanies();
    const parentRow = companies.find((c) => c.id === parent.companyId)!;
    const accounts = await loadCompanyIntercompanyAccounts(parentRow, companies, "2026-12-31");
    const ids = new Set(accounts.map((a) => a.accountId));
    expect(ids.has(parent.cashAccountId)).toBe(false);
    expect(ids.has(clearingP)).toBe(true);
    expect(ids.has(receivable)).toBe(true);
    expect(accounts.find((a) => a.accountId === receivable)?.counterpartyCompanyIds).toEqual([child.companyId]);
  });
});

describe("MC-7: one parent model", () => {
  it("answers a company's parent from companies.parent_company_id", async () => {
    expect(await storage.getParentCompanyId(child.companyId)).toBe(parent.companyId);
    expect(await storage.getParentCompanyId(parent.companyId)).toBe(parent.companyId);
    expect(await storage.getParentCompanyId(other.companyId)).toBeNull();
  });
});

describe("MC-6: consolidation", () => {
  it("eliminates intercompany balances and revenue/cost by pair, and balances", async () => {
    // An intercompany sale: the child sells 30 to the parent on account.
    const childIc = await account(child.companyId, `IC-TO-P26${Date.now() % 100000}`, "Intercompany", "Due From");
    const parentIc = await account(parent.companyId, `IC-FROM-P26${Date.now() % 100000}`, "Intercompany", "Due To");
    const parentExpense = await account(parent.companyId, `P26-EXP-${Date.now()}`, "Expense");
    const sold = await voucher(child.companyId, "2026-07-01", [
      { accountId: childIc, debit: "30.00" },
      { accountId: child.salesAccountId, credit: "30.00" },
    ]);
    const bought = await voucher(parent.companyId, "2026-07-01", [
      { accountId: parentExpense, debit: "30.00" },
      { accountId: parentIc, credit: "30.00" },
    ]);
    await pool.query(
      `INSERT INTO inter_company_transfers (transfer_type, from_company_id, to_company_id, transfer_date, amount,
         from_ledger_account_id, to_ledger_account_id, from_voucher_id, to_voucher_id, from_ic_account_id, to_ic_account_id, source_type)
       VALUES ('Cash', $1, $2, '2026-07-01', 30, $3, $4, $5, $6, $3, $4, 'p26-test')`,
      [child.companyId, parent.companyId, childIc, parentIc, sold, bought]
    );

    const result = await buildConsolidation({ parentCompanyId: parent.companyId, asOf: "2026-12-31" });
    expect(result.ownership.map((o) => o.companyId).sort()).toEqual([parent.companyId, child.companyId].sort());
    expect(result.ownership.every((o) => o.ownershipPercent === "100")).toBe(true);
    expect(result.totals.eliminationsBalanced).toBe(true);
    expect(result.totals.difference).toBe("0.00");
    const childIcRow = result.rows.find((r) => r.companyId === child.companyId && r.id === childIc)!;
    expect(childIcRow.consolidated).toBe("0.00");
    const revenueCost = result.eliminations.filter((e) => e.type === "intercompany-revenue-cost");
    expect(revenueCost.length).toBeGreaterThan(0);
    expect(result.profitAndLoss.eliminatedIncome).toBe(
      revenueCost.reduce((s, e) => s + Number(e.matched), 0).toFixed(2)
    );
    // A company outside the group is not in it.
    expect(result.companies.some((c) => c.companyId === other.companyId)).toBe(false);
  });

  it("refuses a user without access to every group company", async () => {
    await expect(
      buildConsolidation({
        parentCompanyId: parent.companyId,
        asOf: "2026-12-31",
        allowedCompanyIds: new Set([parent.companyId]),
      })
    ).rejects.toMatchObject({ code: "CONSOLIDATION_ACCESS_DENIED" });
  });
});

describe("MC-10: lines on another company's accounts", () => {
  it("plans, refuses a stale hash, and corrects by retirement and re-post with an intercompany counterpart", async () => {
    const foreign = await account(other.companyId, `P26-FOREIGN-${Date.now()}`, "Expense");
    // Legacy row: the guard refuses it today, so it is written as legacy data.
    seq += 1;
    const legacy = await withFixtureTransaction(
      async (client) => {
        const { rows } = await client.query(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount)
           VALUES ($1, $2, 'Journal', '2026-08-01', 20) RETURNING id`,
          [parent.companyId, `P26-LEGACY-${seq}-${Date.now()}`]
        );
        await client.query(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, 20, 0), ($1, $3, 0, 20)`,
          [rows[0].id, foreign, parent.cashAccountId]
        );
        return Number(rows[0].id);
      },
      { legacyUnbalanced: true }
    );

    const diagnostic = await runMultiCompanyDiagnostic(parent.companyId);
    expect(diagnostic.checks.find((c) => c.key === "lines_on_other_company_accounts")?.status).toBe("fail");

    const plan = await planCrossCompanyLineReclass(parent.companyId);
    const item = plan.vouchers.find((v) => v.voucherId === legacy)!;
    expect(item.blocked).toBeNull();
    expect(item.lines).toHaveLength(1);
    await expect(
      applyCrossCompanyLineReclass(parent.companyId, {
        planHash: "0".repeat(64),
        actor: { userId: parent.userId, username: "t" },
      })
    ).rejects.toMatchObject({ code: "PLAN_CHANGED" });

    const result = await applyCrossCompanyLineReclass(parent.companyId, {
      planHash: plan.planHash,
      actor: { userId: parent.userId, username: "t" },
    });
    const done = result.corrected.find((c) => c.voucherId === legacy)!;
    const original = await one<{ deleted_at: Date | null; original_voucher_number: string | null }>(
      `SELECT deleted_at, original_voucher_number FROM vouchers WHERE id = $1`,
      [legacy]
    );
    expect(original.deleted_at).not.toBeNull();
    expect(original.original_voucher_number).toMatch(/^P26-LEGACY-/);
    const replacement = await pool.query(
      `SELECT ve.debit_amount::text AS d, la.company_id, la.account_type FROM voucher_entries ve
         JOIN ledger_accounts la ON la.id = ve.ledger_account_id WHERE ve.voucher_id = $1 ORDER BY ve.id`,
      [done.replacementVoucherId]
    );
    expect(replacement.rows.every((r) => r.company_id === parent.companyId)).toBe(true);
    expect(replacement.rows[0]).toMatchObject({ d: "20.00", account_type: "Intercompany" });
    const counterpart = await pool.query(
      `SELECT ve.ledger_account_id, ve.debit_amount::text AS d, ve.credit_amount::text AS c FROM voucher_entries ve
        WHERE ve.voucher_id = $1 ORDER BY ve.id`,
      [done.counterpartVoucherId]
    );
    expect(counterpart.rows[0]).toMatchObject({ ledger_account_id: foreign, d: "20.00" });
    expect(counterpart.rows[1]).toMatchObject({ c: "20.00" });
    expect((await planCrossCompanyLineReclass(parent.companyId)).vouchers.some((v) => v.voucherId === legacy)).toBe(
      false
    );
  });
});

describe("leftover: legacy SHA-256 supervisor passwords", () => {
  it("verifies, rehashes to bcrypt and lists the accounts still on SHA-256", async () => {
    const password = "supervisor-p26";
    const legacy = createHash("sha256").update(password, "utf8").digest("hex");
    const user = await one<{ id: string }>(`INSERT INTO users (username, password) VALUES ($1, $2) RETURNING id`, [
      `p26_sup_${Date.now()}`,
      legacy,
    ]);
    try {
      await pool.query(`INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($1, $2, 'Manager')`, [
        user.id,
        parent.companyId,
      ]);
      expect((await listLegacyPasswordHashUsers(parent.companyId)).map((u) => u.id)).toContain(String(user.id));
      expect(await verifySupervisorPasswordForUser("wrong", { id: user.id, password: legacy })).toBe(false);
      expect(await verifySupervisorPasswordForUser(password, { id: user.id, password: legacy })).toBe(true);
      const stored = await one<{ password: string }>(`SELECT password FROM users WHERE id = $1`, [user.id]);
      expect(stored.password).not.toBe(legacy);
      expect(await bcrypt.compare(password, stored.password)).toBe(true);
      expect((await listLegacyPasswordHashUsers(parent.companyId)).map((u) => u.id)).not.toContain(String(user.id));
      const audit = await pool.query(`SELECT 1 FROM audit_log WHERE table_name = 'users' AND record_identifier = $1`, [
        `password-rehash:${user.id}`,
      ]);
      expect(audit.rows).toHaveLength(1);
    } finally {
      await pool.query(`DELETE FROM user_company_roles WHERE user_id = $1`, [user.id]);
      await deleteAuditLogRowsForTests(pool, "record_identifier = $1", [`password-rehash:${user.id}`]);
      await pool.query(`DELETE FROM users WHERE id = $1`, [user.id]).catch(() => {});
    }
  });
});

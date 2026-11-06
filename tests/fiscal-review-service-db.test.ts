/**
 * Phase 13 fiscal review against PostgreSQL: period readiness and each of its
 * blockers, the two independent signoffs, revocation, the reviewed-close
 * evidence lock and the per-company review policy. Every database call runs in
 * one rolled-back transaction.
 */
import type { PoolClient } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { db, pool } from "../server/db";
import { ensureClosedPeriodGuard } from "../server/services/accounting/closedPeriodGuard";
import { ensureFiscalReviewSchema } from "../server/services/accounting/ensureFiscalReviewSchema";
import { ensureOpeningBalanceLock } from "../server/services/accounting/openingBalanceLock";
import { ensureAuditLogAppendOnlyGuard } from "../server/services/audit/auditLogAppendOnlyGuard";
import { ensureVoucherAuditTrigger } from "../server/services/audit/voucherAuditTrigger";
import {
  ensureReviewedFiscalCloseTx,
  fiscalReadinessTx,
  fiscalReviewPolicyTx,
  FiscalReviewError,
  recordFiscalReviewTx,
  recordReviewedFiscalCloseTx,
  reviewedFiscalCloseHistoryTx,
  revokeFiscalReviewTx,
  setFiscalReviewPolicyTx,
} from "../server/services/accounting/fiscalReviewService";
import { withRolledBackPool } from "./helpers/routedPoolClient";

// Readiness reads every guard server startup installs. Earlier suites drop
// some of them when they finish, so install them here rather than depend on
// which files ran first.
beforeAll(async () => {
  await ensureClosedPeriodGuard(pool);
  await ensureOpeningBalanceLock(pool);
  await ensureVoucherAuditTrigger(pool);
  await ensureAuditLogAppendOnlyGuard(pool);
  await ensureFiscalReviewSchema(pool);
});

let seq = 0;
const PERIOD = { periodStartDate: "2025-01-01", periodEndDate: "2025-12-31" };

interface World {
  companyId: number;
  retainedId: number;
  cashId: number;
  incomeId: number;
  accountant: { userId: string; username: string };
  owner: { userId: string; username: string };
}

async function user(client: PoolClient, name: string) {
  const username = `${name}_${process.pid}_${++seq}`;
  const id = String(
    (await client.query("INSERT INTO users(username,password) VALUES($1,'x') RETURNING id", [username])).rows[0].id
  );
  return { userId: id, username };
}

async function account(client: PoolClient, companyId: number, code: string, type: string) {
  return Number(
    (
      await client.query(
        "INSERT INTO ledger_accounts(company_id,code,name,account_type) VALUES($1,$2,$3,$4) RETURNING id",
        [companyId, `${code}-${process.pid}-${++seq}`, code, type]
      )
    ).rows[0].id
  );
}

async function world(client: PoolClient): Promise<World> {
  const tag = `FRS${process.pid}x${++seq}`;
  const companyId = Number(
    (await client.query("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [tag, tag])).rows[0].id
  );
  return {
    companyId,
    retainedId: await account(client, companyId, "RE", "Equity"),
    cashId: await account(client, companyId, "CASH", "Asset"),
    incomeId: await account(client, companyId, "SALES", "Income"),
    accountant: await user(client, "accountant"),
    owner: await user(client, "owner"),
  };
}

/** A posted voucher written with triggers off, like a legacy import. */
async function voucher(
  client: PoolClient,
  w: World,
  date: string,
  lines: Array<{
    account: number;
    debit?: number;
    credit?: number;
    baseDebit?: number | null;
    baseCredit?: number | null;
  }>,
  over: { type?: string; optional?: boolean; createdBy?: string | null; currency?: string } = {}
) {
  await client.query("SET LOCAL session_replication_role = replica");
  const id = Number(
    (
      await client.query(
        `INSERT INTO vouchers(company_id,voucher_number,voucher_type,voucher_date,total_amount,optional,created_by,currency)
         VALUES($1,$2,$3,$4,0,$5,$6,$7) RETURNING id`,
        [
          w.companyId,
          `FRS-${process.pid}-${++seq}`,
          over.type ?? "Journal",
          date,
          over.optional ?? false,
          over.createdBy === undefined ? w.accountant.userId : over.createdBy,
          over.currency ?? "USD",
        ]
      )
    ).rows[0].id
  );
  for (const line of lines) {
    await client.query(
      `INSERT INTO voucher_entries(voucher_id,ledger_account_id,debit_amount,credit_amount,base_debit_amount,base_credit_amount)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        id,
        line.account,
        line.debit ?? 0,
        line.credit ?? 0,
        line.baseDebit === undefined ? (line.debit ?? 0) : line.baseDebit,
        line.baseCredit === undefined ? (line.credit ?? 0) : line.baseCredit,
      ]
    );
  }
  await client.query("SET LOCAL session_replication_role = origin");
  return id;
}

async function closure(client: PoolClient, w: World, from: string, to: string) {
  const voucherId = await voucher(client, w, to, [], { type: "Journal" });
  return {
    voucherId,
    id: Number(
      (
        await client.query(
          `INSERT INTO fiscal_period_closures(company_id,period_start_date,period_end_date,closed_by_user_id,closing_voucher_id,
             retained_earnings_account_id,total_income,total_expense,net_income)
           VALUES($1,$2,$3,$4,$5,$6,0,0,'12.50') RETURNING id`,
          [w.companyId, from, to, w.owner.userId, voucherId, w.retainedId]
        )
      ).rows[0].id
    ),
  };
}

const scope = (w: World, over: Partial<typeof PERIOD> = {}) => ({
  companyId: w.companyId,
  retainedEarningsAccountId: w.retainedId,
  ...PERIOD,
  ...over,
});
const readiness = (w: World, over: Partial<typeof PERIOD> = {}) =>
  db.transaction((tx) => fiscalReadinessTx(tx, scope(w, over)));

async function expectCode(work: Promise<unknown>, code: string, status?: number) {
  const error = await work.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(FiscalReviewError);
  expect((error as FiscalReviewError).code).toBe(code);
  if (status !== undefined) expect((error as FiscalReviewError).status).toBe(status);
}

describe("fiscalReadinessTx", () => {
  it("is eligible for a clean USD company whose period has ended", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      await voucher(client, w, "2025-03-01", [
        { account: w.cashId, debit: 100 },
        { account: w.incomeId, credit: 100 },
      ]);
      const r = await readiness(w);
      expect(r).toMatchObject({
        companyId: w.companyId,
        ...PERIOD,
        retainedEarningsAccountId: w.retainedId,
        eligibleForSignoff: true,
        reviewedCloseReady: false,
        blockers: [],
        certified: false,
        trialBalance: { balanced: true },
        source: { postedVouchers: 1, postedVoucherLines: 2, optionalVouchers: 0, postingsWithoutActor: 0 },
        history: {
          latestClosedEnd: null,
          expectedNextStart: null,
          closedPeriods: [],
          historicalScope: "live_source_as_of",
        },
        protections: {
          voucherDateGuardInstalled: true,
          entryDateGuardInstalled: true,
          auditChainInstalled: true,
          openingBalanceGuardInstalled: true,
          reviewMetadataCompanyRlsInstalled: true,
        },
        signoffs: [],
      });
      expect(r.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(r.warnings).toHaveLength(2);
      // The same books give the same fingerprint; a new posting changes it.
      expect((await readiness(w)).evidenceHash).toBe(r.evidenceHash);
      await voucher(client, w, "2025-04-01", [
        { account: w.cashId, debit: 5 },
        { account: w.incomeId, credit: 5 },
      ]);
      expect((await readiness(w)).evidenceHash).not.toBe(r.evidenceHash);
    });
  });

  it("rejects malformed company, account and period input", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      await expectCode(
        db.transaction((tx) => fiscalReadinessTx(tx, { ...scope(w), companyId: 0 })),
        "FISCAL_ID_INVALID",
        400
      );
      await expectCode(
        db.transaction((tx) => fiscalReadinessTx(tx, { ...scope(w), retainedEarningsAccountId: 1.5 })),
        "FISCAL_ID_INVALID"
      );
      await expectCode(readiness(w, { periodStartDate: "2025-1-01" }), "FISCAL_DATE_INVALID", 400);
      await expectCode(readiness(w, { periodEndDate: "2025-02-30" }), "FISCAL_DATE_INVALID");
      await expectCode(
        readiness(w, { periodStartDate: "2025-12-31", periodEndDate: "2025-01-01" }),
        "FISCAL_PERIOD_INVALID",
        400
      );
    });
  });

  it("blocks foreign functional books, an unfinished period and an unusable retained earnings account", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      await client.query("UPDATE companies SET base_currency='ZMW' WHERE id=$1", [w.companyId]);
      const today = (await readiness(w)).businessDate;
      const r = await readiness(w, { periodEndDate: today });
      expect(r.eligibleForSignoff).toBe(false);
      expect(r.blockers).toEqual(
        expect.arrayContaining([
          "Reviewed close requires a USD functional company; foreign functional currencies need a certified translation policy",
          "Period close requires an ended accounting period before today's company-local business date",
        ])
      );

      await client.query("UPDATE companies SET base_currency=' usd ' WHERE id=$1", [w.companyId]);
      expect((await readiness(w)).blockers).toEqual([]);

      const retained = "Select an active Equity/Retained Earnings ledger account owned by this company";
      const other = await world(client);
      const foreign = await db.transaction((tx) =>
        fiscalReadinessTx(tx, { ...scope(w), retainedEarningsAccountId: other.retainedId })
      );
      expect(foreign.blockers).toContain(retained);
      const asset = await db.transaction((tx) =>
        fiscalReadinessTx(tx, { ...scope(w), retainedEarningsAccountId: w.cashId })
      );
      expect(asset.blockers).toContain(retained);
      await client.query("UPDATE ledger_accounts SET active=false WHERE id=$1", [w.retainedId]);
      expect((await readiness(w)).blockers).toContain(retained);
      await client.query("UPDATE ledger_accounts SET active=true, deleted_at=now() WHERE id=$1", [w.retainedId]);
      expect((await readiness(w)).blockers).toContain(retained);
    });
  });

  it("requires the next period to follow the last close and refuses to re-close it", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const closed = await closure(client, w, "2024-01-01", "2024-12-31");
      const r = await readiness(w);
      expect(r.blockers).toEqual([]);
      expect(r.history).toEqual({
        latestClosedEnd: "2024-12-31",
        expectedNextStart: "2025-01-01",
        closedPeriods: [
          { id: closed.id, from: "2024-01-01", to: "2024-12-31", voucherId: closed.voucherId, netIncomeUsd: "12.50" },
        ],
        historicalScope: "live_source_as_of",
      });

      const gap = await readiness(w, { periodStartDate: "2025-02-01" });
      expect(gap.blockers).toContain(
        "Periods must be contiguous after last close 2024-12-31; required next start 2025-01-01"
      );
      const overlap = await readiness(w, { periodStartDate: "2024-12-31", periodEndDate: "2024-12-31" });
      expect(overlap.blockers).toEqual(
        expect.arrayContaining([
          "Periods must be contiguous after last close 2024-12-31; required next start 2025-01-01",
          "A closed period with this ending date already exists",
        ])
      );
    });
  });

  it("protects older profit and loss entries before a first close", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      await voucher(client, w, "2024-06-30", [
        { account: w.cashId, debit: 10 },
        { account: w.incomeId, credit: 10 },
      ]);
      expect((await readiness(w)).blockers).toContain(
        "Oldest live P&L entry 2024-06-30 precedes first close start 2025-01-01"
      );
      expect((await readiness(w, { periodStartDate: "2024-06-30" })).blockers).toEqual([]);
    });
  });

  it("blocks unbalanced, cross-company, untranslated and re-based postings", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const other = await world(client);
      await voucher(client, w, "2025-02-01", [{ account: w.cashId, debit: 40 }]);
      // Stock transfers are allowed to be single-sided.
      await voucher(client, w, "2025-02-02", [{ account: w.cashId, debit: 3 }], { type: "Stock Transfer" });
      await voucher(client, w, "2025-02-03", [
        { account: w.cashId, debit: 7 },
        { account: other.cashId, credit: 7 },
      ]);
      await voucher(
        client,
        w,
        "2025-02-04",
        [
          { account: w.cashId, debit: 2, baseDebit: null },
          { account: w.cashId, credit: 2, baseCredit: null },
        ],
        { currency: "zmw" }
      );
      await voucher(client, w, "2025-02-05", [
        { account: w.cashId, debit: 9, baseDebit: 9 },
        { account: w.incomeId, credit: 9, baseCredit: 8 },
      ]);
      const r = await readiness(w);
      expect(r.eligibleForSignoff).toBe(false);
      expect(r.source).toMatchObject({
        balancedVoucherErrors: 1,
        missingLedgerTargets: 1,
        nonUsdUntranslatedLines: 2,
        pnlBaseAmountMismatchLines: 1,
      });
      expect(r.blockers).toEqual(
        expect.arrayContaining([
          "1 live voucher(s) of balanced types have unequal debit and credit",
          "1 posted line(s) target another company's or a missing ledger account",
          "2 foreign-currency lines lack a historical USD base on a nonzero debit/credit side",
          "1 income/expense lines have historical USD base amounts different from legacy debit/credit; the existing close writer must be reviewed before certification",
        ])
      );
      expect(r.blockers.some((b) => b.startsWith("Trial balance discrepancy at period end: USD "))).toBe(true);
      expect(r.trialBalance.balanced).toBe(false);
    });
  });

  it("warns about optional and creator-less vouchers without blocking", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const balanced = [
        { account: w.cashId, debit: 1 },
        { account: w.retainedId, credit: 1 },
      ];
      await voucher(client, w, "2025-05-01", balanced, { optional: true });
      await voucher(client, w, "2025-05-02", balanced, { createdBy: null });
      const r = await readiness(w);
      expect(r.blockers).toEqual([]);
      expect(r.source).toMatchObject({ optionalVouchers: 1, postingsWithoutActor: 1, postedVouchers: 1 });
      expect(r.warnings).toEqual(
        expect.arrayContaining([
          "1 optional vouchers dated through the period end are excluded from posted books",
          "1 older vouchers have no creator identity; audit actor provenance incomplete",
        ])
      );
    });
  });

  it("blocks signoff while a required guard trigger or the review RLS is off", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      // DDL is transactional, so both changes roll back with the test.
      await client.query("ALTER TABLE fixed_assets DISABLE TRIGGER fixed_assets_opening_balance_lock");
      let r = await readiness(w);
      expect(r.protections).toMatchObject({
        openingBalanceGuardInstalled: false,
        reviewMetadataCompanyRlsInstalled: true,
      });
      expect(r.blockers).toEqual([
        "A required closed-period, master-opening or audit-hash trigger is missing, disabled or on the wrong table",
      ]);
      await client.query("ALTER TABLE fixed_assets ENABLE TRIGGER fixed_assets_opening_balance_lock");
      await client.query("ALTER TABLE accounting_fiscal_review_policy NO FORCE ROW LEVEL SECURITY");
      r = await readiness(w);
      expect(r.protections.reviewMetadataCompanyRlsInstalled).toBe(false);
      expect(r.blockers).toEqual([
        "Fiscal approval tables require ENABLE and FORCE RLS with company-scope policies before independent review",
      ]);
    });
  });

  it("blocks a deleted profit and loss account that still carries a balance", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      await voucher(client, w, "2025-03-01", [
        { account: w.cashId, debit: 100 },
        { account: w.incomeId, credit: 100 },
      ]);
      // Legacy data from before the delete guard: written with triggers off.
      await client.query("SET LOCAL session_replication_role = replica");
      await client.query("UPDATE ledger_accounts SET deleted_at=now() WHERE id=$1", [w.incomeId]);
      await client.query("SET LOCAL session_replication_role = origin");
      expect((await readiness(w)).blockers).toContain("1 deleted profit/loss account(s) still carry posted balances");
    });
  });
});

describe("fiscal signoffs and the reviewed close", () => {
  const sign = (
    w: World,
    kind: "ACCOUNTING" | "OWNER",
    reviewer: World["owner"],
    evidenceHash: string,
    note = "Reviewed the trial balance"
  ) =>
    db.transaction((tx) => recordFiscalReviewTx(tx, { ...scope(w), evidenceHash, reviewKind: kind, note, reviewer }));

  it("needs two different reviewers on current evidence before the close", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const { evidenceHash } = await readiness(w);

      await expectCode(sign(w, "ACCOUNTING", w.accountant, "0".repeat(64)), "FISCAL_STALE_EVIDENCE");
      await expectCode(sign(w, "ACCOUNTING", w.accountant, evidenceHash, "  short   "), "FISCAL_NOTE_INVALID", 400);
      await expectCode(sign(w, "ACCOUNTING", w.accountant, evidenceHash, "x".repeat(2001)), "FISCAL_NOTE_INVALID");

      const accounting = await sign(w, "ACCOUNTING", w.accountant, evidenceHash, "  Reviewed the trial balance  ");
      expect(accounting).toEqual({ id: expect.any(Number), reviewKind: "ACCOUNTING", evidenceHash });
      await expectCode(
        db.transaction((tx) => ensureReviewedFiscalCloseTx(tx, { ...scope(w), evidenceHash })),
        "FISCAL_REVIEW_INCOMPLETE"
      );
      await expectCode(sign(w, "OWNER", w.accountant, evidenceHash), "FISCAL_SEPARATE_REVIEWERS_REQUIRED");
      const owner = await sign(w, "OWNER", w.owner, evidenceHash);

      const ready = await readiness(w);
      expect(ready.reviewedCloseReady).toBe(true);
      expect(ready.signoffs.map((s) => [s.id, s.kind, s.reviewerId, s.note, s.current])).toEqual(
        expect.arrayContaining([
          [accounting.id, "ACCOUNTING", w.accountant.userId, "Reviewed the trial balance", true],
          [owner.id, "OWNER", w.owner.userId, "Reviewed the trial balance", true],
        ])
      );
      const audits = (
        await client.query(
          "SELECT action, record_identifier, changes FROM audit_log WHERE table_name='accounting_fiscal_review_signoffs' AND record_id=$1",
          [String(accounting.id)]
        )
      ).rows;
      expect(audits).toMatchObject([
        {
          action: "approve",
          record_identifier: "2025-01-01..2025-12-31:ACCOUNTING",
          changes: { reviewNote: { new: "Reviewed the trial balance" } },
        },
      ]);

      await expectCode(
        db.transaction((tx) => ensureReviewedFiscalCloseTx(tx, { ...scope(w), evidenceHash: "f".repeat(64) })),
        "FISCAL_STALE_EVIDENCE"
      );
      const locked = await db.transaction((tx) => ensureReviewedFiscalCloseTx(tx, { ...scope(w), evidenceHash }));
      expect(locked).toEqual({ accountingSignoffId: accounting.id, ownerSignoffId: owner.id, evidenceHash });

      const closed = await closure(client, w, PERIOD.periodStartDate, PERIOD.periodEndDate);
      await db.transaction((tx) =>
        recordReviewedFiscalCloseTx(tx, {
          companyId: w.companyId,
          closureId: closed.id,
          voucherId: closed.voucherId,
          accountingSignoffId: accounting.id,
          ownerSignoffId: owner.id,
          evidenceHash,
          actor: w.owner,
        })
      );
      const history = await db.transaction((tx) => reviewedFiscalCloseHistoryTx(tx, w.companyId));
      expect(history).toMatchObject([
        {
          fiscal_closure_id: closed.id,
          closing_voucher_id: closed.voucherId,
          evidence_hash: evidenceHash,
          reviewed_by: w.owner.userId,
          accounting_reviewer: w.accountant.username,
          owner_reviewer: w.owner.username,
          currently_closed: true,
        },
      ]);

      const revoke = (signoffId: number, reason = "Signed against the wrong pack") =>
        db.transaction((tx) => revokeFiscalReviewTx(tx, { companyId: w.companyId, signoffId, reason, actor: w.owner }));
      await expectCode(revoke(accounting.id), "FISCAL_SIGNOFF_USED");
      await expectCode(revoke(owner.id), "FISCAL_SIGNOFF_USED");
    });
  });

  it("revokes an unused signoff once, with a reason", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const { evidenceHash } = await readiness(w);
      const accounting = await sign(w, "ACCOUNTING", w.accountant, evidenceHash);
      await sign(w, "OWNER", w.owner, evidenceHash);
      const revoke = (signoffId: number, reason = "  Signed against the wrong pack  ") =>
        db.transaction((tx) => revokeFiscalReviewTx(tx, { companyId: w.companyId, signoffId, reason, actor: w.owner }));

      await expectCode(revoke(0), "FISCAL_ID_INVALID", 400);
      await expectCode(revoke(accounting.id, "too short"), "FISCAL_REVOKE_REASON_INVALID", 400);
      await expectCode(revoke(accounting.id, "x".repeat(1001)), "FISCAL_REVOKE_REASON_INVALID");
      const other = await world(client);
      await expectCode(
        db.transaction((tx) =>
          revokeFiscalReviewTx(tx, {
            companyId: other.companyId,
            signoffId: accounting.id,
            reason: "Signed against the wrong pack",
            actor: other.owner,
          })
        ),
        "FISCAL_SIGNOFF_MISSING",
        404
      );

      await expect(revoke(accounting.id)).resolves.toEqual({ id: accounting.id, revoked: true });
      expect(
        (
          await client.query("SELECT revoked_by, revoke_reason FROM accounting_fiscal_review_signoffs WHERE id=$1", [
            accounting.id,
          ])
        ).rows[0]
      ).toEqual({ revoked_by: w.owner.userId, revoke_reason: "Signed against the wrong pack" });
      await expectCode(revoke(accounting.id), "FISCAL_SIGNOFF_MISSING");

      const after = await readiness(w);
      expect(after.reviewedCloseReady).toBe(false);
      expect(after.signoffs.find((s) => s.id === accounting.id)?.current).toBe(false);
      await expectCode(
        db.transaction((tx) => ensureReviewedFiscalCloseTx(tx, { ...scope(w), evidenceHash })),
        "FISCAL_REVIEW_INCOMPLETE"
      );

      // A later posting changes the evidence, so the owner's signoff is no longer current.
      await voucher(client, w, "2025-06-01", [
        { account: w.cashId, debit: 1 },
        { account: w.incomeId, credit: 1 },
      ]);
      expect((await readiness(w)).signoffs.map((s) => s.current)).toEqual([false, false]);
    });
  });

  it("refuses signoffs and a reviewed close while readiness blockers remain", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      await voucher(client, w, "2025-02-01", [{ account: w.cashId, debit: 40 }]);
      const r = await readiness(w);
      await expectCode(sign(w, "ACCOUNTING", w.accountant, r.evidenceHash), "FISCAL_NOT_READY");
      const error = await db
        .transaction((tx) => ensureReviewedFiscalCloseTx(tx, { ...scope(w), evidenceHash: r.evidenceHash }))
        .catch((e: unknown) => e as FiscalReviewError);
      expect(error.code).toBe("FISCAL_REVIEW_INCOMPLETE");
      expect(error.message).toBe(r.blockers.join("; "));
    });
  });

  it("finds no independent pair when both current signoffs came from one person", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const { evidenceHash } = await readiness(w);
      // Written directly: the service itself refuses a same-person pair.
      for (const kind of ["ACCOUNTING", "OWNER"]) {
        await client.query(
          `INSERT INTO accounting_fiscal_review_signoffs(company_id,period_start_date,period_end_date,
             retained_earnings_account_id,evidence_hash,review_kind,reviewer_id,reviewer_name,note)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,'Reviewed everything')`,
          [
            w.companyId,
            PERIOD.periodStartDate,
            PERIOD.periodEndDate,
            w.retainedId,
            evidenceHash,
            kind,
            w.owner.userId,
            w.owner.username,
          ]
        );
      }
      const r = await readiness(w);
      expect(r.reviewedCloseReady).toBe(false);
      const error = await db
        .transaction((tx) => ensureReviewedFiscalCloseTx(tx, { ...scope(w), evidenceHash }))
        .catch((e: unknown) => e as FiscalReviewError);
      expect(error.message).toBe("Separate current Accounting and Owner signoffs are required");
    });
  });
});

describe("fiscal review policy", () => {
  it("defaults off and records each change with its reason", async () => {
    await withRolledBackPool(async (client) => {
      const w = await world(client);
      const read = () => db.transaction((tx) => fiscalReviewPolicyTx(tx, w.companyId));
      expect(await read()).toEqual({
        companyId: w.companyId,
        enforceReviewedClose: false,
        updatedBy: null,
        updatedAt: null,
        reason: null,
        explicitlyConfigured: false,
      });
      const set = (enforce: boolean, reason: string) =>
        db.transaction((tx) =>
          setFiscalReviewPolicyTx(tx, { companyId: w.companyId, enforce, reason, actor: w.owner })
        );
      await expectCode(set(true, "too short"), "FISCAL_POLICY_REASON_REQUIRED", 400);
      await expectCode(set(true, "y".repeat(1001)), "FISCAL_POLICY_REASON_REQUIRED");

      expect(await set(true, "  Board requires dual approval  ")).toMatchObject({
        enforceReviewedClose: true,
        updatedBy: w.owner.userId,
        reason: "Board requires dual approval",
        explicitlyConfigured: true,
      });
      expect(await set(false, "Dual approval paused for audit")).toMatchObject({
        enforceReviewedClose: false,
        reason: "Dual approval paused for audit",
      });
      const audits = (
        await client.query(
          "SELECT changes FROM audit_log WHERE table_name='accounting_fiscal_review_policy' AND company_id=$1 ORDER BY id",
          [w.companyId]
        )
      ).rows.map((row) => row.changes.enforceReviewedClose);
      expect(audits).toEqual([
        { old: false, new: true },
        { old: true, new: false },
      ]);
    });
  });
});

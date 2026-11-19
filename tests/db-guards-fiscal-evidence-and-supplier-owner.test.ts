/**
 * Two insert-time guards, attacked in SQL.
 *
 * A reviewed fiscal close may only be recorded when an accountant and the
 * owner, two different people, have each signed off the same evidence for the
 * same period, retained-earnings account and closing voucher, and neither has
 * withdrawn. The database checks all of it on insert; the application only
 * builds the row.
 *
 * A supplier created without a company is given the parent company, from the
 * configured setting or, when there is exactly one, the only top-level ERP
 * company; with neither, the insert is refused rather than leaving the
 * supplier unowned.
 */
import type { PoolClient } from "pg";
import { describe, expect, it } from "vitest";

import { expectRefused, insertRow, seedRow, withRollback } from "./helpers/dbGuardHarness";

const CHECK_VIOLATION = "23514";
const RAISED = "P0001";
const EVIDENCE = "e".repeat(64);
const OTHER_EVIDENCE = "f".repeat(64);

type Row = Record<string, unknown>;

/** A closed period with an accountant's and an owner's live sign-off; `ownerValues` adjusts the owner's. */
async function closeWithSignoffs(client: PoolClient, ownerValues: Row = {}) {
  const company = await seedRow(client, "companies");
  const retainedEarnings = await seedRow(client, "ledger_accounts", { company_id: company.id, account_type: "Equity" });
  const voucher = await seedRow(client, "vouchers", { company_id: company.id, voucher_date: "2025-12-31" });
  const closure = await seedRow(client, "fiscal_period_closures", {
    company_id: company.id,
    period_start_date: "2025-01-01",
    period_end_date: "2025-12-31",
    closing_voucher_id: voucher.id,
    retained_earnings_account_id: retainedEarnings.id,
    status: "CLOSED",
  });
  const signoff = (values: Row) =>
    seedRow(client, "accounting_fiscal_review_signoffs", {
      company_id: company.id,
      period_start_date: "2025-01-01",
      period_end_date: "2025-12-31",
      retained_earnings_account_id: retainedEarnings.id,
      evidence_hash: EVIDENCE,
      review_kind: "ACCOUNTING",
      reviewer_id: "accountant-1",
      ...values,
    });
  const accounting = await signoff({});
  const owner = await signoff({ review_kind: "OWNER", reviewer_id: "owner-1", ...ownerValues });
  const review = (values: Row = {}): Row => ({
    company_id: company.id,
    fiscal_closure_id: closure.id,
    closing_voucher_id: voucher.id,
    accounting_signoff_id: accounting.id,
    owner_signoff_id: owner.id,
    evidence_hash: EVIDENCE,
    ...values,
  });
  return { company, retainedEarnings, voucher, closure, signoff, accounting, owner, review };
}

async function refuseReview(client: PoolClient, values: Row) {
  const names = Object.keys(values);
  await expectRefused(
    client,
    `INSERT INTO accounting_fiscal_reviewed_closures (reviewed_by, ${names.join(", ")})
     VALUES ('certifier', ${names.map((_, index) => `$${index + 1}`).join(", ")})`,
    names.map((name) => values[name]),
    { code: CHECK_VIOLATION, message: "FISCAL_REVIEW_EVIDENCE_MISMATCH" }
  );
}

describe("a reviewed fiscal close needs matching, independent sign-offs", () => {
  it("records the close when both sign-offs match the closure and the evidence", async () => {
    await withRollback(async (client) => {
      const { review } = await closeWithSignoffs(client);

      const recorded = await insertRow(client, "accounting_fiscal_reviewed_closures", review());

      expect(recorded.evidence_hash).toBe(EVIDENCE);
    });
  });

  it("refuses when one person signed both sign-offs", async () => {
    await withRollback(async (client) => {
      // Only one live sign-off of each kind exists for the same evidence, so the owner's is the one that differs.
      const { review } = await closeWithSignoffs(client, { reviewer_id: "accountant-1" });

      await refuseReview(client, review());
    });
  });

  it("refuses when the sign-offs are of the wrong kind, swapped, or withdrawn", async () => {
    await withRollback(async (client) => {
      const { signoff, accounting, owner, review } = await closeWithSignoffs(client);
      const withdrawn = await signoff({
        review_kind: "OWNER",
        reviewer_id: "owner-2",
        revoked_at: "2026-01-05T00:00:00Z",
        revoked_by: "owner-2",
        revoke_reason: "Figures reopened",
      });

      await refuseReview(client, review({ owner_signoff_id: accounting.id }));
      await refuseReview(client, review({ accounting_signoff_id: owner.id, owner_signoff_id: accounting.id }));
      await refuseReview(client, review({ owner_signoff_id: withdrawn.id }));
    });
  });

  it("refuses when a sign-off covers different evidence, another period or another retained-earnings account", async () => {
    await withRollback(async (client) => {
      const { company, signoff, review } = await closeWithSignoffs(client);
      const otherAccount = await seedRow(client, "ledger_accounts", { company_id: company.id, account_type: "Equity" });
      const otherEvidence = await signoff({
        review_kind: "OWNER",
        reviewer_id: "owner-2",
        evidence_hash: OTHER_EVIDENCE,
      });
      const otherPeriod = await signoff({
        review_kind: "OWNER",
        reviewer_id: "owner-3",
        period_end_date: "2025-06-30",
      });
      const otherRetainedEarnings = await signoff({
        review_kind: "OWNER",
        reviewer_id: "owner-4",
        retained_earnings_account_id: otherAccount.id,
      });

      for (const mismatched of [otherEvidence, otherPeriod, otherRetainedEarnings]) {
        await refuseReview(client, review({ owner_signoff_id: mismatched.id }));
      }
      // The certified hash must also be the one both people signed.
      await refuseReview(client, review({ evidence_hash: OTHER_EVIDENCE }));
    });
  });

  it("refuses a closing voucher that is not the closure's, and anything from another company", async () => {
    await withRollback(async (client) => {
      const { company, review } = await closeWithSignoffs(client);
      const otherVoucher = await seedRow(client, "vouchers", { company_id: company.id, voucher_date: "2025-12-31" });
      const stranger = await closeWithSignoffs(client);

      await refuseReview(client, review({ closing_voucher_id: otherVoucher.id }));
      await refuseReview(client, review({ owner_signoff_id: stranger.owner.id }));
      await refuseReview(client, review({ fiscal_closure_id: stranger.closure.id }));
    });
  });
});

describe("a supplier always belongs to a company", () => {
  const insertSupplier = (client: PoolClient, values: Row = {}) =>
    // company_id is NOT NULL: an explicit null is what lets the trigger fill it in.
    insertRow(client, "suppliers", {
      company_id: null,
      code: `SUP-${process.pid}-${Math.random().toString(36).slice(2, 8)}`,
      ...values,
    });

  /** Leaves exactly the given companies as active, top-level ERP companies for this transaction. */
  async function onlyParentCompanies(client: PoolClient, count: number): Promise<Row[]> {
    await client.query("SET LOCAL session_replication_role = replica");
    await client.query(
      "UPDATE companies SET active = false WHERE active AND company_type = 'erp' AND parent_company_id IS NULL"
    );
    await client.query("SET LOCAL session_replication_role = origin");
    const created: Row[] = [];
    for (let index = 0; index < count; index += 1) {
      created.push(await seedRow(client, "companies", { company_type: "erp", parent_company_id: null, active: true }));
    }
    return created;
  }

  async function configureParent(client: PoolClient, value: string | null) {
    await client.query("DELETE FROM system_settings WHERE key = 'parentCompanyId'");
    if (value !== null) {
      await client.query("INSERT INTO system_settings (key, value) VALUES ('parentCompanyId', $1)", [value]);
    }
  }

  it("keeps the company the writer names", async () => {
    await withRollback(async (client) => {
      const company = await seedRow(client, "companies");
      await configureParent(client, null);

      expect((await insertSupplier(client, { company_id: company.id })).company_id).toBe(company.id);
    });
  });

  it("gives an unowned supplier the configured parent company", async () => {
    await withRollback(async (client) => {
      const parent = await seedRow(client, "companies");
      await onlyParentCompanies(client, 2);
      await configureParent(client, String(parent.id));

      expect((await insertSupplier(client)).company_id).toBe(parent.id);
    });
  });

  it("falls back to the only top-level ERP company when nothing is configured", async () => {
    await withRollback(async (client) => {
      const [only] = await onlyParentCompanies(client, 1);
      await configureParent(client, null);

      expect((await insertSupplier(client)).company_id).toBe(only.id);
    });
  });

  it("refuses an unowned supplier when the parent cannot be decided or does not exist", async () => {
    await withRollback(async (client) => {
      const insert = "INSERT INTO suppliers (code, legal_name) VALUES ($1, 'Unowned supplier')";
      await onlyParentCompanies(client, 2);

      await configureParent(client, null);
      await expectRefused(client, insert, ["GUARD-NONE-1"], {
        code: RAISED,
        message: "Supplier company ownership is required; configure system_settings.parentCompanyId",
      });

      // A malformed setting is ignored, which leaves the same ambiguity.
      await configureParent(client, "not-a-number");
      await expectRefused(client, insert, ["GUARD-NONE-2"], { code: RAISED, message: "ownership is required" });

      await configureParent(client, "2147400000");
      await expectRefused(client, insert, ["GUARD-NONE-3"], {
        code: RAISED,
        message: "Configured supplier parent company 2147400000 does not exist",
      });
    });
  });
});

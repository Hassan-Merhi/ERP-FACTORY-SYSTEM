/**
 * Phase 15 release gate against PostgreSQL: the deployed revision, readiness
 * blockers, review evidence and revocation, and the rollout mode, which can
 * never reach the metadata pilot while voucher-line references stay
 * incompatible. Every database call runs in one rolled-back transaction.
 */
import type { PoolClient } from "pg";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { db } from "../server/db";
import {
  currentPilotEligibilityTx,
  deployedUnifiedReleaseSha,
  METADATA_ENTRY_REFERENCES_BLOCKER,
  recordUnifiedReleaseReviewTx,
  ReleaseError,
  revokeUnifiedReleaseReviewTx,
  setUnifiedReleaseModeTx,
  unifiedReleasePolicyTx,
  unifiedReleaseReadinessTx,
  UNIFIED_PHASES,
} from "../server/services/accounting/unifiedRolloutService";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const env = { ...process.env };
let seq = 0;

async function company(client: PoolClient) {
  const tag = `URS${process.pid}x${++seq}`;
  return Number(
    (await client.query("INSERT INTO companies(code,name) VALUES($1,$2) RETURNING id", [tag, tag])).rows[0].id
  );
}
const actor = (name: string) => ({ userId: `${name}-${process.pid}`, username: name });
const tech = actor("tech");
const owner = actor("owner");

async function expectCode(work: Promise<unknown>, code: string, status: number) {
  const error = await work.then(
    () => null,
    (e: unknown) => e
  );
  expect(error).toBeInstanceOf(ReleaseError);
  expect(error).toMatchObject({ code, status });
  return error as ReleaseError;
}

const review = (companyId: number, kind: "TECHNICAL" | "SECURITY" | "FINANCE", by = tech, over = {}) =>
  db.transaction((tx) =>
    recordUnifiedReleaseReviewTx(tx, {
      companyId,
      kind,
      evidenceReference: "https://ci.example/run/123",
      notes: "Reviewed the release diff",
      releaseSha: SHA,
      actor: by,
      ...over,
    })
  );
const readiness = (companyId: number) => db.transaction((tx) => unifiedReleaseReadinessTx(tx, companyId));

beforeEach(() => {
  delete process.env.RENDER_GIT_COMMIT;
  delete process.env.GIT_COMMIT;
  process.env.UNIFIED_ACCOUNTING_RELEASE_SHA = SHA;
});

afterEach(() => {
  process.env = { ...env };
});

describe("deployedUnifiedReleaseSha", () => {
  it("prefers the host's commit over the manual fallback and accepts only full hex revisions", () => {
    process.env.UNIFIED_ACCOUNTING_RELEASE_SHA = ` ${"C".repeat(40)} `;
    expect(deployedUnifiedReleaseSha()).toBe("c".repeat(40));
    process.env.GIT_COMMIT = "d".repeat(64);
    expect(deployedUnifiedReleaseSha()).toBe("d".repeat(64));
    process.env.RENDER_GIT_COMMIT = "e".repeat(40);
    expect(deployedUnifiedReleaseSha()).toBe("e".repeat(40));
    process.env.RENDER_GIT_COMMIT = "abc123";
    expect(deployedUnifiedReleaseSha()).toBeNull();
    process.env.RENDER_GIT_COMMIT = "f".repeat(65);
    expect(deployedUnifiedReleaseSha()).toBeNull();
    delete process.env.RENDER_GIT_COMMIT;
    delete process.env.GIT_COMMIT;
    delete process.env.UNIFIED_ACCOUNTING_RELEASE_SHA;
    expect(deployedUnifiedReleaseSha()).toBeNull();
  });
});

describe("unifiedReleaseReadinessTx", () => {
  it("stays provisional and blocked on voucher-line compatibility for a clean company", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client);
      const r = await readiness(id);
      expect(r).toMatchObject({
        companyId: id,
        deployedSha: SHA,
        releaseMode: "READ_ONLY",
        policy: { configured: false, releaseMode: "READ_ONLY", releaseSha: null, updatedBy: null },
        bookedTrial: { balanced: true },
        historicalFx: { certified: false },
        schema: { missing: [], unprotected: [] },
        posting: {
          phase15CanActivateInventory: false,
          phase15CanPostFinancialVouchers: false,
          phase15CanRewriteHistoricalVouchers: false,
        },
        releaseReviews: [],
        metadataEntryReferencesCompatible: false,
        reviewsComplete: false,
        blockers: [METADATA_ENTRY_REFERENCES_BLOCKER],
        eligibleForExternalReview: false,
        pilotOperational: false,
        certified: false,
        status: "PROVISIONAL_NOT_CERTIFIED",
      });
      expect(r.schema.tables).toHaveLength(13);
      expect(r.phaseCatalog).toHaveLength(UNIFIED_PHASES.length);
      expect(r.phaseCatalog[14]).toEqual({
        phase: 15,
        title: "Integration, permissions and rollout",
        erpPath: "/accounting/rollout",
        implementation: "COMMITTED_AWAITING_INDEPENDENT_VERIFICATION",
      });
      expect(r.warnings).toHaveLength(6);
    });
  });

  it("blocks a missing revision, an inactive or foreign company and unbalanced books", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client);
      delete process.env.UNIFIED_ACCOUNTING_RELEASE_SHA;
      await client.query("UPDATE companies SET active=false, base_currency='ZMW' WHERE id=$1", [id]);
      await client.query("SET LOCAL session_replication_role = replica");
      const voucher = (
        await client.query(
          `INSERT INTO vouchers(company_id,voucher_number,voucher_type,voucher_date,total_amount,created_by)
           VALUES($1,$2,'Journal','2025-01-01',0,'u') RETURNING id`,
          [id, `URS-${process.pid}-${++seq}`]
        )
      ).rows[0].id;
      const account = (
        await client.query(
          "INSERT INTO ledger_accounts(company_id,code,name,account_type) VALUES($1,$2,'Cash','Asset') RETURNING id",
          [id, `C-${process.pid}-${++seq}`]
        )
      ).rows[0].id;
      await client.query("INSERT INTO voucher_entries(voucher_id,ledger_account_id,debit_amount) VALUES($1,$2,25)", [
        voucher,
        account,
      ]);
      await client.query("SET LOCAL session_replication_role = origin");
      const r = await readiness(id);
      expect(r.deployedSha).toBeNull();
      expect(r.blockers).toEqual(
        expect.arrayContaining([
          "Deployed full source SHA unavailable: set UNIFIED_ACCOUNTING_RELEASE_SHA or use Render full commit SHA before certification",
          "Selected company is inactive or missing",
          "Non-USD functional-base financial translation requires certified policy",
          `Unresolved canonical trial balance difference: USD ${r.bookedTrial.differenceUsd}`,
        ])
      );
      expect(r.bookedTrial.balanced).toBe(false);
    });
  });

  it("blocks unresolved historical FX bases", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client);
      await client.query("SET LOCAL session_replication_role = replica");
      const voucher = (
        await client.query(
          `INSERT INTO vouchers(company_id,voucher_number,voucher_type,voucher_date,total_amount,created_by,currency)
           VALUES($1,$2,'Journal','2025-01-01',0,'u','ZMW') RETURNING id`,
          [id, `URS-${process.pid}-${++seq}`]
        )
      ).rows[0].id;
      const account = (
        await client.query(
          "INSERT INTO ledger_accounts(company_id,code,name,account_type) VALUES($1,$2,'Cash','Asset') RETURNING id",
          [id, `C-${process.pid}-${++seq}`]
        )
      ).rows[0].id;
      // A translated debit marks the company as migrated; the credit has no USD base.
      await client.query(
        "INSERT INTO voucher_entries(voucher_id,ledger_account_id,debit_amount,base_debit_amount) VALUES($1,$2,10,10)",
        [voucher, account]
      );
      await client.query("INSERT INTO voucher_entries(voucher_id,ledger_account_id,credit_amount) VALUES($1,$2,10)", [
        voucher,
        account,
      ]);
      await client.query("SET LOCAL session_replication_role = origin");
      const r = await readiness(id);
      expect(r.historicalFx).toMatchObject({ ready: false, unresolvedEntryCount: 1, unresolvedVoucherCount: 1 });
      expect(r.blockers).toContain(
        `Unresolved historical FX base records: ${r.historicalFx.unresolvedEntryCount} entries and ${r.historicalFx.unresolvedVoucherCount} vouchers`
      );
    });
  });

  it("blocks a missing metadata table and one without forced RLS", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client);
      // DDL is transactional, so both changes roll back with the test.
      await client.query("ALTER TABLE accounting_fx_realizations RENAME TO accounting_fx_realizations_hidden");
      await client.query("ALTER TABLE cost_center_monthly_budgets NO FORCE ROW LEVEL SECURITY");
      const r = await readiness(id);
      expect(r.schema).toMatchObject({
        missing: ["accounting_fx_realizations"],
        unprotected: ["cost_center_monthly_budgets"],
      });
      expect(r.blockers).toEqual(
        expect.arrayContaining([
          "Missing additive accounting metadata tables: accounting_fx_realizations",
          "Required RLS, FORCE RLS or company policy is missing: cost_center_monthly_budgets",
        ])
      );
    });
  });
});

describe("release reviews", () => {
  it("records evidence for the deployed revision only", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client);
      await expectCode(review(id, "TECHNICAL", { userId: "  ", username: "x" }), "RELEASE_ACTOR_MISSING", 401);
      for (const over of [
        { evidenceReference: "too short" },
        { evidenceReference: "x".repeat(501) },
        { notes: "  short  " },
        { notes: "n".repeat(2001) },
      ]) {
        await expectCode(review(id, "TECHNICAL", tech, over), "RELEASE_EVIDENCE_INVALID", 400);
      }
      await expectCode(review(id, "TECHNICAL", tech, { releaseSha: OTHER_SHA }), "RELEASE_SHA_INVALID", 409);

      const recorded = await review(id, "TECHNICAL", tech, {
        evidenceReference: "  https://ci.example/run/123  ",
        notes: "  Reviewed the release diff  ",
      });
      expect(recorded).toEqual({ id: expect.any(Number), releaseSha: SHA, reviewKind: "TECHNICAL" });
      const audit = (
        await client.query(
          "SELECT action, changes FROM audit_log WHERE table_name='accounting_unified_release_reviews' AND record_id=$1",
          [String(recorded.id)]
        )
      ).rows;
      expect(audit).toMatchObject([
        {
          action: "approve",
          changes: {
            evidenceReference: { new: "https://ci.example/run/123" },
            notes: { new: "Reviewed the release diff" },
          },
        },
      ]);
      expect((await readiness(id)).releaseReviews).toEqual([
        {
          id: recorded.id,
          kind: "TECHNICAL",
          reviewerId: tech.userId,
          reviewerName: "tech",
          reviewedAt: expect.any(String),
          evidenceReference: "https://ci.example/run/123",
          notes: "Reviewed the release diff",
          revoked: false,
        },
      ]);

      // A redeploy hides reviews of the old revision and refuses new ones for it.
      process.env.UNIFIED_ACCOUNTING_RELEASE_SHA = OTHER_SHA;
      expect((await readiness(id)).releaseReviews).toEqual([]);
      await expectCode(review(id, "SECURITY"), "RELEASE_SHA_INVALID", 409);
      delete process.env.UNIFIED_ACCOUNTING_RELEASE_SHA;
      await expectCode(review(id, "SECURITY", tech, { releaseSha: "" }), "RELEASE_SHA_INVALID", 409);
    });
  });

  it("counts reviews complete only with all three kinds and a technical reviewer other than the policy owner", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client);
      await review(id, "TECHNICAL", tech);
      await review(id, "SECURITY", actor("sec"));
      expect((await readiness(id)).reviewsComplete).toBe(false);
      await review(id, "FINANCE", actor("fin"));
      expect((await readiness(id)).reviewsComplete).toBe(true);
      await db.transaction((tx) =>
        setUnifiedReleaseModeTx(tx, {
          companyId: id,
          mode: "READ_ONLY",
          reason: "Technical lead owns the rollout",
          releaseSha: null,
          actor: tech,
        })
      );
      expect((await readiness(id)).reviewsComplete).toBe(false);
    });
  });

  it("revokes an active review once, with a reason", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client);
      const { id: reviewId } = await review(id, "TECHNICAL");
      const revoke = (rid: number, reason = "  Evidence link was wrong  ", companyId = id) =>
        db.transaction((tx) => revokeUnifiedReleaseReviewTx(tx, { companyId, reviewId: rid, reason, actor: owner }));
      await expectCode(revoke(0), "RELEASE_REVIEW_INVALID", 400);
      await expectCode(revoke(1.5), "RELEASE_REVIEW_INVALID", 400);
      await expectCode(revoke(reviewId, "too short"), "RELEASE_REASON_INVALID", 400);
      await expectCode(revoke(reviewId, "r".repeat(1001)), "RELEASE_REASON_INVALID", 400);
      await expectCode(revoke(reviewId, undefined, await company(client)), "RELEASE_REVIEW_MISSING", 404);

      await expect(revoke(reviewId)).resolves.toEqual({ id: reviewId, revoked: true });
      expect(
        (
          await client.query("SELECT revoked_by, revoke_reason FROM accounting_unified_release_reviews WHERE id=$1", [
            reviewId,
          ])
        ).rows[0]
      ).toEqual({ revoked_by: owner.userId, revoke_reason: "Evidence link was wrong" });
      expect((await readiness(id)).releaseReviews[0].revoked).toBe(true);
      await expectCode(revoke(reviewId), "RELEASE_REVIEW_MISSING", 404);
    });
  });
});

describe("rollout mode", () => {
  it("records read-only mode and refuses the metadata pilot", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client);
      const set = (
        mode: "READ_ONLY" | "METADATA_PILOT",
        releaseSha: string | null,
        reason = "Owner rollout decision"
      ) =>
        db.transaction((tx) => setUnifiedReleaseModeTx(tx, { companyId: id, mode, reason, releaseSha, actor: owner }));

      await expectCode(set("READ_ONLY", null, "short"), "RELEASE_REASON_INVALID", 400);
      await expectCode(
        db.transaction((tx) =>
          setUnifiedReleaseModeTx(tx, {
            companyId: id,
            mode: "READ_ONLY",
            reason: "Owner rollout decision",
            releaseSha: null,
            actor: { userId: "", username: "" },
          })
        ),
        "RELEASE_ACTOR_MISSING",
        401
      );

      expect(await set("READ_ONLY", SHA, "  Owner rollout decision  ")).toMatchObject({
        companyId: id,
        releaseMode: "READ_ONLY",
        releaseSha: null,
        updatedBy: owner.userId,
        reason: "Owner rollout decision",
        configured: true,
      });
      await expectCode(set("METADATA_PILOT", OTHER_SHA), "RELEASE_SHA_INVALID", 409);
      const blocked = await expectCode(set("METADATA_PILOT", SHA), "RELEASE_READINESS_BLOCKED", 409);
      expect(blocked.message).toBe(METADATA_ENTRY_REFERENCES_BLOCKER);
      delete process.env.UNIFIED_ACCOUNTING_RELEASE_SHA;
      await expectCode(set("METADATA_PILOT", null), "RELEASE_SHA_INVALID", 409);

      await set("READ_ONLY", null, "Second owner decision");
      const audits = (
        await client.query(
          "SELECT changes FROM audit_log WHERE table_name='accounting_unified_rollout_policy' AND company_id=$1 ORDER BY id",
          [id]
        )
      ).rows.map((r) => [r.changes.releaseMode, r.changes.reason]);
      expect(audits).toEqual([
        [{ old: "READ_ONLY", new: "READ_ONLY" }, { new: "Owner rollout decision" }],
        [{ old: "READ_ONLY", new: "READ_ONLY" }, { new: "Second owner decision" }],
      ]);
      expect((await db.transaction((tx) => unifiedReleasePolicyTx(tx, id))).reason).toBe("Second owner decision");
    });
  });

  it("never allows the pilot, even for a stored pilot row", async () => {
    await withRolledBackPool(async (client) => {
      const id = await company(client);
      await client.query(
        `INSERT INTO accounting_unified_rollout_policy(company_id,release_mode,release_sha,approved_by,reason)
         VALUES($1,'METADATA_PILOT',$2,$3,'Stored by an older revision')`,
        [id, SHA, owner.userId]
      );
      const eligibility = await db.transaction((tx) => currentPilotEligibilityTx(tx, id));
      expect(eligibility).toMatchObject({
        allowed: false,
        deployedSha: SHA,
        reason: METADATA_ENTRY_REFERENCES_BLOCKER,
        policy: { releaseMode: "METADATA_PILOT", releaseSha: SHA, configured: true },
      });
      expect((await readiness(id)).pilotOperational).toBe(false);
    });
  });
});

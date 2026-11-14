/**
 * Append-only and immutability triggers, attacked directly in SQL.
 *
 * These tables are evidence: the audit trail, the Factory row history, fiscal
 * close sign-offs, release reviews, bonus reviews, pressing confirmations and
 * the frozen Stock Transfer Order approval records. Each has a trigger that
 * refuses to let a recorded fact be rewritten or removed. Every test seeds a
 * row, attempts the forbidden write, checks the row is unchanged, and, where
 * the guard allows one narrow change (a revoke, a void, a retention purge),
 * shows that change still works so the guard is not simply refusing everything.
 */
import { describe, expect, it } from "vitest";

import { expectAccepted, expectRefused, reread, seedRow, withRollback } from "./helpers/dbGuardHarness";

const HASH_64 = "a".repeat(64);
const SHA_40 = "b".repeat(40);
const MONDAY = "2026-01-12";
const SUNDAY = "2026-01-18";
const INSUFFICIENT_PRIVILEGE = "42501";
const CHECK_VIOLATION = "23514";
const RAISED = "P0001";

describe("audit_log is append-only", () => {
  it("refuses to change a recorded audit row", async () => {
    await withRollback(async (client) => {
      const row = await seedRow(client, "audit_log", { table_name: "vouchers", action: "UPDATE" });

      await expectRefused(client, "UPDATE audit_log SET action = 'DELETE' WHERE id = $1", [row.id], {
        code: INSUFFICIENT_PRIVILEGE,
        message: "AUDIT_LOG_APPEND_ONLY",
      });
      await expectRefused(client, "UPDATE audit_log SET changes = '{}'::jsonb WHERE id = $1", [row.id], {
        code: INSUFFICIENT_PRIVILEGE,
        message: "cannot be changed",
      });
      expect((await reread(client, "audit_log", row.id)).action).toBe("UPDATE");
    });
  });

  it("refuses to delete an audit row in ordinary operation", async () => {
    await withRollback(async (client) => {
      const financial = await seedRow(client, "audit_log", { table_name: "vouchers" });
      const operational = await seedRow(client, "audit_log", { table_name: "reports" });

      for (const row of [financial, operational]) {
        await expectRefused(client, "DELETE FROM audit_log WHERE id = $1", [row.id], {
          code: INSUFFICIENT_PRIVILEGE,
          message: "cannot be deleted",
        });
        await reread(client, "audit_log", row.id);
      }
    });
  });

  it("lets the retention job purge operational rows but never financial ones", async () => {
    await withRollback(async (client) => {
      const financial = await seedRow(client, "audit_log", { table_name: "vouchers" });
      const operational = await seedRow(client, "audit_log", { table_name: "reports" });
      await client.query("SET LOCAL app.audit_log_maintenance = 'retention'");

      await expectRefused(client, "DELETE FROM audit_log WHERE id = $1", [financial.id], {
        code: INSUFFICIENT_PRIVILEGE,
        message: "AUDIT_LOG_APPEND_ONLY",
      });
      await expectAccepted(client, "DELETE FROM audit_log WHERE id = $1 RETURNING id", [operational.id]);

      // Retention is a delete permission only: it does not unlock edits.
      await expectRefused(client, "UPDATE audit_log SET action = 'x' WHERE id = $1", [financial.id], {
        code: INSUFFICIENT_PRIVILEGE,
      });
    });
  });

  it("ignores any maintenance value other than the exact retention switch", async () => {
    await withRollback(async (client) => {
      const operational = await seedRow(client, "audit_log", { table_name: "reports" });

      for (const value of ["on", "true", "retention-all", "purge"]) {
        await client.query("SELECT set_config('app.audit_log_maintenance', $1, true)", [value]);
        await expectRefused(client, "DELETE FROM audit_log WHERE id = $1", [operational.id], {
          code: INSUFFICIENT_PRIVILEGE,
        });
      }
    });
  });

  it("refuses to truncate the audit trail", async () => {
    await withRollback(async (client) => {
      await expectRefused(client, "TRUNCATE audit_log", [], {
        code: INSUFFICIENT_PRIVILEGE,
        message: "cannot be truncated",
      });
    });
  });
});

describe("factory_row_history is append-only", () => {
  it("refuses to change, delete or truncate recorded history", async () => {
    await withRollback(async (client) => {
      const row = await seedRow(client, "factory_row_history", { table_name: "factory_bales", op: "U" });

      await expectRefused(client, "UPDATE factory_row_history SET actor = 'someone else' WHERE id = $1", [row.id], {
        code: INSUFFICIENT_PRIVILEGE,
        message: "FACTORY_ROW_HISTORY_APPEND_ONLY",
      });
      await expectRefused(client, "DELETE FROM factory_row_history WHERE id = $1", [row.id], {
        code: INSUFFICIENT_PRIVILEGE,
        message: "FACTORY_ROW_HISTORY_APPEND_ONLY",
      });
      await expectRefused(client, "TRUNCATE factory_row_history", [], {
        code: INSUFFICIENT_PRIVILEGE,
        message: "FACTORY_ROW_HISTORY_APPEND_ONLY",
      });
      await reread(client, "factory_row_history", row.id);
    });
  });
});

describe("pressing confirmations and their corrections", () => {
  it("never lets a pressing correction be changed or deleted", async () => {
    await withRollback(async (client) => {
      const correction = await seedRow(client, "factory_pressing_corrections", {
        action: "VOID",
        reason: "wrong bale",
      });

      await expectRefused(
        client,
        "UPDATE factory_pressing_corrections SET reason = 'rewritten' WHERE id = $1",
        [correction.id],
        { code: RAISED, message: "append-only" }
      );
      await expectRefused(client, "DELETE FROM factory_pressing_corrections WHERE id = $1", [correction.id], {
        code: RAISED,
        message: "append-only",
      });
      expect((await reread(client, "factory_pressing_corrections", correction.id)).reason).toBe("wrong bale");
    });
  });

  it("never lets a pressing confirmation be deleted or edited", async () => {
    await withRollback(async (client) => {
      const confirmation = await seedRow(client, "factory_pressing_confirmations", { weight_kg: "50" });

      await expectRefused(client, "DELETE FROM factory_pressing_confirmations WHERE id = $1", [confirmation.id], {
        code: RAISED,
        message: "cannot be deleted",
      });
      await expectRefused(
        client,
        "UPDATE factory_pressing_confirmations SET weight_kg = 75 WHERE id = $1",
        [confirmation.id],
        { code: RAISED, message: "Only a single audited void" }
      );
      expect(Number((await reread(client, "factory_pressing_confirmations", confirmation.id)).weight_kg)).toBe(50);
    });
  });

  it("refuses a void that no supervisor correction backs", async () => {
    await withRollback(async (client) => {
      const confirmation = await seedRow(client, "factory_pressing_confirmations");

      await expectRefused(
        client,
        "UPDATE factory_pressing_confirmations SET voided_at = now(), voided_by = 'sup-1' WHERE id = $1",
        [confirmation.id],
        { code: RAISED, message: "A supervisor correction event must be recorded" }
      );

      // A correction recorded by a different supervisor does not count, and
      // neither does a re-confirmation event by the same one.
      await seedRow(client, "factory_pressing_corrections", {
        company_id: confirmation.company_id,
        confirmation_id: confirmation.id,
        action: "VOID",
        supervisor_user_id: "sup-2",
      });
      await seedRow(client, "factory_pressing_corrections", {
        company_id: confirmation.company_id,
        confirmation_id: confirmation.id,
        action: "RECONFIRM",
        supervisor_user_id: "sup-1",
      });
      await expectRefused(
        client,
        "UPDATE factory_pressing_confirmations SET voided_at = now(), voided_by = 'sup-1' WHERE id = $1",
        [confirmation.id],
        { code: RAISED, message: "A supervisor correction event must be recorded" }
      );
      expect((await reread(client, "factory_pressing_confirmations", confirmation.id)).voided_at).toBeNull();
    });
  });

  it("allows exactly one audited void, and nothing after it", async () => {
    await withRollback(async (client) => {
      const confirmation = await seedRow(client, "factory_pressing_confirmations", { weight_kg: "50" });
      await seedRow(client, "factory_pressing_corrections", {
        company_id: confirmation.company_id,
        confirmation_id: confirmation.id,
        action: "VOID",
        supervisor_user_id: "sup-1",
      });

      // A void may not smuggle in another change.
      await expectRefused(
        client,
        "UPDATE factory_pressing_confirmations SET voided_at = now(), voided_by = 'sup-1', weight_kg = 1 WHERE id = $1",
        [confirmation.id],
        { code: RAISED, message: "Only a single audited void" }
      );

      await expectAccepted(
        client,
        "UPDATE factory_pressing_confirmations SET voided_at = now(), voided_by = 'sup-1' WHERE id = $1 RETURNING id",
        [confirmation.id]
      );
      const voided = await reread(client, "factory_pressing_confirmations", confirmation.id);
      expect(voided.voided_by).toBe("sup-1");
      expect(Number(voided.weight_kg)).toBe(50);

      await expectRefused(
        client,
        "UPDATE factory_pressing_confirmations SET voided_at = now(), voided_by = 'sup-1' WHERE id = $1",
        [confirmation.id],
        { code: RAISED, message: "Only a single audited void" }
      );
      await expectRefused(
        client,
        "UPDATE factory_pressing_confirmations SET voided_at = NULL, voided_by = NULL WHERE id = $1",
        [confirmation.id],
        { code: RAISED, message: "Only a single audited void" }
      );
    });
  });
});

describe("fiscal close sign-offs", () => {
  const signoff = { review_kind: "ACCOUNTING", note: "Reviewed the trial balance" };

  it("never lets a sign-off be deleted or its content edited", async () => {
    await withRollback(async (client) => {
      const row = await seedRow(client, "accounting_fiscal_review_signoffs", signoff);

      await expectRefused(client, "DELETE FROM accounting_fiscal_review_signoffs WHERE id = $1", [row.id], {
        code: CHECK_VIOLATION,
        message: "FISCAL_SIGNOFF_DELETE_FORBIDDEN",
      });
      for (const change of [
        "note = 'rewritten afterwards'",
        "reviewer_id = 'someone-else'",
        "evidence_hash = 'ffff'",
      ]) {
        await expectRefused(client, `UPDATE accounting_fiscal_review_signoffs SET ${change} WHERE id = $1`, [row.id], {
          code: CHECK_VIOLATION,
          message: "FISCAL_SIGNOFF_IMMUTABLE",
        });
      }
      expect((await reread(client, "accounting_fiscal_review_signoffs", row.id)).note).toBe(signoff.note);
    });
  });

  it("allows one revocation with a named revoker and a real reason, and no second one", async () => {
    await withRollback(async (client) => {
      const row = await seedRow(client, "accounting_fiscal_review_signoffs", signoff);
      const revoke = (by: string, reason: string) =>
        [
          "UPDATE accounting_fiscal_review_signoffs SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1 RETURNING id",
          [row.id, by, reason],
        ] as const;

      await expectRefused(client, ...revoke("owner", "too short"), {
        code: CHECK_VIOLATION,
        message: "FISCAL_SIGNOFF_IMMUTABLE",
      });
      await expectRefused(client, ...revoke("   ", "Signed against the wrong period"), {
        code: CHECK_VIOLATION,
        message: "FISCAL_SIGNOFF_IMMUTABLE",
      });
      // A revocation may not also rewrite the sign-off.
      await expectRefused(
        client,
        "UPDATE accounting_fiscal_review_signoffs SET revoked_at = now(), revoked_by = 'owner', revoke_reason = 'Signed against the wrong period', note = 'edited' WHERE id = $1",
        [row.id],
        { code: CHECK_VIOLATION, message: "FISCAL_SIGNOFF_IMMUTABLE" }
      );

      await expectAccepted(client, ...revoke("owner", "Signed against the wrong period"));
      expect((await reread(client, "accounting_fiscal_review_signoffs", row.id)).revoked_by).toBe("owner");

      await expectRefused(client, ...revoke("owner", "Revoking a second time"), {
        code: CHECK_VIOLATION,
        message: "FISCAL_SIGNOFF_IMMUTABLE",
      });
    });
  });

  it("refuses to revoke a sign-off that a reviewed closure relies on", async () => {
    await withRollback(async (client) => {
      const accounting = await seedRow(client, "accounting_fiscal_review_signoffs", signoff);
      const owner = await seedRow(client, "accounting_fiscal_review_signoffs", {
        ...signoff,
        review_kind: "OWNER",
        company_id: accounting.company_id,
      });
      await seedRow(client, "accounting_fiscal_reviewed_closures", {
        company_id: accounting.company_id,
        accounting_signoff_id: accounting.id,
        owner_signoff_id: owner.id,
        evidence_hash: HASH_64,
      });

      for (const row of [accounting, owner]) {
        await expectRefused(
          client,
          "UPDATE accounting_fiscal_review_signoffs SET revoked_at = now(), revoked_by = 'owner', revoke_reason = 'Signed against the wrong period' WHERE id = $1",
          [row.id],
          { code: CHECK_VIOLATION, message: "FISCAL_SIGNOFF_IMMUTABLE" }
        );
        expect((await reread(client, "accounting_fiscal_review_signoffs", row.id)).revoked_at).toBeNull();
      }
    });
  });
});

describe("reviewed fiscal closures", () => {
  const closure = { accounting_signoff_id: 11, owner_signoff_id: 12, fiscal_closure_id: 7, evidence_hash: HASH_64 };

  it("never lets a reviewed closure be deleted or edited", async () => {
    await withRollback(async (client) => {
      const row = await seedRow(client, "accounting_fiscal_reviewed_closures", closure);

      await expectRefused(client, "DELETE FROM accounting_fiscal_reviewed_closures WHERE id = $1", [row.id], {
        code: CHECK_VIOLATION,
        message: "FISCAL_REVIEWED_CLOSE_IMMUTABLE",
      });
      for (const change of ["reviewed_by = 'someone-else'", "closing_voucher_id = 1", "fiscal_closure_id = 99"]) {
        await expectRefused(
          client,
          `UPDATE accounting_fiscal_reviewed_closures SET ${change} WHERE id = $1`,
          [row.id],
          {
            code: CHECK_VIOLATION,
            message: "FISCAL_REVIEWED_CLOSE_IMMUTABLE",
          }
        );
      }
      expect(Number((await reread(client, "accounting_fiscal_reviewed_closures", row.id)).fiscal_closure_id)).toBe(7);
    });
  });

  it("allows only detaching it from a reopened fiscal closure, with nothing else changed", async () => {
    await withRollback(async (client) => {
      const row = await seedRow(client, "accounting_fiscal_reviewed_closures", closure);

      await expectRefused(
        client,
        "UPDATE accounting_fiscal_reviewed_closures SET fiscal_closure_id = NULL, reviewed_by = 'x' WHERE id = $1",
        [row.id],
        { code: CHECK_VIOLATION, message: "FISCAL_REVIEWED_CLOSE_IMMUTABLE" }
      );
      await expectAccepted(
        client,
        "UPDATE accounting_fiscal_reviewed_closures SET fiscal_closure_id = NULL WHERE id = $1 RETURNING id",
        [row.id]
      );
      // Once detached it cannot be re-attached or detached again.
      await expectRefused(
        client,
        "UPDATE accounting_fiscal_reviewed_closures SET fiscal_closure_id = 7 WHERE id = $1",
        [row.id],
        { code: CHECK_VIOLATION, message: "FISCAL_REVIEWED_CLOSE_IMMUTABLE" }
      );
      await expectRefused(
        client,
        "UPDATE accounting_fiscal_reviewed_closures SET fiscal_closure_id = NULL WHERE id = $1",
        [row.id],
        { code: CHECK_VIOLATION, message: "FISCAL_REVIEWED_CLOSE_IMMUTABLE" }
      );
    });
  });
});

describe("unified release reviews", () => {
  const review = { release_sha: SHA_40, review_kind: "FINANCE", notes: "Ledger reconciliation reviewed" };

  it("never lets a release review be deleted or edited", async () => {
    await withRollback(async (client) => {
      const row = await seedRow(client, "accounting_unified_release_reviews", review);

      await expectRefused(client, "DELETE FROM accounting_unified_release_reviews WHERE id = $1", [row.id], {
        code: CHECK_VIOLATION,
        message: "RELEASE_REVIEW_DELETE_FORBIDDEN",
      });
      for (const change of [
        "notes = 'A different conclusion entirely'",
        "review_kind = 'SECURITY'",
        "reviewer_id = 'x'",
      ]) {
        await expectRefused(client, `UPDATE accounting_unified_release_reviews SET ${change} WHERE id = $1`, [row.id], {
          code: CHECK_VIOLATION,
          message: "RELEASE_REVIEW_IMMUTABLE",
        });
      }
      expect((await reread(client, "accounting_unified_release_reviews", row.id)).notes).toBe(review.notes);
    });
  });

  it("allows one revocation with a named revoker and a real reason, and no second one", async () => {
    await withRollback(async (client) => {
      const row = await seedRow(client, "accounting_unified_release_reviews", review);
      const revoke = (by: string, reason: string) =>
        [
          "UPDATE accounting_unified_release_reviews SET revoked_at = now(), revoked_by = $2, revoke_reason = $3 WHERE id = $1 RETURNING id",
          [row.id, by, reason],
        ] as const;

      await expectRefused(client, ...revoke("cfo", "short"), {
        code: CHECK_VIOLATION,
        message: "RELEASE_REVIEW_IMMUTABLE",
      });
      await expectRefused(client, ...revoke("  ", "Reviewed the wrong release build"), {
        code: CHECK_VIOLATION,
        message: "RELEASE_REVIEW_IMMUTABLE",
      });

      await expectAccepted(client, ...revoke("cfo", "Reviewed the wrong release build"));

      await expectRefused(client, ...revoke("cfo", "Revoking a second time over"), {
        code: CHECK_VIOLATION,
        message: "RELEASE_REVIEW_IMMUTABLE",
      });
    });
  });
});

describe("production bonus records", () => {
  const review = {
    target_bales: "10",
    credited_bales: 12,
    extra_bales: "2",
    bonus_amount: "5",
    status: "approved",
    snapshot_json: "{}",
    snapshot_hash: HASH_64,
  };

  it.each([
    [
      "factory_production_target_bonus_weekly_methods",
      { effective_week: MONDAY, method: "per_extra_bale", flat_bonus_usd: "0" },
      "note = 'changed'",
      "weekly method versions are immutable",
    ],
    ["factory_target_bonus_category_reviews", review, "bonus_amount = 500", "Category bonus reviews are immutable"],
    [
      "factory_target_bonus_weekly_reviews",
      { ...review, week_start: MONDAY, week_end: SUNDAY },
      "bonus_amount = 500",
      "weekly reviews are immutable",
    ],
  ])("never lets a row in %s be changed or deleted", async (table, values, change, message) => {
    await withRollback(async (client) => {
      const row = await seedRow(client, table, values);

      await expectRefused(client, `UPDATE "${table}" SET ${change} WHERE id = $1`, [row.id], { code: RAISED, message });
      await expectRefused(client, `DELETE FROM "${table}" WHERE id = $1`, [row.id], { code: RAISED, message });

      const after = await reread(client, table, row.id);
      expect(after).toEqual(row);
    });
  });
});

describe("Stock Transfer Order WhatsApp approval evidence", () => {
  it.each([
    ["stock_transfer_order_approval_batch_revisions", {}, "payload_hash_snapshot = 'tampered'"],
    ["stock_transfer_order_approval_events", { event_type: "approved" }, "event_type = 'declined'"],
  ])("never lets a row in %s be changed or deleted", async (table, values, change) => {
    await withRollback(async (client) => {
      const row = await seedRow(client, table, values);

      await expectRefused(client, `UPDATE "${table}" SET ${change} WHERE id = $1`, [row.id], {
        code: RAISED,
        message: "approval evidence is immutable",
      });
      await expectRefused(client, `DELETE FROM "${table}" WHERE id = $1`, [row.id], {
        code: RAISED,
        message: "approval evidence is immutable",
      });
      expect(await reread(client, table, row.id)).toEqual(row);
    });
  });

  it("freezes a batch item's identity but still lets its stock reservation be released", async () => {
    await withRollback(async (client) => {
      const item = await seedRow(client, "stock_transfer_order_approval_batch_items", {
        voucher_number_snapshot: "STO-0001",
        item_hash_snapshot: HASH_64,
        reservation_active: true,
      });

      await expectRefused(client, "DELETE FROM stock_transfer_order_approval_batch_items WHERE id = $1", [item.id], {
        code: RAISED,
        message: "cannot be deleted",
      });
      for (const change of [
        "item_hash_snapshot = 'tampered'",
        "voucher_number_snapshot = 'STO-9999'",
        "transfer_id = transfer_id + 1",
        "batch_id = batch_id + 1",
        "company_id = company_id + 1",
        "created_at = created_at + interval '1 day'",
      ]) {
        await expectRefused(
          client,
          `UPDATE stock_transfer_order_approval_batch_items SET ${change} WHERE id = $1`,
          [item.id],
          { code: RAISED, message: "evidence cannot be changed" }
        );
      }

      await expectAccepted(
        client,
        "UPDATE stock_transfer_order_approval_batch_items SET reservation_active = false WHERE id = $1 RETURNING id",
        [item.id]
      );
      const after = await reread(client, "stock_transfer_order_approval_batch_items", item.id);
      expect(after.reservation_active).toBe(false);
      expect(after.item_hash_snapshot).toBe(HASH_64);
    });
  });

  it("freezes the approved workbook snapshot, and the rendered file once it exists", async () => {
    await withRollback(async (client) => {
      const workbook = await seedRow(client, "stock_transfer_order_approval_workbooks", {
        snapshot_json: '{"orders":[1]}',
        snapshot_sha256: HASH_64,
      });
      const where = "WHERE company_id = $1 AND batch_id = $2";
      const key = [workbook.company_id, workbook.batch_id];

      await expectRefused(client, `DELETE FROM stock_transfer_order_approval_workbooks ${where}`, key, {
        code: RAISED,
        message: "cannot be deleted",
      });
      for (const change of [`snapshot_json = '{"orders":[2]}'::jsonb`, "snapshot_sha256 = 'tampered'"]) {
        await expectRefused(client, `UPDATE stock_transfer_order_approval_workbooks SET ${change} ${where}`, key, {
          code: RAISED,
          message: "snapshot is immutable",
        });
      }

      // The file is rendered once, after approval...
      await expectAccepted(
        client,
        `UPDATE stock_transfer_order_approval_workbooks
            SET workbook_bytes = '\\x0102'::bytea, workbook_sha256 = 'file-hash', filename = 'orders.xlsx', rendered_at = now()
          ${where} RETURNING batch_id`,
        key
      );
      // ...and is frozen from then on.
      for (const change of [
        "workbook_bytes = '\\x0304'::bytea",
        "workbook_sha256 = 'other-hash'",
        "filename = 'renamed.xlsx'",
        "rendered_at = rendered_at + interval '1 hour'",
      ]) {
        await expectRefused(client, `UPDATE stock_transfer_order_approval_workbooks SET ${change} ${where}`, key, {
          code: RAISED,
          message: "snapshot is immutable",
        });
      }
    });
  });
});

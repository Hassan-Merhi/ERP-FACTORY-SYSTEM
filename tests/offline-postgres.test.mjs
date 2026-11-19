import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyStagedVoucherOnce } from "../server/edge/applyStore.mjs";
import { applyMigrations, databaseUrlFor } from "./helpers/migrateDisposableDatabase.mjs";
import { hashEvidence } from "../server/edge/edgeSyncStageProtocol.mjs";

const url = process.env.PHASE8_TEST_DATABASE_URL;
// A dedicated database built from migrations/ (never from runtime DDL).
const TEST_DB = "phase8_apply_test";
const testUrl = url ? databaseUrlFor(url, TEST_DB) : undefined;
const siteId = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";
const sha = "a".repeat(64);
const base = {
  siteId,
  companyId: 6,
  cloudEpoch: "2",
  baselineSha256: sha,
  operatorAck: "LAN_FROZEN_AND_CLOUD_EPOCH_APPROVED",
};
const maintenance = new Client({ connectionString: url, ssl: false });
const admin = new Client({ connectionString: testUrl, ssl: false });
const app = new Client({
  connectionString: testUrl
    ?.replace("postgres:", "phase8_runtime:")
    .replace("phase8-test-admin-pass", "phase8-test-app-pass"),
  ssl: false,
});
let applied = 0;

function source(sequence, localVoucherId = 88, operationId = randomUUID()) {
  const payload = {
    voucher: {
      id: localVoucherId,
      companyId: 6,
      voucherType: "Journal",
      voucherDate: "2026-10-30",
      currency: "USD",
      totalAmount: "10.00",
    },
    entries: [
      { ledgerAccountId: 11, debitAmount: "10.00", creditAmount: "0" },
      { ledgerAccountId: 12, debitAmount: "0", creditAmount: "10.00" },
    ],
  };
  return {
    sequence: String(sequence),
    operationId,
    companyId: 6,
    actorUserId: "actor-1",
    localVoucherId,
    kind: "voucher.with-entries.v1",
    payload,
    payloadSha256: hashEvidence(payload),
  };
}

async function writeStage(entry) {
  await admin.query(
    `
    INSERT INTO factory_edge_staged_vouchers
      (site_id,sequence,operation_id,company_id,actor_user_id,local_voucher_id,
       operation_kind,payload,payload_sha256)
    VALUES($1::uuid,$2::bigint,$3::uuid,$4,$5,$6,$7,$8::jsonb,$9)
  `,
    [
      siteId,
      entry.sequence,
      entry.operationId,
      entry.companyId,
      entry.actorUserId,
      entry.localVoucherId,
      entry.kind,
      JSON.stringify(entry.payload),
      entry.payloadSha256,
    ]
  );
}
async function postFakeJournal(sameClient, entry) {
  applied++;
  const out = await sameClient.query(
    `INSERT INTO vouchers(company_id,voucher_date,voucher_number,voucher_type,total_amount)
     VALUES($1,$2::date,$3,'Journal',$4) RETURNING id`,
    [entry.companyId, entry.payload.voucher.voucherDate, `P8-${applied}`, entry.payload.voucher.totalAmount]
  );
  return { cloudVoucherId: Number(out.rows[0].id), businessDate: "2026-10-30" };
}

if (!url) {
  test("PostgreSQL 17 integration requires explicit disposable test DB", { skip: true }, () => {});
} else {
  test("phase8 schema + restricted cloud writer, ACK loss, rollback, sequence order, revocation", async () => {
    await maintenance.connect();
    await maintenance.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
    await maintenance.query("DROP ROLE IF EXISTS phase8_runtime");
    await maintenance.query(`CREATE DATABASE ${TEST_DB}`);
    applyMigrations(testUrl);
    await admin.connect();
    try {
      await admin.query(`
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        CREATE ROLE phase8_runtime LOGIN PASSWORD 'phase8-test-app-pass'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
        INSERT INTO companies(id,code,name) VALUES(6,'P8','Phase 8 company');
        INSERT INTO users(id,username,password,active) VALUES('actor-1','actor-1','not-a-login',true);
        INSERT INTO user_company_roles(user_id,company_id,role) VALUES('actor-1',6,'Admin');
      `);
      const sql = await readFile(new URL("../deploy/lan/phase7-install-writer-fence.sql", import.meta.url), "utf8");
      await admin.query(sql);
      await admin.query(`
        UPDATE phase7_writer.state SET mode='cloud-primary',site_id='cloud',
          epoch=2, baseline_sha256=repeat('a',64) WHERE singleton;
        GRANT CONNECT ON DATABASE ${TEST_DB} TO phase8_runtime;
        GRANT USAGE ON SCHEMA public TO phase8_runtime;
        GRANT USAGE ON SCHEMA phase7_writer TO phase8_runtime;
        GRANT SELECT ON phase7_writer.state TO phase8_runtime;
        -- Read access as the runtime role has it; the real voucher triggers
        -- (closed-period guard, audit) read reference tables.
        GRANT SELECT ON ALL TABLES IN SCHEMA public TO phase8_runtime;
        GRANT INSERT,UPDATE ON factory_edge_apply_cursor TO phase8_runtime;
        GRANT INSERT ON factory_edge_applied_vouchers,vouchers,audit_log TO phase8_runtime;
        GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO phase8_runtime;
      `);
      await admin.query(`
        SELECT set_config('phase7_writer.mode','cloud-primary',false),
          set_config('phase7_writer.site_id','cloud',false),
          set_config('phase7_writer.epoch','2',false);
      `);
      await app.connect();
      await app.query(`
        SELECT set_config('app.current_company_id','6',false),
          set_config('phase7_writer.mode','cloud-primary',false),
          set_config('phase7_writer.site_id','cloud',false),
          set_config('phase7_writer.epoch','2',false);
      `);
      const first = source(1);
      await writeStage(first);
      // Receipt cannot be fabricated by a staging-only event; actor requires
      // an independently approved row whose authority has not expired.
      await assert.rejects(
        applyStagedVoucherOnce(app, { ...base, sequence: "1" }, postFakeJournal),
        /PHASE8_ACTOR_NOT_AUTHORIZED/
      );
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM vouchers")).rows[0].n, 0);
      await admin.query(
        `
        INSERT INTO factory_edge_apply_approvals
          (site_id,company_id,actor_user_id,baseline_sha256,approved_until,approved_by)
        VALUES($1::uuid,6,'actor-1',$2,clock_timestamp()+interval '2 hours','test-reviewer')
      `,
        [siteId, sha]
      );

      const posted = await applyStagedVoucherOnce(app, { ...base, sequence: "1" }, postFakeJournal);
      assert.equal(posted.state, "cloud-applied");
      assert.equal(posted.replayed, false);
      assert.ok(posted.cloudVoucherId > 0);
      const replay = await applyStagedVoucherOnce(app, { ...base, sequence: "1" }, async () => {
        throw new Error("ACK loss caused duplicate posting!");
      });
      assert.equal(replay.replayed, true);
      assert.equal(replay.cloudVoucherId, posted.cloudVoucherId);
      assert.equal(applied, 1);
      await assert.rejects(
        applyStagedVoucherOnce(app, { ...base, sequence: "3" }, postFakeJournal),
        /PHASE8_MISSING_PREDECESSOR/
      );
      const second = source(2, 89);
      await writeStage(second);
      await assert.rejects(
        applyStagedVoucherOnce(app, { ...base, sequence: "2" }, async (c, e) => {
          await postFakeJournal(c, e);
          throw new Error("fault injection after business SQL");
        }),
        /fault injection/
      );
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM vouchers")).rows[0].n, 1);
      assert.equal(
        (await admin.query("SELECT last_sequence FROM factory_edge_apply_cursor")).rows[0].last_sequence,
        "1"
      );
      // Operator freezes the cloud DB again: no other write can proceed.
      await admin.query("UPDATE phase7_writer.state SET mode='fenced' WHERE singleton");
      await assert.rejects(
        applyStagedVoucherOnce(app, { ...base, sequence: "2" }, postFakeJournal),
        /PHASE8_CLOUD_WRITER_FENCE_UNVERIFIED|PHASE7_WRITER_EPOCH_FENCED/
      );
      await admin.query("UPDATE phase7_writer.state SET mode='cloud-primary' WHERE singleton");
      await admin.query("UPDATE users SET active=false WHERE id='actor-1'");
      await assert.rejects(
        applyStagedVoucherOnce(app, { ...base, sequence: "2" }, postFakeJournal),
        /PHASE8_ACTOR_NOT_AUTHORIZED/
      );
      await admin.query("UPDATE users SET active=true WHERE id='actor-1'");
      await admin.query("UPDATE user_company_roles SET role='View Only' WHERE user_id='actor-1'");
      await assert.rejects(
        applyStagedVoucherOnce(app, { ...base, sequence: "2" }, postFakeJournal),
        /PHASE8_ACTOR_NOT_AUTHORIZED/
      );
      await admin.query("UPDATE user_company_roles SET role='Admin' WHERE user_id='actor-1'");
      const success = await applyStagedVoucherOnce(app, { ...base, sequence: "2" }, postFakeJournal);
      assert.equal(success.replayed, false);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM vouchers")).rows[0].n, 2);
      assert.equal((await admin.query("SELECT count(*)::int AS n FROM factory_edge_applied_vouchers")).rows[0].n, 2);
      await assert.rejects(admin.query("DELETE FROM factory_edge_applied_vouchers"), (error) => error.code === "23514");
    } finally {
      await app.end().catch(() => undefined);
      await admin.end();
      await maintenance.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`).catch(() => undefined);
      await maintenance.query("DROP ROLE IF EXISTS phase8_runtime").catch(() => undefined);
      await maintenance.end();
    }
  });
}

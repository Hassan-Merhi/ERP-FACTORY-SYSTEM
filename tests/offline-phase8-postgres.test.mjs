import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { applyStagedVoucherOnce, ensurePhase8ApplySchema } from "../server/edge/phase8ApplyStore.mjs";
import { hashEvidence } from "../server/edge/edgeSyncStageProtocol.mjs";

const url = process.env.PHASE8_TEST_DATABASE_URL;
const siteId = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";
const sha = "a".repeat(64);
const base = {
  siteId,
  companyId: 6,
  cloudEpoch: "2",
  baselineSha256: sha,
  operatorAck: "LAN_FROZEN_AND_CLOUD_EPOCH_APPROVED",
};
const admin = new Client({ connectionString: url, ssl: false });
const app = new Client({
  connectionString: url
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
  const out = await sameClient.query("INSERT INTO vouchers(company_id,voucher_date) VALUES($1,$2::date) RETURNING id", [
    entry.companyId,
    entry.payload.voucher.voucherDate,
  ]);
  return { cloudVoucherId: Number(out.rows[0].id), businessDate: "2026-10-30" };
}

if (!url) {
  test("PostgreSQL 17 integration requires explicit disposable test DB", { skip: true }, () => {});
} else {
  test("phase8 schema + restricted cloud writer, ACK loss, rollback, sequence order, revocation", async () => {
    await admin.connect();
    try {
      await admin.query(`
        REVOKE CREATE ON SCHEMA public FROM PUBLIC;
        CREATE ROLE phase8_runtime LOGIN PASSWORD 'phase8-test-app-pass'
          NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
        CREATE TABLE users(id text PRIMARY KEY, active boolean NOT NULL);
        CREATE TABLE user_company_roles(user_id text, company_id integer, role text);
        CREATE TABLE vouchers(id serial PRIMARY KEY, company_id integer, voucher_date date);
        CREATE TABLE factory_edge_staged_vouchers(
          site_id uuid, sequence bigint, operation_id uuid, company_id integer,
          actor_user_id text, local_voucher_id integer, operation_kind text,
          payload jsonb, payload_sha256 char(64),
          staged_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (site_id, sequence));
        INSERT INTO users(id,active) VALUES('actor-1',true);
        INSERT INTO user_company_roles VALUES('actor-1',6,'Admin');
      `);
      await ensurePhase8ApplySchema(admin);
      const sql = await readFile(new URL("../deploy/lan/phase7-install-writer-fence.sql", import.meta.url), "utf8");
      await admin.query(sql);
      await admin.query(`
        UPDATE phase7_writer.state SET mode='cloud-primary',site_id='cloud',
          epoch=2, baseline_sha256=repeat('a',64) WHERE singleton;
        GRANT CONNECT ON DATABASE postgres TO phase8_runtime;
        GRANT USAGE ON SCHEMA public TO phase8_runtime;
        GRANT USAGE ON SCHEMA phase7_writer TO phase8_runtime;
        GRANT SELECT ON phase7_writer.state TO phase8_runtime;
        GRANT SELECT ON users,user_company_roles,factory_edge_staged_vouchers,
          factory_edge_apply_approvals,vouchers,factory_edge_applied_vouchers,
          factory_edge_apply_cursor TO phase8_runtime;
        GRANT INSERT,UPDATE ON factory_edge_apply_cursor TO phase8_runtime;
        GRANT INSERT ON factory_edge_applied_vouchers,vouchers TO phase8_runtime;
        GRANT USAGE,SELECT ON SEQUENCE vouchers_id_seq TO phase8_runtime;
      `);
      await admin.query(`
        SELECT set_config('phase7_writer.mode','cloud-primary',false),
          set_config('phase7_writer.site_id','cloud',false),
          set_config('phase7_writer.epoch','2',false);
      `);
      await app.connect();
      await app.query(`
        SELECT set_config('phase7_writer.mode','cloud-primary',false),
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
    }
  });
}

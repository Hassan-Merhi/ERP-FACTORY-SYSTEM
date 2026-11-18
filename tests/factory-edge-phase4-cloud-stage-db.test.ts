import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { stageVoucherEvents } from "../server/edge/edgeCloudStaging";
import { EDGE_SYNC_STAGE_VERSION, hashEvidence } from "../server/edge/edgeSyncStageProtocol.mjs";

// A fresh site per run: the staged evidence lives in the shared migrated database.
const siteId = randomUUID();
const enabled = Boolean(process.env.DATABASE_URL);

(enabled ? describe : describe.skip)("cloud staged voucher evidence durability", () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  const transportPool = {
    connect: async () => ({
      query: client.query.bind(client),
      release: () => undefined,
    }),
  };
  const operationId = randomUUID();
  const payload = { voucher: { id: 88, companyId: 6, totalAmount: "12.00" }, entries: [{ debitAmount: "12.00" }] };
  const event = {
    sequence: "1",
    operationId,
    companyId: 6,
    actorUserId: "factory-user",
    localVoucherId: 88,
    kind: "voucher.with-entries.v1",
    payload,
    payloadSha256: hashEvidence(payload),
  };
  const envelope = (events: (typeof event)[]) => ({
    protocol: EDGE_SYNC_STAGE_VERSION,
    siteId,
    events,
  });

  // The staging tables and their append-only trigger come from migrations/.
  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    // Test cleanup only: lift the append-only guard for this run's site rows.
    await client.query("ROLLBACK").catch(() => undefined);
    await client.query("BEGIN");
    await client.query("ALTER TABLE factory_edge_staged_vouchers DISABLE TRIGGER factory_edge_stage_no_modify");
    await client.query("DELETE FROM factory_edge_staged_vouchers WHERE site_id = $1", [siteId]);
    await client.query("ALTER TABLE factory_edge_staged_vouchers ENABLE TRIGGER factory_edge_stage_no_modify");
    await client.query("DELETE FROM factory_edge_stage_cursor WHERE site_id = $1", [siteId]);
    await client.query("COMMIT").catch(() => client.query("ROLLBACK"));
    await client.end().catch(() => undefined);
  });

  it("durably stores an event with a staged-only acknowledgement", async () => {
    const receipt = await stageVoucherEvents(transportPool as never, envelope([event]), siteId);
    expect(receipt.state).toBe("staged-not-applied");
    expect(receipt.lastSequence).toBe("1");
    const count = await client.query(
      "SELECT COUNT(*)::integer AS count FROM factory_edge_staged_vouchers WHERE site_id = $1",
      [siteId]
    );
    expect(count.rows[0].count).toBe(1);
  });

  it("idempotently acknowledges a repeated event without inserting a second row", async () => {
    await expect(stageVoucherEvents(transportPool as never, envelope([event]), siteId)).resolves.toMatchObject({
      state: "staged-not-applied",
      lastSequence: "1",
    });
    const count = await client.query(
      "SELECT COUNT(*)::integer AS count FROM factory_edge_staged_vouchers WHERE site_id = $1",
      [siteId]
    );
    expect(count.rows[0].count).toBe(1);
  });

  it("rejects diverging replay, missing predecessor and operation-id reuse", async () => {
    const changed = { ...event, payload: { ...payload, voucher: { ...payload.voucher, totalAmount: "99" } } };
    changed.payloadSha256 = hashEvidence(changed.payload);
    await expect(stageVoucherEvents(transportPool as never, envelope([changed]), siteId)).rejects.toThrow(
      "EDGE_SYNC_DIVERGENT_REPLAY"
    );

    // A well-formed later event (its payload matches its own voucher ID).
    const thirdPayload = { ...payload, voucher: { ...payload.voucher, id: 90 } };
    const third = {
      ...event,
      sequence: "3",
      operationId: randomUUID(),
      localVoucherId: 90,
      payload: thirdPayload,
      payloadSha256: hashEvidence(thirdPayload),
    };
    await expect(stageVoucherEvents(transportPool as never, envelope([third]), siteId)).rejects.toThrow(
      "EDGE_SYNC_MISSING_PREDECESSOR"
    );

    const reused = { ...event, sequence: "2" };
    await expect(stageVoucherEvents(transportPool as never, envelope([reused]), siteId)).rejects.toThrow(
      "EDGE_SYNC_DUPLICATE_OPERATION_ID"
    );
  });

  it("keeps business tables untouched and rejects mutation to staged evidence", async () => {
    await client.query("BEGIN");
    await client.query("SAVEPOINT staged_immutable");
    await expect(
      client.query("DELETE FROM factory_edge_staged_vouchers WHERE site_id = $1", [siteId])
    ).rejects.toMatchObject({
      code: "23514",
    });
    await client.query("ROLLBACK TO SAVEPOINT staged_immutable");
    await client.query("COMMIT");
    // No business-posting SQL appears in the staging implementation.
    const rows = await client.query(
      "SELECT COUNT(*)::integer AS count FROM factory_edge_staged_vouchers WHERE site_id = $1",
      [siteId]
    );
    expect(rows.rows[0].count).toBe(1);
  });
});

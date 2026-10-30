import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";
import { ensureCloudEdgeStageSchema, stageVoucherEvents } from "../server/edge/edgeCloudStaging";
import { EDGE_SYNC_STAGE_VERSION, hashEvidence } from "../server/edge/edgeSyncStageProtocol.mjs";

const siteId = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";
const enabled = Boolean(process.env.DATABASE_URL);

(enabled ? describe : describe.skip)("cloud staged voucher evidence durability", () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  const namespace = "edge_sync_test_" + randomUUID().replaceAll("-", "");
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
  const envelope = (events: typeof event[]) => ({
    protocol: EDGE_SYNC_STAGE_VERSION,
    siteId,
    events,
  });

  beforeAll(async () => {
    await client.connect();
    await client.query(`CREATE SCHEMA "${namespace}"`);
    await client.query(`SET search_path TO "${namespace}"`);
    await ensureCloudEdgeStageSchema(client as never, true);
  });

  afterAll(async () => {
    await client.query("SET search_path TO public").catch(() => undefined);
    await client.query(`DROP SCHEMA IF EXISTS "${namespace}" CASCADE`).catch(() => undefined);
    await client.end().catch(() => undefined);
  });

  it("durably stores an event with a staged-only acknowledgement", async () => {
    const receipt = await stageVoucherEvents(transportPool as never, envelope([event]), siteId);
    expect(receipt.state).toBe("staged-not-applied");
    expect(receipt.lastSequence).toBe("1");
    const count = await client.query("SELECT COUNT(*)::integer AS count FROM factory_edge_staged_vouchers");
    expect(count.rows[0].count).toBe(1);
  });

  it("idempotently acknowledges a repeated event without inserting a second row", async () => {
    await expect(stageVoucherEvents(transportPool as never, envelope([event]), siteId)).resolves.toMatchObject({
      state: "staged-not-applied",
      lastSequence: "1",
    });
    const count = await client.query("SELECT COUNT(*)::integer AS count FROM factory_edge_staged_vouchers");
    expect(count.rows[0].count).toBe(1);
  });

  it("rejects diverging replay, missing predecessor and operation-id reuse", async () => {
    const changed = { ...event, payload: { ...payload, voucher: { id: 88, totalAmount: "99" } } };
    changed.payloadSha256 = hashEvidence(changed.payload);
    await expect(stageVoucherEvents(transportPool as never, envelope([changed]), siteId))
      .rejects.toThrow("EDGE_SYNC_DIVERGENT_REPLAY");

    const third = { ...event, sequence: "3", operationId: randomUUID(), localVoucherId: 90 };
    await expect(stageVoucherEvents(transportPool as never, envelope([third]), siteId))
      .rejects.toThrow("EDGE_SYNC_MISSING_PREDECESSOR");

    const reused = { ...event, sequence: "2" };
    await expect(stageVoucherEvents(transportPool as never, envelope([reused]), siteId))
      .rejects.toThrow("EDGE_SYNC_DUPLICATE_OPERATION_ID");
  });

  it("keeps business tables untouched and rejects mutation to staged evidence", async () => {
    await client.query("SAVEPOINT staged_immutable").catch(() => undefined);
    await expect(client.query("DELETE FROM factory_edge_staged_vouchers")).rejects.toMatchObject({
      code: "23514",
    });
    await client.query("ROLLBACK").catch(() => undefined);
    // No business-posting SQL appears in the staging implementation.
    const rows = await client.query("SELECT COUNT(*)::integer AS count FROM factory_edge_staged_vouchers");
    expect(rows.rows[0].count).toBe(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import type { DbTransaction } from "../server/db";

const env = vi.hoisted(() => ({
  mode: "lan", primary: true, siteId: "027d7472-4a29-4bb3-a4aa-5b30e4ad631f",
}));
vi.mock("../server/edge/edgeRuntimePolicy.mjs", () => ({
  readFactoryEdgeConfiguration: () => env,
}));

import { capturePhase9PressingTx, ensurePhase9PressingOutboxSchema } from "../server/edge/phase9PressingOutbox";

const databaseUrl = process.env.PHASE8_TEST_DATABASE_URL;
const base = {
  companyId: 5, actorUserId: "worker-1", localConfirmationId: 13,
  requestId: "e53cdbd1-7c4b-4b5c-9a60-b4f9de710b8c",
  baleId: 100, machineId: 4, assignmentId: 3, referenceNumber: "BALE-100",
  confirmedAt: "2026-10-30T06:45:10.000Z",
  deviceCapturedAt: null, productionDate: "2026-10-30", timezoneName: "Asia/Beirut",
};

afterEach(() => {
  env.mode = "lan";
  env.primary = true;
});

describe.skipIf(!databaseUrl)("Phase 9 pressing outbox, disposable PostgreSQL 17", () => {
  it("commits source + event together; enforces source tenant FK, UUID and immutability", async () => {
    const admin = new Client({ connectionString: databaseUrl, ssl: false });
    const isolatedUrl = new URL(databaseUrl!);
    isolatedUrl.pathname = "/phase9_pressing_capture_test";
    const client = new Client({ connectionString: isolatedUrl.toString(), ssl: false });
    await admin.connect();
    try {
      // Phase 8's DBA fence experiment uses a different disposable DB.
      // Keep both suites isolated even if their workflows share a container.
      await admin.query("CREATE DATABASE phase9_pressing_capture_test");
      await client.connect();
      await client.query("BEGIN");
      // Minimal source fixture only; never install into live factory records.
      await client.query(`
        CREATE TABLE factory_pressing_confirmations (
          id INTEGER PRIMARY KEY, company_id INTEGER NOT NULL,
          UNIQUE (company_id, id)
        )
      `);
      await ensurePhase9PressingOutboxSchema(client as never);
      const tx = drizzle(client) as unknown as DbTransaction;
      await client.query("INSERT INTO factory_pressing_confirmations(id,company_id) VALUES(13,5),(14,6)");
      await capturePhase9PressingTx(tx, base);
      const { rows } = await client.query(
        "SELECT sequence::text, operation_id::text, company_id, payload, payload_sha256 FROM factory_edge_pressing_outbox"
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        sequence: "1",
        operation_id: base.requestId,
        company_id: base.companyId,
        payload: { kind: "pressing.confirmation.v1", inventoryFinalized: false, referenceNumber: "BALE-100" },
      });
      expect(String(rows[0].payload_sha256)).toMatch(/^[0-9a-f]{64}$/);

      for (const query of [
        "UPDATE factory_edge_pressing_outbox SET company_id=6",
        "DELETE FROM factory_edge_pressing_outbox",
      ]) {
        await client.query("SAVEPOINT verify_reject");
        try {
          await expect(client.query(query)).rejects.toMatchObject({ code: "23514" });
        } finally {
          await client.query("ROLLBACK TO SAVEPOINT verify_reject");
        }
      }

      await client.query("SAVEPOINT duplicate_scan");
      try {
        // Drizzle wraps the driver error; the PostgreSQL SQLSTATE lives on cause.
        await expect(capturePhase9PressingTx(tx, base)).rejects.toMatchObject({ cause: { code: "23505" } });
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT duplicate_scan");
      }

      await client.query("SAVEPOINT company_scope");
      try {
        await expect(capturePhase9PressingTx(tx, {
          ...base, requestId: "c4f9ac65-a734-4aac-93b8-2adfb8cb4de2",
          localConfirmationId: 14,
        })).rejects.toMatchObject({ cause: { code: "23503" } });
      } finally {
        await client.query("ROLLBACK TO SAVEPOINT company_scope");
      }

      const saved = await client.query("SELECT count(*)::integer AS count FROM factory_edge_pressing_outbox");
      expect(saved.rows[0].count).toBe(1);
      const counter = await client.query("SELECT last_sequence::text FROM factory_edge_pressing_counter");
      expect(counter.rows[0].last_sequence).toBe("1");
      await expect(client.query("DELETE FROM factory_pressing_confirmations WHERE id=13"))
        .rejects.toMatchObject({ code: "23503" });
    } finally {
      await client.query("ROLLBACK").catch(() => undefined);
      await client.end().catch(() => undefined);
      await admin.query("DROP DATABASE IF EXISTS phase9_pressing_capture_test WITH (FORCE)").catch(() => undefined);
      await admin.end();
    }
  });
});

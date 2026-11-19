import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db } from "../server/db";
import {
  claimVoucherPathRequest,
  completeVoucherPathRequest,
  voucherPathRequestFingerprint,
} from "../server/services/accounting/voucherPathTransitionBoundary";

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;
const companyA = 1_900_000_001;
const companyB = 1_900_000_002;
const keys = new Set<string>();

async function cleanup(): Promise<void> {
  if (keys.size === 0) return;
  await db.execute(sql`
    DELETE FROM voucher_path_request_guards
    WHERE company_id IN (${companyA}, ${companyB})
  `);
}

function testKey(label: string): string {
  const key = `phase8:${label}:${randomUUID()}`;
  keys.add(key);
  return key;
}

describePostgres("voucher path request boundary PostgreSQL regression", () => {
  beforeAll(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("serializes two concurrent identical requests and replays one durable result", async () => {
    const key = testKey("concurrent");
    const path = "/api/credit-notes";
    const fingerprint = voucherPathRequestFingerprint("POST", path, {
      amount: "125.00",
      accountId: 8,
    });

    const first = await claimVoucherPathRequest(companyA, key, "operational", path, fingerprint);
    expect(first).toEqual({ kind: "owner" });

    const concurrent = claimVoucherPathRequest(companyA, key, "operational", path, fingerprint);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await completeVoucherPathRequest(companyA, key, 201, { voucherId: 8842 }, false);

    await expect(concurrent).resolves.toEqual({
      kind: "replay",
      status: 201,
      body: { voucherId: 8842 },
    });

    await expect(claimVoucherPathRequest(companyA, key, "operational", path, fingerprint)).resolves.toEqual({
      kind: "replay",
      status: 201,
      body: { voucherId: 8842 },
    });
  });

  it("rejects changed financial data under a reused request identity", async () => {
    const key = testKey("conflict");
    const path = "/api/factory/raw-stock/offload";
    const original = voucherPathRequestFingerprint("POST", path, { containerId: 44, receivedKg: "500" });
    const changed = voucherPathRequestFingerprint("POST", path, { containerId: 44, receivedKg: "550" });

    await expect(claimVoucherPathRequest(companyA, key, "operational", path, original)).resolves.toEqual({
      kind: "owner",
    });
    await expect(claimVoucherPathRequest(companyA, key, "operational", path, changed)).resolves.toEqual({
      kind: "conflict",
    });
  });

  it("allows the same identity value independently in two companies", async () => {
    const key = testKey("company-scope");
    const path = "/api/sp/sales";
    const fingerprint = voucherPathRequestFingerprint("POST", path, { amount: "80.00" });

    await expect(claimVoucherPathRequest(companyA, key, "operational", path, fingerprint)).resolves.toEqual({
      kind: "owner",
    });
    await expect(claimVoucherPathRequest(companyB, key, "operational", path, fingerprint)).resolves.toEqual({
      kind: "owner",
    });
  });

  it("persists deterministic import completion so a later rerun after process-style separation replays", async () => {
    const key = testKey("import-rerun");
    const path = "/api/pos-import/import";
    const fingerprint = voucherPathRequestFingerprint("POST", path, {
      importBatchId: "phase8-db-batch",
      locationId: 3,
      items: [{ barcode: "SKU-1", quantity: 2, rate: 10 }],
    });

    await expect(claimVoucherPathRequest(companyA, key, "deterministic-source", path, fingerprint)).resolves.toEqual({
      kind: "owner",
    });
    await completeVoucherPathRequest(companyA, key, 200, { imported: 1, voucherCount: 1 }, true);

    // A later call reads the persisted row; no in-memory ownership token is used.
    await expect(claimVoucherPathRequest(companyA, key, "deterministic-source", path, fingerprint)).resolves.toEqual({
      kind: "replay",
      status: 200,
      body: { imported: 1, voucherCount: 1 },
    });
  });

  it("fails closed after an uncertain server outcome instead of reopening the writer", async () => {
    const key = testKey("uncertain");
    const path = "/api/stock-transfer-import/import";
    const fingerprint = voucherPathRequestFingerprint("POST", path, {
      sourceRunId: "phase8-uncertain-run",
      items: [{ barcode: "SKU-X", quantity: 1 }],
    });

    await expect(claimVoucherPathRequest(companyA, key, "deterministic-source", path, fingerprint)).resolves.toEqual({
      kind: "owner",
    });
    await completeVoucherPathRequest(companyA, key, 500, { error: "response lost" }, true);

    const started = Date.now();
    const replay = await claimVoucherPathRequest(companyA, key, "deterministic-source", path, fingerprint);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4_000);
    expect(replay).toEqual({ kind: "uncertain" });
  }, 10_000);
});

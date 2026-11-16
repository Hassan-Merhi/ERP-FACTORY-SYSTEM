import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { db, pool } from "../server/db";
import {
  financialOperationFingerprint,
  reserveFinancialOperationTx,
  withDurableFinancialOperation,
} from "../server/services/accounting/durableFinancialOperation";

const describePostgres = process.env.DATABASE_URL ? describe : describe.skip;

let companyId: number;
const keys: string[] = [];

function testKey(label: string): string {
  const key = `phase2/${label}/${randomUUID()}`;
  keys.push(key);
  return key;
}

async function cleanup(): Promise<void> {
  if (!companyId || keys.length === 0) return;
  await db.execute(sql`
    DELETE FROM financial_operation_requests
    WHERE company_id = ${companyId}
      AND idempotency_key IN (${sql.join(
        keys.map((key) => sql`${key}`),
        sql`, `
      )})
  `);
}

describePostgres("durable financial operation PostgreSQL boundary", () => {
  beforeAll(async () => {
    const result = await db.execute(sql`SELECT id FROM companies ORDER BY id LIMIT 1`);
    companyId = Number((result.rows[0] as { id?: number } | undefined)?.id);
    if (!Number.isInteger(companyId) || companyId <= 0) {
      throw new Error("The PostgreSQL test database needs at least one company");
    }
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
  });

  it("serializes concurrent identical transactions and commits one result", async () => {
    const key = testKey("concurrent");
    const input = {
      companyId,
      operationName: "test.concurrent-posting",
      idempotencyKey: key,
      requestFingerprint: financialOperationFingerprint({ amount: "125.00", accountId: 8 }),
    };
    let executions = 0;

    const [first, second] = await Promise.all([
      withDurableFinancialOperation(input, async (tx) => {
        executions += 1;
        await new Promise((resolve) => setTimeout(resolve, 100));
        const row = await tx.execute(sql`SELECT 8842 AS id`);
        return { value: { voucherId: Number(row.rows[0]?.id) }, resultReference: "8842", resultStatus: 201 };
      }),
      withDurableFinancialOperation(input, async (tx) => {
        executions += 1;
        const row = await tx.execute(sql`SELECT 8842 AS id`);
        return { value: { voucherId: Number(row.rows[0]?.id) }, resultReference: "8842", resultStatus: 201 };
      }),
    ]);

    expect(executions).toBe(1);
    expect([first, second].filter((result) => result.replayed)).toHaveLength(1);
    expect(first.value).toEqual({ voucherId: 8842 });
    expect(second.value).toEqual({ voucherId: 8842 });
  });

  it("rejects a changed payload under the same company, operation, and key", async () => {
    const key = testKey("conflict");
    const base = {
      companyId,
      operationName: "test.conflict",
      idempotencyKey: key,
      requestFingerprint: financialOperationFingerprint({ amount: "80.00" }),
    };
    await withDurableFinancialOperation(base, async () => ({ value: { voucherId: 9001 } }));

    await expect(
      withDurableFinancialOperation(
        { ...base, requestFingerprint: financialOperationFingerprint({ amount: "81.00" }) },
        async () => ({ value: { voucherId: 9002 } })
      )
    ).rejects.toMatchObject({ code: "FINANCIAL_OPERATION_IDEMPOTENCY_CONFLICT" });
  });

  it("rolls back the reservation with the business transaction after a failure", async () => {
    const key = testKey("rollback");
    const input = {
      companyId,
      operationName: "test.rollback",
      idempotencyKey: key,
      requestFingerprint: financialOperationFingerprint({ amount: "50.00" }),
    };

    await expect(
      withDurableFinancialOperation(input, async () => {
        throw new Error("simulated posting failure");
      })
    ).rejects.toThrow("simulated posting failure");

    const retry = await withDurableFinancialOperation(input, async () => ({
      value: { voucherId: 9010 },
      resultReference: "9010",
    }));
    expect(retry.replayed).toBe(false);
    expect(retry.value).toEqual({ voucherId: 9010 });
  });

  it("fails closed when an existing processing marker has an uncertain outcome", async () => {
    const key = testKey("uncertain");
    const input = {
      companyId,
      operationName: "test.uncertain",
      idempotencyKey: key,
      requestFingerprint: financialOperationFingerprint({ amount: "60.00" }),
    };

    await db.execute(sql`
      INSERT INTO financial_operation_requests
        (company_id, operation_name, idempotency_key, request_fingerprint, state)
      VALUES
        (${companyId}, ${input.operationName}, ${key}, ${input.requestFingerprint}, 'processing')
    `);

    await expect(db.transaction(async (tx) => reserveFinancialOperationTx(tx, input))).resolves.toMatchObject({
      kind: "uncertain",
    });
  });
});

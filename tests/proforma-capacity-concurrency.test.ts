import { describe, expect, it } from "vitest";
import { db } from "../server/db";
import { acquireProformaCapacityTransactionLock } from "../server/routes/factory/customer-orders/proformaCapacityConcurrency";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("proforma capacity transaction lock", () => {
  it("rejects keys that cannot be represented by PostgreSQL's two-int advisory lock", async () => {
    await expect(
      acquireProformaCapacityTransactionLock(db, { companyId: Number.MAX_SAFE_INTEGER, proformaId: 71 })
    ).rejects.toThrow("companyId must be a signed 32-bit integer");
  });

  it("serializes two transactions for the same company/proforma and releases on commit", async () => {
    const firstAcquired = deferred();
    const releaseFirst = deferred();
    let secondAcquired = false;

    const first = db.transaction(async (tx) => {
      await acquireProformaCapacityTransactionLock(tx, { companyId: 2147483000, proformaId: 2147483001 });
      firstAcquired.resolve();
      await releaseFirst.promise;
    });

    await firstAcquired.promise;

    const second = db.transaction(async (tx) => {
      await acquireProformaCapacityTransactionLock(tx, { companyId: 2147483000, proformaId: 2147483001 });
      secondAcquired = true;
    });

    await delay(125);
    expect(secondAcquired).toBe(false);

    releaseFirst.resolve();
    await Promise.all([first, second]);
    expect(secondAcquired).toBe(true);
  });

  it("does not block an unrelated proforma lock", async () => {
    const firstAcquired = deferred();
    const releaseFirst = deferred();
    const secondAcquired = deferred();

    const first = db.transaction(async (tx) => {
      await acquireProformaCapacityTransactionLock(tx, { companyId: 2147483000, proformaId: 2147483002 });
      firstAcquired.resolve();
      await releaseFirst.promise;
    });

    await firstAcquired.promise;

    const second = db.transaction(async (tx) => {
      await acquireProformaCapacityTransactionLock(tx, { companyId: 2147483000, proformaId: 2147483003 });
      secondAcquired.resolve();
    });

    await Promise.race([
      secondAcquired.promise,
      delay(500).then(() => {
        throw new Error("unrelated proforma lock was unexpectedly blocked");
      }),
    ]);

    releaseFirst.resolve();
    await Promise.all([first, second]);
  });
});

// @vitest-environment node
/**
 * Standalone browser offline mode (Phases 13–14): the laptop's encrypted queue
 * and its delivery to the cloud.
 *
 * Queue: only vetted writes, sealed with the user's device key, isolated per
 * company and user, a double click saved once, edits only while the cloud
 * certainly has no receipt.
 * Delivery: synced only on a matching receipt; per-stream order; conflicts,
 * refusals, waiting, expired sessions, dropped connections and retries.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  ops: new Map<string, any>(),
  keys: new Map<string, any>(),
  local: new Map<string, string>(),
}));

vi.mock("../../client/src/lib/db", () => {
  const table = (map: Map<string, any>) => ({
    get: async (key: string) => (map.has(key) ? { ...map.get(key) } : undefined),
    put: async (row: any) => {
      map.set(row.id, { ...row });
    },
    add: async (row: any) => {
      if (map.has(row.id)) throw new Error("ConstraintError");
      map.set(row.id, { ...row });
    },
    bulkDelete: async (keys: string[]) => {
      for (const key of keys) map.delete(key);
    },
    where: () => ({
      equals: ([companyId, userId]: [number, string]) => ({
        toArray: async () =>
          [...map.values()]
            .filter((row) => row.companyId === companyId && row.userId === userId)
            .map((row) => ({ ...row })),
      }),
    }),
  });
  return {
    db: {
      transaction: async (...args: any[]) => (args[args.length - 1] as () => Promise<unknown>)(),
      browserOperations: table(store.ops),
      browserDeviceKeys: table(store.keys),
    },
  };
});

vi.stubGlobal("localStorage", {
  getItem: (key: string) => store.local.get(key) ?? null,
  setItem: (key: string, value: string) => store.local.set(key, value),
  removeItem: (key: string) => store.local.delete(key),
});
vi.stubGlobal("window", { dispatchEvent: () => true });
vi.stubGlobal(
  "CustomEvent",
  class {
    constructor(public type: string) {}
  }
);

const actor = { companyId: 7, userId: "u-1" };
const otherUser = { companyId: 7, userId: "u-2" };
const adjust = { stockItemId: 5, locationId: 3, quantity: "4", type: "add" };

async function outbox() {
  return import("../../client/src/lib/offline/browserOutbox");
}
async function sync() {
  return import("../../client/src/lib/offline/browserSync");
}

type Reply = { status: number; body?: unknown } | Error;

/** A fake cloud: the session is `actor` unless told otherwise; operation replies are queued. */
function cloud(replies: Reply[], session = actor) {
  const sent: any[] = [];
  const transport = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === "/api/auth/me") return new Response(JSON.stringify({ id: session.userId }), { status: 200 });
    if (url === "/api/auth/session-company")
      return new Response(JSON.stringify({ companyId: session.companyId }), { status: 200 });
    if (url === "/api/csrf-token") return new Response(JSON.stringify({ csrfToken: "t" }), { status: 200 });
    sent.push(JSON.parse(String(init?.body)));
    const reply = replies.shift() ?? { status: 500 };
    if (reply instanceof Error) throw reply;
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
  });
  return { transport: transport as unknown as typeof fetch, sent };
}

function receipt(op: any, extra: Record<string, unknown> = {}) {
  return { status: 200, body: { operationId: op.id, kind: op.kind, outcome: "cloud-applied", cloudRef: 91, ...extra } };
}

beforeEach(() => {
  store.ops.clear();
  store.keys.clear();
  store.local.clear();
  vi.resetModules();
});

describe("Browser offline queue", () => {
  it("saves a vetted write sealed with the user's device key, with only a short label readable", async () => {
    const box = await outbox();
    const { record, duplicate } = await box.saveBrowserOperation(actor, "voucher.payment-receipt.v1", {
      voucherType: "Payment",
      voucherDate: "2026-11-09",
      paymentAccountType: "supplier",
      paymentAccountId: 4,
      entries: [{ accountType: "bank", accountId: 2, amount: "40" }],
      notes: "CONFIDENTIAL supplier note",
    });
    expect(duplicate).toBe(false);
    expect(record).toMatchObject({
      companyId: 7,
      userId: "u-1",
      state: "saved",
      stream: "payments",
      label: "Payment 40",
    });
    expect(record.localRef).toBeGreaterThan(1_000_000_000);
    expect(JSON.stringify(store.ops.get(record.id))).not.toContain("CONFIDENTIAL");
    expect(await box.openBrowserOperation(actor, record)).toMatchObject({ notes: "CONFIDENTIAL supplier note" });
    expect(box.browserOperationStatus(record.state)).toBe("saved-locally");
  });

  it("refuses unsupported writes and credentials", async () => {
    const box = await outbox();
    await expect(box.saveBrowserOperation(actor, "factory.payroll.v1", {})).rejects.toThrow(
      "OFFLINE_WRITE_NOT_SUPPORTED"
    );
    await expect(
      box.saveBrowserOperation(actor, "stock.quick-adjust.v1", { ...adjust, managerPassword: "x" })
    ).rejects.toThrow("OFFLINE_UNSAFE_PAYLOAD");
  });

  it("keeps each user's records apart, and gives each its own device id and local references", async () => {
    const box = await outbox();
    const mine = (await box.saveBrowserOperation(actor, "stock.quick-adjust.v1", adjust)).record;
    const theirs = (await box.saveBrowserOperation(otherUser, "stock.quick-adjust.v1", adjust)).record;
    expect((await box.listBrowserOperations(actor)).map((row) => row.id)).toEqual([mine.id]);
    expect(mine.deviceId).not.toBe(theirs.deviceId);
    await expect(box.openBrowserOperation(otherUser, mine)).rejects.toThrow("OFFLINE_RECORD_NOT_YOURS");
  });

  it("saves a double click once", async () => {
    const box = await outbox();
    const first = await box.saveBrowserOperation(actor, "stock.quick-adjust.v1", adjust, 1_000);
    const second = await box.saveBrowserOperation(actor, "stock.quick-adjust.v1", adjust, 5_000);
    expect(second).toMatchObject({ duplicate: true, record: { id: first.record.id } });
    const later = await box.saveBrowserOperation(actor, "stock.quick-adjust.v1", adjust, 1_000 + 3 * 60 * 1000);
    expect(later.duplicate).toBe(false);
  });

  it("lets a record be edited until it may have reached the cloud", async () => {
    const box = await outbox();
    const { record } = await box.saveBrowserOperation(actor, "stock.quick-adjust.v1", adjust);
    const edited = await box.editBrowserOperation(actor, record.id, { ...adjust, quantity: "6" });
    expect(edited.id).toBe(record.id);
    expect(edited.localRef).toBe(record.localRef);
    expect(await box.openBrowserOperation(actor, edited)).toMatchObject({ quantity: "6" });
    await box.updateBrowserOperation(actor, record.id, { state: "pending", attempts: 1 });
    await expect(box.editBrowserOperation(actor, record.id, adjust)).rejects.toThrow("OFFLINE_RECORD_ALREADY_SENT");
  });
});

describe("Browser offline delivery", () => {
  it("marks a record synced only on a receipt naming this operation, and sends the session's records only", async () => {
    const box = await outbox();
    const { record } = await box.saveBrowserOperation(actor, "stock.quick-adjust.v1", adjust);
    await box.saveBrowserOperation(otherUser, "stock.quick-adjust.v1", adjust);
    const fake = cloud([receipt(record)]);
    const summary = await (await sync()).syncBrowserOperations(fake.transport);
    expect(summary).toMatchObject({ synced: 1, stopped: null });
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({
      operationId: record.id,
      deviceId: record.deviceId,
      localRef: record.localRef,
    });
    expect(await box.getBrowserOperation(actor, record.id)).toMatchObject({ state: "synced", cloudRef: 91 });
  });

  it("never treats an unrelated 2xx as proof", async () => {
    const box = await outbox();
    const { record } = await box.saveBrowserOperation(actor, "stock.quick-adjust.v1", adjust);
    const fake = cloud([{ status: 200, body: { ok: true } }]);
    await (await sync()).syncBrowserOperations(fake.transport);
    expect(await box.getBrowserOperation(actor, record.id)).toMatchObject({
      state: "needs_review",
      lastError: "OFFLINE_RECEIPT_UNVERIFIED",
    });
  });

  it("holds a conflict, keeps later records of that stream back, and lets other streams through", async () => {
    const box = await outbox();
    const first = (await box.saveBrowserOperation(actor, "stock.quick-adjust.v1", adjust, 1)).record;
    const second = (await box.saveBrowserOperation(actor, "stock.quick-adjust.v1", { ...adjust, quantity: "9" }, 2))
      .record;
    const sale = (
      await box.saveBrowserOperation(
        actor,
        "pos.sale.v1",
        { locationId: 3, cashAccountId: 8, items: [{ stockItemId: 5, quantity: 1, rate: 2 }] },
        3
      )
    ).record;
    const fake = cloud([
      { status: 409, body: { code: "PHASE9_STOCK_WOULD_GO_NEGATIVE", overridable: true } },
      receipt(sale),
    ]);
    const summary = await (await sync()).syncBrowserOperations(fake.transport);
    expect(summary).toMatchObject({ conflicts: 1, synced: 1 });
    expect(fake.sent.map((body) => body.operationId)).toEqual([first.id, sale.id]);
    expect(await box.getBrowserOperation(actor, first.id)).toMatchObject({
      state: "conflict",
      conflictCode: "PHASE9_STOCK_WOULD_GO_NEGATIVE",
      conflictOverridable: true,
    });
    expect((await box.getBrowserOperation(actor, second.id))?.state).toBe("saved");
  });

  it("sends an approved conflict with its code, and records a discard with the cloud", async () => {
    const box = await outbox();
    const held = (await box.saveBrowserOperation(actor, "stock.quick-adjust.v1", adjust)).record;
    await box.updateBrowserOperation(actor, held.id, {
      state: "conflict",
      attempts: 1,
      conflictCode: "PHASE9_STOCK_WOULD_GO_NEGATIVE",
      conflictOverridable: true,
    });
    const engine = await sync();
    await engine.approveBrowserOperation(actor, held.id);
    const fake = cloud([receipt(held)]);
    await engine.syncBrowserOperations(fake.transport);
    expect(fake.sent[0].override).toBe("PHASE9_STOCK_WOULD_GO_NEGATIVE");

    const other = (await box.saveBrowserOperation(actor, "stock.quick-adjust.v1", { ...adjust, quantity: "2" })).record;
    await box.updateBrowserOperation(actor, other.id, { state: "rejected", attempts: 1 });
    const discard = cloud([
      { status: 200, body: { operationId: other.id, outcome: "rejected-conflict", cloudRef: null } },
    ]);
    expect(await engine.discardBrowserOperation(actor, other.id, discard.transport)).toBe("discarded");
    expect((await box.getBrowserOperation(actor, other.id))?.state).toBe("discarded");
  });

  it("waits for an earlier record, retries server failures with backoff, and stops on a dropped connection or expired session", async () => {
    const box = await outbox();
    const { record } = await box.saveBrowserOperation(actor, "stock.quick-adjust.v1", adjust);
    const engine = await sync();

    await engine.syncBrowserOperations(
      cloud([{ status: 202, body: { code: "PHASE9_STOCK_ITEM_NOT_YET_SYNCED" } }]).transport
    );
    let row = await box.getBrowserOperation(actor, record.id);
    expect(row).toMatchObject({ state: "waiting", attempts: 1 });
    expect(row!.nextAttemptAt).toBeGreaterThan(Date.now());

    await box.updateBrowserOperation(actor, record.id, { nextAttemptAt: 0 });
    expect((await engine.syncBrowserOperations(cloud([new TypeError("Failed to fetch")]).transport)).stopped).toBe(
      "offline"
    );
    row = await box.getBrowserOperation(actor, record.id);
    expect(row).toMatchObject({ state: "pending", attempts: 2, lastError: "OFFLINE_CONNECTION_LOST" });

    await box.updateBrowserOperation(actor, record.id, { nextAttemptAt: 0 });
    expect((await engine.syncBrowserOperations(cloud([{ status: 401 }]).transport)).stopped).toBe("signed-out");
    expect((await box.getBrowserOperation(actor, record.id))?.lastError).toBe("OFFLINE_SIGN_IN_REQUIRED");
  });

  it("does not send while paused, or when another user is signed in", async () => {
    const box = await outbox();
    await box.saveBrowserOperation(actor, "stock.quick-adjust.v1", adjust);
    const engine = await sync();
    engine.setBrowserSyncPaused(actor, true);
    const paused = cloud([]);
    expect((await engine.syncBrowserOperations(paused.transport)).stopped).toBe("paused");
    expect(paused.sent).toHaveLength(0);
    engine.setBrowserSyncPaused(actor, false);
    const someoneElse = cloud([], otherUser);
    expect((await engine.syncBrowserOperations(someoneElse.transport)).synced).toBe(0);
    expect(someoneElse.sent).toHaveLength(0);
  });
});

describe("Capture when offline", () => {
  it("saves a supported write as OfflineQueued and refuses an unsupported one with its reason", async () => {
    const { captureOfflineWrite } = await import("../../client/src/lib/offline/browserCapture");
    await expect(captureOfflineWrite(actor, "POST", "/api/inventory/quick-adjust", adjust)).rejects.toMatchObject({
      name: "OfflineQueued",
      message: "OFFLINE_SAVED_ON_DEVICE",
    });
    await expect(captureOfflineWrite(actor, "PUT", "/api/vouchers/12", {})).rejects.toMatchObject({
      name: "OfflineUnavailable",
    });
    await expect(captureOfflineWrite(actor, "POST", "/api/factory/pressing-machines/confirm", {})).rejects.toThrow(
      /pressing scan/
    );
    await expect(captureOfflineWrite(null, "POST", "/api/inventory/quick-adjust", adjust)).rejects.toThrow(
      "OFFLINE_ACTOR_NOT_PREPARED"
    );
  });
});

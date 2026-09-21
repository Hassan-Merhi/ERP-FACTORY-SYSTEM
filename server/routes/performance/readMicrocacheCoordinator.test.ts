import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("../../db", () => ({
  pool: {
    connect: mocks.connect,
    query: mocks.query,
  },
}));

vi.mock("../../lib/logger", () => ({
  logger: {
    info: mocks.info,
    warn: mocks.warn,
  },
}));

import { startReadMicrocacheCoordinator } from "./readMicrocacheCoordinator";

const CHANNEL = "erp_read_microcache_invalidate";

function makeClient() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  return {
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    removeAllListeners: vi.fn((event: string) => {
      listeners.delete(event);
    }),
    release: vi.fn(),
    query: vi.fn(async () => ({ rows: [] })),
    emit(event: string, ...args: unknown[]) {
      listeners.get(event)?.(...args);
    },
  };
}

describe("read microcache coordinator", () => {
  beforeEach(() => {
    process.env.RENDER_INSTANCE_ID = "instance-a";
    mocks.connect.mockReset();
    mocks.query.mockReset();
    mocks.info.mockReset();
    mocks.warn.mockReset();
  });

  afterEach(() => {
    delete process.env.RENDER_INSTANCE_ID;
  });

  it("delivers scoped invalidation metadata from another instance", async () => {
    const client = makeClient();
    mocks.connect.mockResolvedValue(client);
    const onExternalInvalidation = vi.fn();

    const coordinator = startReadMicrocacheCoordinator(onExternalInvalidation);
    await vi.waitFor(() => expect(coordinator.isReady()).toBe(true));

    client.emit("notification", {
      channel: CHANNEL,
      payload: JSON.stringify({
        version: 1,
        sourceInstanceId: "instance-b",
        invalidation: {
          companyIds: [3],
          topics: ["inventory"],
          locationIds: [7],
        },
      }),
    });

    expect(onExternalInvalidation).toHaveBeenCalledWith({
      companyIds: [3],
      topics: ["inventory"],
      locationIds: [7],
    });
  });

  it("publishes a versioned scoped payload and ignores its own echo", async () => {
    const client = makeClient();
    mocks.connect.mockResolvedValue(client);
    const onExternalInvalidation = vi.fn();

    const coordinator = startReadMicrocacheCoordinator(onExternalInvalidation);
    await vi.waitFor(() => expect(coordinator.isReady()).toBe(true));

    await coordinator.publishInvalidation({
      companyIds: [4],
      topics: ["accounting"],
    });

    expect(mocks.query).toHaveBeenCalledOnce();
    const [, params] = mocks.query.mock.calls[0] as [string, [string, string]];
    expect(params[0]).toBe(CHANNEL);
    const payload = JSON.parse(params[1]);
    expect(payload).toEqual({
      version: 1,
      sourceInstanceId: "instance-a",
      invalidation: {
        companyIds: [4],
        topics: ["accounting"],
      },
    });

    client.emit("notification", { channel: CHANNEL, payload: params[1] });
    expect(onExternalInvalidation).not.toHaveBeenCalled();
  });

  it("treats a legacy payload from an old instance as a safe blanket invalidation", async () => {
    const client = makeClient();
    mocks.connect.mockResolvedValue(client);
    const onExternalInvalidation = vi.fn();

    const coordinator = startReadMicrocacheCoordinator(onExternalInvalidation);
    await vi.waitFor(() => expect(coordinator.isReady()).toBe(true));

    client.emit("notification", { channel: CHANNEL, payload: "instance-b" });

    expect(onExternalInvalidation).toHaveBeenCalledWith();
  });
});

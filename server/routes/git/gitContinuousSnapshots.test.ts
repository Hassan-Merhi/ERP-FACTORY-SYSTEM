import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createGitContinuousSnapshot,
  GitContinuousSnapshotError,
  readGitContinuousSnapshot,
  resetGitContinuousSnapshotsForTests,
} from "./gitContinuousSnapshots";

const previousNodeEnv = process.env.NODE_ENV;
const previousSecret = process.env.CONTINUOUS_CURSOR_SECRET;
const previousTtl = process.env.GIT_CONTINUOUS_SNAPSHOT_TTL_MS;

describe("gitContinuousSnapshots", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.CONTINUOUS_CURSOR_SECRET = "tracking-wave-two-secret-1234";
    process.env.GIT_CONTINUOUS_SNAPSHOT_TTL_MS = "120000";
    resetGitContinuousSnapshotsForTests();
  });

  afterEach(() => {
    resetGitContinuousSnapshotsForTests();
    process.env.NODE_ENV = previousNodeEnv;
    if (previousSecret === undefined) delete process.env.CONTINUOUS_CURSOR_SECRET;
    else process.env.CONTINUOUS_CURSOR_SECRET = previousSecret;
    if (previousTtl === undefined) delete process.env.GIT_CONTINUOUS_SNAPSHOT_TTL_MS;
    else process.env.GIT_CONTINUOUS_SNAPSHOT_TTL_MS = previousTtl;
  });

  it("serves later chunks from the same bounded snapshot", () => {
    const first = createGitContinuousSnapshot({
      scope: "git:test-scope",
      rows: [{ id: 1 }, { id: 2 }, { id: 3 }],
      facets: { statuses: ["Sea"] },
      summary: { totalCost: 30 },
      asOf: "2026-09-10T19:00:00.000Z",
      limit: 2,
    });

    expect(first).toMatchObject({
      containers: [{ id: 1 }, { id: 2 }],
      total: 3,
      hasMore: true,
    });
    expect(first.nextCursor).toEqual(expect.any(String));

    const second = readGitContinuousSnapshot<{ id: number }, { statuses: string[] }, { totalCost: number }>({
      scope: "git:test-scope",
      cursor: first.nextCursor!,
      limit: 2,
    });

    expect(second).toEqual({
      containers: [{ id: 3 }],
      total: 3,
      facets: { statuses: ["Sea"] },
      summary: { totalCost: 30 },
      asOf: "2026-09-10T19:00:00.000Z",
      hasMore: false,
      nextCursor: null,
    });
  });

  it("fails closed when a process-local snapshot expires", () => {
    process.env.GIT_CONTINUOUS_SNAPSHOT_TTL_MS = "1";
    const first = createGitContinuousSnapshot({
      scope: "git:short-lived",
      rows: [{ id: 1 }, { id: 2 }],
      facets: {},
      summary: {},
      asOf: "2026-09-10T19:00:00.000Z",
      limit: 1,
    });

    const realNow = Date.now;
    Date.now = () => realNow() + 10;
    try {
      expect(() =>
        readGitContinuousSnapshot({
          scope: "git:short-lived",
          cursor: first.nextCursor!,
          limit: 1,
        })
      ).toThrow(GitContinuousSnapshotError);
    } finally {
      Date.now = realNow;
    }
  });
});

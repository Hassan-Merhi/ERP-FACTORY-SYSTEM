import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ContinuousCursorError,
  continuousCursorScope,
  decodeContinuousCursor,
  encodeContinuousCursor,
} from "./continuousCursor";

const previousNodeEnv = process.env.NODE_ENV;
const previousCursorSecret = process.env.CONTINUOUS_CURSOR_SECRET;
const previousSessionSecret = process.env.SESSION_SECRET;

describe("continuousCursor", () => {
  beforeEach(() => {
    process.env.NODE_ENV = "test";
    process.env.CONTINUOUS_CURSOR_SECRET = "wave-two-cursor-secret-1234";
    delete process.env.SESSION_SECRET;
  });

  afterEach(() => {
    process.env.NODE_ENV = previousNodeEnv;
    if (previousCursorSecret === undefined) delete process.env.CONTINUOUS_CURSOR_SECRET;
    else process.env.CONTINUOUS_CURSOR_SECRET = previousCursorSecret;
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
  });

  it("round-trips a typed payload inside its exact scope", () => {
    const scope = continuousCursorScope("daybook", { companyId: 4, search: "riverside" });
    const token = encodeContinuousCursor(scope, { sortDate: "2026-09-10", typeRank: 2, sortId: 99 });

    expect(decodeContinuousCursor<typeof token extends string ? { sortDate: string; typeRank: number; sortId: number } : never>(scope, token)).toEqual({
      sortDate: "2026-09-10",
      typeRank: 2,
      sortId: 99,
    });
  });

  it("rejects a cursor replayed under a different filter or tenant scope", () => {
    const firstScope = continuousCursorScope("accounts", { companyId: 1, accountId: 707 });
    const otherScope = continuousCursorScope("accounts", { companyId: 12, accountId: 707 });
    const token = encodeContinuousCursor(firstScope, { sortDate: "2026-09-10", sortId: 15, net: 20 });

    expect(() => decodeContinuousCursor(otherScope, token)).toThrow(ContinuousCursorError);
  });

  it("rejects a tampered signature", () => {
    const scope = continuousCursorScope("git", { userId: "u1", companyIds: [1] });
    const token = encodeContinuousCursor(scope, { snapshotId: "abc", offset: 50 });
    const [body, sig] = token.split(".");
    const tampered = `${body}.${sig.slice(0, -1)}${sig.endsWith("A") ? "B" : "A"}`;

    expect(() => decodeContinuousCursor(scope, tampered)).toThrow(ContinuousCursorError);
  });
});

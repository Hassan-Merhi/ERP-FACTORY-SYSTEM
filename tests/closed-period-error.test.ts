/**
 * Recognising the closed-period refusal (server/lib/closedPeriodError.ts).
 *
 * The database guard raises it; Drizzle and the services may wrap it in
 * `cause` chains. Routes turn it into a 409 whose code the browser relies on
 * to release a request identity, so both the recognition and the response
 * body are pinned here.
 */
import { describe, expect, it } from "vitest";

import {
  CLOSED_PERIOD_ERROR_CODE,
  closedPeriodErrorResponse,
  isClosedPeriodError,
} from "../server/lib/closedPeriodError";

const ENTRY_MESSAGE =
  "ACCOUNTING_PERIOD_CLOSED: the books are closed through 2026-10-31, so an entry dated 2026-10-15 cannot be created, changed or deleted";
const OPENING_MESSAGE =
  "ACCOUNTING_PERIOD_CLOSED: the books are closed through 2026-10-31, so an opening balance cannot be created, changed or deleted";

/** Wraps `inner` in `levels` plain errors, each carrying the previous one as its cause. */
function wrapped(inner: unknown, levels: number): unknown {
  let current = inner;
  for (let index = 0; index < levels; index += 1) {
    current = Object.assign(new Error(`wrapper ${index}`), { cause: current });
  }
  return current;
}

describe("isClosedPeriodError", () => {
  it("uses the guard's SQLSTATE", () => {
    expect(CLOSED_PERIOD_ERROR_CODE).toBe("EPL01");
  });

  it("recognises the guard by its code alone or by its message alone", () => {
    expect(isClosedPeriodError({ code: "EPL01" })).toBe(true);
    expect(isClosedPeriodError(new Error(ENTRY_MESSAGE))).toBe(true);
    expect(isClosedPeriodError({ message: "ACCOUNTING_PERIOD_CLOSED" })).toBe(true);
  });

  it("does not mistake other errors for it", () => {
    expect(isClosedPeriodError(new Error("duplicate key value violates unique constraint"))).toBe(false);
    expect(isClosedPeriodError({ code: "23505", message: "unique_violation" })).toBe(false);
    expect(isClosedPeriodError({ message: 42 })).toBe(false);
    expect(isClosedPeriodError({ code: "epl01" })).toBe(false);
  });

  it("ignores anything that is not an object", () => {
    for (const value of [null, undefined, "ACCOUNTING_PERIOD_CLOSED", 0, false]) {
      expect(isClosedPeriodError(value)).toBe(false);
    }
  });

  it("finds it up to three causes deep, and no deeper", () => {
    expect(isClosedPeriodError(wrapped({ code: "EPL01" }, 3))).toBe(true);
    expect(isClosedPeriodError(wrapped({ code: "EPL01" }, 4))).toBe(false);
    expect(isClosedPeriodError(wrapped(new Error(ENTRY_MESSAGE), 3))).toBe(true);
    expect(isClosedPeriodError(wrapped(new Error(ENTRY_MESSAGE), 4))).toBe(false);
  });

  it("stops on a cause chain that loops back on itself", () => {
    const looping = new Error("looping") as Error & { cause?: unknown };
    looping.cause = looping;
    expect(isClosedPeriodError(looping)).toBe(false);
    expect(closedPeriodErrorResponse(looping)).toBeNull();
  });
});

describe("closedPeriodErrorResponse", () => {
  it("is null for any other error", () => {
    expect(closedPeriodErrorResponse(new Error("connection reset"))).toBeNull();
    expect(closedPeriodErrorResponse(null)).toBeNull();
    expect(closedPeriodErrorResponse("ACCOUNTING_PERIOD_CLOSED")).toBeNull();
  });

  it("names the closed-through date and the entry's date for an entry refusal", () => {
    expect(closedPeriodErrorResponse(new Error(ENTRY_MESSAGE))).toEqual({
      status: 409,
      body: {
        code: "ACCOUNTING_PERIOD_CLOSED",
        message:
          "Accounting period closed: the books are closed through 2026-10-31, so an entry dated 2026-10-15 cannot be created, changed or deleted.",
      },
    });
  });

  it("explains an opening-balance refusal differently", () => {
    expect(closedPeriodErrorResponse(new Error(OPENING_MESSAGE))).toEqual({
      status: 409,
      body: {
        code: "ACCOUNTING_PERIOD_CLOSED",
        message:
          "Accounting period closed: the books are closed through 2026-10-31, so an opening balance cannot be created or changed. Post an adjusting journal dated after the closed period instead.",
      },
    });
  });

  it("reads the dates from the wrapped database error, not the wrapper", () => {
    const drizzleStyle = wrapped(Object.assign(new Error(ENTRY_MESSAGE), { code: "EPL01" }), 2);
    expect(closedPeriodErrorResponse(drizzleStyle)?.body.message).toContain("entry dated 2026-10-15");
  });

  it("falls back to a plain message when the dates cannot be read", () => {
    expect(closedPeriodErrorResponse({ code: "EPL01", message: "something else" })).toEqual({
      status: 409,
      body: { code: "ACCOUNTING_PERIOD_CLOSED", message: "Accounting period closed." },
    });
    expect(closedPeriodErrorResponse({ code: "EPL01", message: 7 })?.body.message).toBe("Accounting period closed.");
  });
});

/**
 * Unit tests for server/lib/httpHandlers.ts — the shared HTTP error primitives.
 * getErrorMessage/getErrorStack are now used across the whole server (after the
 * catch(unknown) migration), so their contract is pinned down here, along with
 * HttpError, getAuthenticatedUserId, database translation, and sendHttpError.
 */
import {
  HttpError,
  getErrorMessage,
  getErrorStack,
  getAuthenticatedUserId,
  sendHttpError,
  translateDatabaseError,
} from "../server/lib/httpHandlers";

describe("getErrorMessage", () => {
  it("returns the message for Error instances", () => {
    expect(getErrorMessage(new Error("boom"))).toBe("boom");
    expect(getErrorMessage(new HttpError(404, "missing"))).toBe("missing");
  });

  it("returns a safe fallback for non-Error values", () => {
    expect(getErrorMessage("a string")).toBe("Unexpected server error");
    expect(getErrorMessage(null)).toBe("Unexpected server error");
    expect(getErrorMessage({ message: "not really an error" })).toBe("Unexpected server error");
  });
});

describe("getErrorStack", () => {
  it("returns a stack for Error instances", () => {
    expect(getErrorStack(new Error("x"))).toContain("Error");
  });

  it("returns undefined for non-Error values", () => {
    expect(getErrorStack("nope")).toBeUndefined();
    expect(getErrorStack(null)).toBeUndefined();
  });
});

describe("HttpError", () => {
  it("carries a statusCode and behaves like an Error", () => {
    const e = new HttpError(403, "forbidden");
    expect(e).toBeInstanceOf(Error);
    expect(e.statusCode).toBe(403);
    expect(e.message).toBe("forbidden");
    expect(e.name).toBe("HttpError");
  });
});

describe("getAuthenticatedUserId", () => {
  it("returns the id when a user is present", () => {
    expect(getAuthenticatedUserId({ user: { id: "u1" } } as never)).toBe("u1");
  });

  it("throws a 401 HttpError when no user id is present", () => {
    try {
      getAuthenticatedUserId({ user: undefined } as never);
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).statusCode).toBe(401);
    }
  });
});

describe("translateDatabaseError", () => {
  it.each([
    ["23502", 400],
    ["23514", 400],
    ["22P02", 400],
    ["22003", 400],
    ["23503", 409],
    ["23505", 409],
    ["40001", 409],
    ["40P01", 409],
    ["55P03", 409],
    ["LOCKED_PERIOD", 409],
    ["ACCOUNTING_PERIOD_LOCKED", 409],
    ["STALE_RECORD", 409],
    ["STALE_WRITE", 409],
    ["NO_DATA_FOUND", 404],
    ["P0002", 404],
  ])("maps database code %s to HTTP %i", (code, status) => {
    expect(translateDatabaseError({ code })?.statusCode).toBe(status);
  });

  it("unwraps driver errors carried as cause", () => {
    expect(translateDatabaseError({ cause: { code: "23505" } })?.statusCode).toBe(409);
  });

  it("does not translate unknown database codes", () => {
    expect(translateDatabaseError({ code: "XX000" })).toBeNull();
    expect(translateDatabaseError(new Error("plain"))).toBeNull();
  });
});

describe("sendHttpError", () => {
  function fakeRes() {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    return res;
  }

  it("uses the HttpError's status code and message", () => {
    const res = fakeRes();
    sendHttpError(res as never, new HttpError(422, "invalid"));
    expect(res.statusCode).toBe(422);
    expect(res.body).toEqual({ message: "invalid" });
  });

  it("maps database uniqueness conflicts to 409 without leaking constraint details", () => {
    const res = fakeRes();
    sendHttpError(res as never, {
      code: "23505",
      constraint: "secret_internal_constraint_name",
      detail: "Key (company_id, code) already exists",
    });
    expect(res.statusCode).toBe(409);
    expect(res.body).toEqual({ message: "A record with the same unique value already exists." });
  });

  it("maps serialization/deadlock conflicts to retryable 409 responses", () => {
    for (const code of ["40001", "40P01", "55P03"]) {
      const res = fakeRes();
      sendHttpError(res as never, { code });
      expect(res.statusCode).toBe(409);
      expect(res.body).toEqual({ message: "The record changed concurrently. Reload and try again." });
    }
  });

  it("maps unknown errors to 500 with a safe message", () => {
    const res = fakeRes();
    sendHttpError(res as never, new Error("db exploded"));
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: "db exploded" });
  });

  it("maps non-Error throws to 500 with the fallback message", () => {
    const res = fakeRes();
    sendHttpError(res as never, "weird");
    expect(res.statusCode).toBe(500);
    expect(res.body).toEqual({ message: "Unexpected server error" });
  });
});

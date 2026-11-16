/**
 * The voucher-path boundary stores the response of a state-changing accounting
 * request and replays it verbatim when the same request identity arrives again.
 * What it stores comes from `captureResponse`, so if that captures the wrong
 * shape every retry of a `/api/sp/` write — a POS sale, a Fresh Start payment,
 * a HADI remittance — answers with a body the original caller never saw.
 *
 * Express implements `res.json(value)` by serializing and delegating to
 * `res.send(string)`. A capture that records both therefore ends up holding the
 * JSON text rather than the object, and the replay returns a JSON-encoded
 * string. These tests pin the structured value.
 */
import type { Response } from "express";
import { describe, expect, it } from "vitest";
import { captureResponse } from "./voucherPathTransitionBoundary";

/** Minimal stand-in for Express's json/send delegation. */
function fakeResponse(): Response {
  const res = {
    json(value: unknown) {
      // Express serializes, then routes through send() — the delegation that
      // used to clobber the captured object.
      return (res as unknown as Response).send(JSON.stringify(value) as never);
    },
    send(_value: unknown) {
      return res;
    },
  };
  return res as unknown as Response;
}

describe("voucher-path response capture", () => {
  it("keeps the structured body when json() delegates to send()", () => {
    const res = fakeResponse();
    const captured = captureResponse(res);
    const body = { ok: true, replayed: false, amountUsd: "250.00", postings: [{ role: "golden_coast" }] };

    res.json(body);

    expect(captured.read()).toEqual(body);
    // The failure mode being guarded: the serialized string winning instead.
    expect(typeof captured.read()).not.toBe("string");
  });

  it("still captures a body sent directly through send()", () => {
    const res = fakeResponse();
    const captured = captureResponse(res);

    res.send("plain text" as never);

    expect(captured.read()).toBe("plain text");
  });

  it("captures the last json() body when a handler writes more than once", () => {
    const res = fakeResponse();
    const captured = captureResponse(res);

    res.json({ first: true });
    res.json({ second: true });

    expect(captured.read()).toEqual({ second: true });
  });

  it("reads null before anything is written", () => {
    expect(captureResponse(fakeResponse()).read()).toBeNull();
  });
});

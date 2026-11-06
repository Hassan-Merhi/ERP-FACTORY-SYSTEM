import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { byteWindow, parseByteRange, planMediaResponse } from "./trainingMediaRange";

const h = (values: Record<string, string>) => new Headers(values);

describe("parseByteRange", () => {
  it("accepts the single-range forms Safari and Chrome send", () => {
    expect(parseByteRange("bytes=0-1")).toEqual({ header: "bytes=0-1", start: 0, end: 1 });
    expect(parseByteRange("bytes=65536-")).toEqual({ header: "bytes=65536-", start: 65536, end: undefined });
    expect(parseByteRange("bytes=-500")).toEqual({ header: "bytes=-500", suffix: 500 });
  });
  it("rejects malformed, reversed and multi-part ranges", () => {
    for (const value of [
      "bytes=-",
      "bytes=5-2",
      "bytes=0-1,4-5",
      "items=0-1",
      "bytes=-0",
      "bytes=1-" + "9".repeat(80),
    ]) {
      expect(parseByteRange(value)).toBeNull();
    }
  });
});

describe("planMediaResponse", () => {
  it("passes a correct 206 through with exact headers", () => {
    const plan = planMediaResponse(parseByteRange("bytes=0-1"), 206, h({ "content-range": "bytes 0-1/1000" }));
    expect(plan).toEqual({ status: 206, length: 2, contentRange: "bytes 0-1/1000", skip: 0, trim: false });
  });
  it("trims storage that returned more than the requested window", () => {
    const plan = planMediaResponse(parseByteRange("bytes=10-19"), 206, h({ "content-range": "bytes 10-999/1000" }));
    expect(plan).toEqual({ status: 206, length: 10, contentRange: "bytes 10-19/1000", skip: 0, trim: true });
  });
  it("turns a full 200 body into the requested 206 window", () => {
    const plan = planMediaResponse(parseByteRange("bytes=100-"), 200, h({ "content-length": "1000" }));
    expect(plan).toEqual({ status: 206, length: 900, contentRange: "bytes 100-999/1000", skip: 100, trim: false });
  });
  it("resolves suffix ranges against the total size", () => {
    const plan = planMediaResponse(parseByteRange("bytes=-100"), 206, h({ "content-range": "bytes 900-999/1000" }));
    expect(plan).toEqual({ status: 206, length: 100, contentRange: "bytes 900-999/1000", skip: 0, trim: false });
  });
  it("clamps an end past the file to the last byte", () => {
    const plan = planMediaResponse(parseByteRange("bytes=0-5000"), 206, h({ "content-range": "bytes 0-999/1000" }));
    expect(plan?.contentRange).toBe("bytes 0-999/1000");
    expect(plan?.length).toBe(1000);
  });
  it("serves a full 200 with its length when no range was asked", () => {
    expect(planMediaResponse(null, 200, h({ "content-length": "1000" }))).toEqual({
      status: 200,
      length: 1000,
      skip: 0,
      trim: false,
    });
  });
  it("refuses replies whose size or window cannot be trusted", () => {
    expect(planMediaResponse(null, 200, h({}))).toBeNull();
    expect(planMediaResponse(parseByteRange("bytes=0-1"), 206, h({}))).toBeNull();
    expect(planMediaResponse(parseByteRange("bytes=0-99"), 206, h({ "content-range": "bytes 50-99/1000" }))).toBeNull();
    expect(planMediaResponse(parseByteRange("bytes=0-99"), 206, h({ "content-range": "bytes 0-9/1000" }))).toBeNull();
  });
});

describe("byteWindow", () => {
  it("drops the leading bytes and stops after the window", async () => {
    const source = Readable.from([Buffer.from("abcdef"), Buffer.from("ghijkl")]);
    const chunks: Buffer[] = [];
    for await (const chunk of source.pipe(byteWindow(4, 5))) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe("efghi");
  });
});

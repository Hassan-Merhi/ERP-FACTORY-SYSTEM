import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { stagePhase9AttachmentFile } from "../server/edge/phase9CloudEventStore.mjs";

const SITE = "027d7472-4a29-4bb3-a4aa-5b30e4ad631f";
const BYTES = Buffer.from("phase9-verified-upload");
const HASH = createHash("sha256").update(BYTES).digest("hex");

function fakeQueryable(expectedFileSize = BYTES.byteLength) {
  return {
    query: vi.fn(async (sql: string, args: unknown[]) => {
      if (sql.includes("SELECT")) return { rows: [{ file_size: expectedFileSize }] };
      return { rows: [], rowCount: 1 };
    }),
  };
}

describe("Phase 9 attachment staging rejects tampered HTTP shapes", () => {
  it.each([
    ["array", ["not a buffer"]],
    ["object", { length: BYTES.byteLength }],
    ["number", BYTES.byteLength],
    ["null", null],
    ["string", "phase9-verified-upload"],
  ])("rejects a %s body before accessing the database", async (_name, body) => {
    const queryable = fakeQueryable();
    await expect(stagePhase9AttachmentFile(queryable as never, SITE, HASH, body as never)).rejects.toThrow(
      "PHASE9_FILE_INVALID"
    );
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it.each([
    ["array", [HASH]],
    ["object", { hash: HASH }],
    ["empty", ""],
  ])("rejects a %s digest before accessing the database", async (_name, digest) => {
    const queryable = fakeQueryable();
    await expect(stagePhase9AttachmentFile(queryable as never, SITE, digest as never, BYTES)).rejects.toThrow(
      "PHASE9_FILE_INVALID"
    );
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("rejects empty and oversized Buffers before database access", async () => {
    const queryable = fakeQueryable();
    await expect(stagePhase9AttachmentFile(queryable as never, SITE, HASH, Buffer.alloc(0))).rejects.toThrow(
      "PHASE9_FILE_INVALID"
    );
    await expect(
      stagePhase9AttachmentFile(queryable as never, SITE, HASH, Buffer.alloc(10 * 1024 * 1024 + 1))
    ).rejects.toThrow("PHASE9_FILE_INVALID");
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("rejects a mismatched hash before database access", async () => {
    const queryable = fakeQueryable();
    await expect(
      stagePhase9AttachmentFile(queryable as never, SITE, HASH, Buffer.from("different bytes"))
    ).rejects.toThrow("PHASE9_FILE_HASH_MISMATCH");
    expect(queryable.query).not.toHaveBeenCalled();
  });

  it("refuses a staged record whose declared size differs from the verified Buffer size", async () => {
    const queryable = fakeQueryable(BYTES.byteLength + 1);
    await expect(stagePhase9AttachmentFile(queryable as never, SITE, HASH, BYTES)).rejects.toThrow(
      "PHASE9_FILE_SIZE_MISMATCH"
    );
    expect(queryable.query).toHaveBeenCalledTimes(1);
  });

  it("persists the original bytes using the verified Buffer.byteLength", async () => {
    const queryable = fakeQueryable();
    await expect(stagePhase9AttachmentFile(queryable as never, SITE, HASH, BYTES)).resolves.toEqual({
      siteId: SITE,
      sha256: HASH,
      byteSize: BYTES.byteLength,
      state: "file-staged",
    });
    expect(queryable.query).toHaveBeenCalledTimes(2);
    const params = queryable.query.mock.calls[1][1];
    expect(params).toEqual([SITE, HASH, BYTES.byteLength, BYTES]);
  });
});

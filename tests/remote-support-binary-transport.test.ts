import { describe, expect, it } from "vitest";
import {
  decodeRemoteSupportBinaryPacket,
  encodeRemoteSupportBinaryPacket,
  REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION,
  REMOTE_SUPPORT_MAX_FRAME_BYTES,
  REMOTE_SUPPORT_MAX_HEADER_BYTES,
  type RemoteSupportFrameHeader,
} from "../shared/remoteSupportTransport";

function header(overrides: Partial<RemoteSupportFrameHeader> = {}): RemoteSupportFrameHeader {
  return {
    type: "screen-feed-frame",
    version: 1,
    tabId: "tab-a",
    capturedAt: "2026-09-17T10:00:00.000Z",
    metadata: {
      viewport: { width: 1280, height: 720, scrollX: 0, scrollY: 100 },
      capture: { quality: 0.7, encodedBytes: 6 },
    },
    ...overrides,
  };
}

describe("remote support binary frame protocol", () => {
  it("round-trips the metadata header and preserves raw JPEG bytes exactly", () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0xff, 0xd9]);
    const packet = encodeRemoteSupportBinaryPacket(header(), jpeg);
    const decoded = decodeRemoteSupportBinaryPacket(packet);

    expect(decoded).not.toBeNull();
    expect(decoded?.header.tabId).toBe("tab-a");
    expect(decoded?.header.type).toBe("screen-feed-frame");
    expect(decoded?.header.version).toBe(REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION);
    expect(decoded?.header.metadata).toEqual(header().metadata);
    expect(Array.from(decoded?.payload ?? [])).toEqual(Array.from(jpeg));
  });

  it("keeps different tab identities independent in the packet header", () => {
    const jpeg = new Uint8Array([1, 2, 3, 4]);
    const first = decodeRemoteSupportBinaryPacket(encodeRemoteSupportBinaryPacket(header({ tabId: "tab-a" }), jpeg));
    const second = decodeRemoteSupportBinaryPacket(encodeRemoteSupportBinaryPacket(header({ tabId: "tab-b" }), jpeg));

    expect(first?.header.tabId).toBe("tab-a");
    expect(second?.header.tabId).toBe("tab-b");
  });

  it("rejects truncated, invalid-version, empty-payload, and invalid-header packets", () => {
    expect(decodeRemoteSupportBinaryPacket(new Uint8Array([1, 0, 0]))).toBeNull();

    const valid = encodeRemoteSupportBinaryPacket(header(), new Uint8Array([1, 2, 3]));
    const invalidVersion = valid.slice();
    invalidVersion[0] = 99;
    expect(decodeRemoteSupportBinaryPacket(invalidVersion)).toBeNull();

    const noPayload = encodeRemoteSupportBinaryPacket(header(), new Uint8Array([1]));
    expect(decodeRemoteSupportBinaryPacket(noPayload.subarray(0, noPayload.length - 1))).toBeNull();

    const badHeader = encodeRemoteSupportBinaryPacket(header(), new Uint8Array([1, 2]));
    const view = new DataView(badHeader.buffer, badHeader.byteOffset, badHeader.byteLength);
    view.setUint32(1, REMOTE_SUPPORT_MAX_HEADER_BYTES + 1, false);
    expect(decodeRemoteSupportBinaryPacket(badHeader)).toBeNull();
  });

  it("enforces the binary frame size limit before allocation/transport", () => {
    expect(() =>
      encodeRemoteSupportBinaryPacket(header(), new Uint8Array(REMOTE_SUPPORT_MAX_FRAME_BYTES + 1))
    ).toThrow("Remote support frame is too large.");
  });
});

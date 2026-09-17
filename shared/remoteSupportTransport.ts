export const REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION = 1;
export const REMOTE_SUPPORT_BINARY_PREFIX_BYTES = 5;
export const REMOTE_SUPPORT_MAX_HEADER_BYTES = 24 * 1024;
export const REMOTE_SUPPORT_MAX_FRAME_BYTES = 900_000;

export interface RemoteSupportFrameHeader {
  type: "screen-feed-frame";
  version: 1;
  tabId: string;
  capturedAt: string;
  metadata: Record<string, unknown>;
}

export interface DecodedRemoteSupportBinaryPacket {
  header: RemoteSupportFrameHeader;
  payload: Uint8Array;
}

function validHeader(value: unknown): value is RemoteSupportFrameHeader {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const header = value as Partial<RemoteSupportFrameHeader>;
  return (
    header.type === "screen-feed-frame" &&
    header.version === REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION &&
    typeof header.tabId === "string" &&
    header.tabId.length > 0 &&
    header.tabId.length <= 160 &&
    typeof header.capturedAt === "string" &&
    !!header.metadata &&
    typeof header.metadata === "object" &&
    !Array.isArray(header.metadata)
  );
}

/**
 * Packet layout: [version:1][headerLength:4 big-endian][UTF-8 JSON header][JPEG].
 * Only the small metadata header is JSON; the image never becomes base64 or a
 * JSON string and can be forwarded as the exact binary bytes received.
 */
export function encodeRemoteSupportBinaryPacket(
  header: RemoteSupportFrameHeader,
  payload: Uint8Array
): Uint8Array {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  if (headerBytes.byteLength > REMOTE_SUPPORT_MAX_HEADER_BYTES) throw new Error("Remote support header is too large.");
  if (payload.byteLength > REMOTE_SUPPORT_MAX_FRAME_BYTES) throw new Error("Remote support frame is too large.");
  const packet = new Uint8Array(REMOTE_SUPPORT_BINARY_PREFIX_BYTES + headerBytes.byteLength + payload.byteLength);
  packet[0] = REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION;
  new DataView(packet.buffer).setUint32(1, headerBytes.byteLength, false);
  packet.set(headerBytes, REMOTE_SUPPORT_BINARY_PREFIX_BYTES);
  packet.set(payload, REMOTE_SUPPORT_BINARY_PREFIX_BYTES + headerBytes.byteLength);
  return packet;
}

export function decodeRemoteSupportBinaryPacket(packet: Uint8Array): DecodedRemoteSupportBinaryPacket | null {
  if (packet.byteLength < REMOTE_SUPPORT_BINARY_PREFIX_BYTES) return null;
  if (packet[0] !== REMOTE_SUPPORT_BINARY_PROTOCOL_VERSION) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  const headerLength = view.getUint32(1, false);
  if (headerLength <= 0 || headerLength > REMOTE_SUPPORT_MAX_HEADER_BYTES) return null;
  const payloadOffset = REMOTE_SUPPORT_BINARY_PREFIX_BYTES + headerLength;
  if (payloadOffset > packet.byteLength) return null;
  const payloadLength = packet.byteLength - payloadOffset;
  if (payloadLength <= 0 || payloadLength > REMOTE_SUPPORT_MAX_FRAME_BYTES) return null;

  try {
    const headerRaw = new TextDecoder().decode(packet.subarray(REMOTE_SUPPORT_BINARY_PREFIX_BYTES, payloadOffset));
    const header = JSON.parse(headerRaw) as unknown;
    if (!validHeader(header)) return null;
    return { header, payload: packet.subarray(payloadOffset) };
  } catch {
    return null;
  }
}

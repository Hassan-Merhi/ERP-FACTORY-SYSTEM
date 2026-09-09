import type { DirectMessage } from "./schema";

export type RealtimeChatEvent =
  | { type: "message:new"; message: DirectMessage }
  | { type: "typing:update"; senderId: string; receiverId: string; isTyping: boolean; until: number | null }
  | { type: "message:read"; readerId: string; senderId: string }
  | { type: "conversation:cleared"; userIds: [string, string] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

function validTimestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Decode only the small realtime envelope. The canonical message itself already
 * comes from a validated database row on the server, so the client only needs
 * enough structural checking to route and de-duplicate it safely.
 */
export function parseRealtimeChatEvent(value: unknown): RealtimeChatEvent | null {
  if (!isRecord(value) || typeof value.type !== "string") return null;

  if (value.type === "message:new") {
    const message = value.message;
    if (!isRecord(message)) return null;
    if (!Number.isSafeInteger(message.id) || Number(message.id) <= 0) return null;
    if (!nonEmptyString(message.senderId) || !nonEmptyString(message.receiverId)) return null;
    return { type: "message:new", message: message as unknown as DirectMessage };
  }

  if (value.type === "typing:update") {
    const senderId = nonEmptyString(value.senderId);
    const receiverId = nonEmptyString(value.receiverId);
    if (!senderId || !receiverId || typeof value.isTyping !== "boolean") return null;
    return {
      type: "typing:update",
      senderId,
      receiverId,
      isTyping: value.isTyping,
      until: value.isTyping ? validTimestamp(value.until) : null,
    };
  }

  if (value.type === "message:read") {
    const readerId = nonEmptyString(value.readerId);
    const senderId = nonEmptyString(value.senderId);
    if (!readerId || !senderId) return null;
    return { type: "message:read", readerId, senderId };
  }

  if (value.type === "conversation:cleared") {
    if (!Array.isArray(value.userIds) || value.userIds.length !== 2) return null;
    const first = nonEmptyString(value.userIds[0]);
    const second = nonEmptyString(value.userIds[1]);
    if (!first || !second) return null;
    return { type: "conversation:cleared", userIds: [first, second] };
  }

  return null;
}

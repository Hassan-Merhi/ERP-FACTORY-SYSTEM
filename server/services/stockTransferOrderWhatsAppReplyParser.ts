/**
 * GREEN API incoming quoted reply parser.
 * Pure validation: no database, network calls, session, approval or delivery.
 * GREEN API sends textMessage with quotedMessage.stanzaId and
 * legacy quotedMessage with extendedTextMessageData.stanzaId.
 */
export type StockTransferOrderWaReplyCommand = "DONE" | "DECLINE";

export interface StockTransferOrderWaReply {
  instanceId: string;
  chatId: string;
  senderChatId: string;
  senderE164: string;
  quotedMessageId: string;
  incomingMessageId: string;
  command: StockTransferOrderWaReplyCommand;
  timestamp: number | null;
}

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordValue : null;
}
function cleanId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return /^[a-zA-Z0-9_.:-]{6,160}$/.test(value) ? value : null;
}

export function parseStockTransferOrderWaReply(payload: unknown): StockTransferOrderWaReply | null {
  const root = record(payload);
  if (!root || root.typeWebhook !== "incomingMessageReceived") return null;

  const instance = record(root.instanceData);
  const sender = record(root.senderData);
  const message = record(root.messageData);
  if (!instance || !sender || !message || instance.typeInstance !== "whatsapp") return null;

  const instanceId = String(instance.idInstance ?? "");
  const chatId = sender.chatId;
  const senderChatId = sender.sender;
  const incomingMessageId = cleanId(root.idMessage);
  if (!/^[1-9][0-9]{4,19}$/.test(instanceId) ||
      typeof chatId !== "string" || !/^[0-9]{5,25}@g[.]us$/.test(chatId) ||
      typeof senderChatId !== "string" || !/^[1-9][0-9]{6,14}@c[.]us$/.test(senderChatId) ||
      !incomingMessageId) return null;

  let text: unknown;
  let quote: unknown;
  if (message.typeMessage === "textMessage") {
    const textData = record(message.textMessageData);
    text = textData?.textMessage;
    quote = record(message.quotedMessage)?.stanzaId;
  } else if (message.typeMessage === "quotedMessage") {
    const textData = record(message.extendedTextMessageData);
    text = textData?.text;
    quote = textData?.stanzaId;
  } else {
    return null;
  }

  // Only exact, single-word ASCII replies are commands. No arbitrary chat
  // chatter, attachments, edits, reactions, forwards or ambiguous commands.
  if (typeof text !== "string" || text.length > 32) return null;
  const normalized = text.trim().toUpperCase();
  if (normalized !== "DONE" && normalized !== "DECLINE") return null;
  const quotedMessageId = cleanId(quote);
  if (!quotedMessageId) return null;

  const timestamp = typeof root.timestamp === "number" && Number.isSafeInteger(root.timestamp) &&
    root.timestamp > 0 ? root.timestamp : null;
  return {
    instanceId,
    chatId,
    senderChatId,
    senderE164: "+" + senderChatId.slice(0, -"@c.us".length),
    quotedMessageId,
    incomingMessageId,
    command: normalized,
    timestamp,
  };
}

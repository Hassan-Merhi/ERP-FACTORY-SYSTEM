import { afterEach, describe, expect, it, vi } from "vitest";
import { parseStockTransferOrderWaReply } from "../server/services/stockTransferOrderWhatsAppReplyParser";
import {
  authorizedStockTransferOrderWaWebhook,
  webhookTokenIsConfigured,
} from "../server/services/security/stockTransferOrderWaWebhookAuthentication";

function groupReply() {
  return {
    typeWebhook: "incomingMessageReceived",
    instanceData: { idInstance: 7103000000, wid: "96170999999@c.us", typeInstance: "whatsapp" },
    timestamp: 1794400000,
    idMessage: "ABCDEF1234567890",
    senderData: { chatId: "120363369140947676@g.us", sender: "96170123456@c.us", senderName: "Supervisor" },
    messageData: {
      typeMessage: "textMessage",
      textMessageData: { textMessage: "  done  " },
      quotedMessage: { stanzaId: "67AEC1B7086ECDC7E6E45923F5EDB825", participant: "96170999999@c.us" },
    },
  };
}

afterEach(() => vi.unstubAllEnvs());

describe("Stock Transfer Order GREEN API reply validation", () => {
  it("accepts an exact, directly quoted DONE from a group", () => {
    expect(parseStockTransferOrderWaReply(groupReply())).toEqual({
      instanceId: "7103000000",
      chatId: "120363369140947676@g.us",
      senderChatId: "96170123456@c.us",
      senderE164: "+96170123456",
      incomingMessageId: "ABCDEF1234567890",
      quotedMessageId: "67AEC1B7086ECDC7E6E45923F5EDB825",
      command: "DONE",
      timestamp: 1794400000,
    });
  });

  it("supports GREEN API legacy quotedMessage with DECLINE", () => {
    const payload = groupReply();
    const quotedId = payload.messageData.quotedMessage.stanzaId;
    const modified = {
      ...payload,
      messageData: {
        typeMessage: "quotedMessage",
        extendedTextMessageData: {
          text: "Decline",
          stanzaId: quotedId,
          participant: "96170999999@c.us",
        },
      },
    };
    expect(parseStockTransferOrderWaReply(modified)?.command).toBe("DECLINE");
    expect(parseStockTransferOrderWaReply(modified)?.quotedMessageId).toBe(quotedId);
  });

  it("ignores general chat chatter, unquoted commands and unexpected message types", () => {
    const payload = groupReply();
    expect(parseStockTransferOrderWaReply({
      ...payload, messageData: { typeMessage: "textMessage", textMessageData: { textMessage: "DONE" } },
    })).toBeNull();
    expect(parseStockTransferOrderWaReply({
      ...payload, messageData: { ...payload.messageData, textMessageData: { textMessage: "DONE ALL" } },
    })).toBeNull();
    expect(parseStockTransferOrderWaReply({
      ...payload, messageData: { ...payload.messageData, typeMessage: "documentMessage" },
    })).toBeNull();
    expect(parseStockTransferOrderWaReply({ ...payload, typeWebhook: "outgoingAPIMessageReceived" })).toBeNull();
  });

  it("ignores private chats, group senders masquerading as phone numbers and LID senders", () => {
    const payload = groupReply();
    expect(parseStockTransferOrderWaReply({
      ...payload, senderData: { ...payload.senderData, chatId: "96170123456@c.us" },
    })).toBeNull();
    expect(parseStockTransferOrderWaReply({
      ...payload, senderData: { ...payload.senderData, sender: "123456789012@lid" },
    })).toBeNull();
    expect(parseStockTransferOrderWaReply({
      ...payload, senderData: { ...payload.senderData, sender: "120363369140947676@g.us" },
    })).toBeNull();
  });

  it("fails closed for missing instance ID, invalid message IDs and malformed notification body", () => {
    const payload = groupReply();
    expect(parseStockTransferOrderWaReply({
      ...payload, instanceData: { typeInstance: "whatsapp" },
    })).toBeNull();
    expect(parseStockTransferOrderWaReply({
      ...payload, idMessage: " ",
    })).toBeNull();
    expect(parseStockTransferOrderWaReply({})).toBeNull();
    expect(parseStockTransferOrderWaReply("DONE")).toBeNull();
  });
});

describe("GREEN API webhook bearer secret", () => {
  it("is disabled when absent or weak", () => {
    vi.stubEnv("STO_WA_GREEN_API_WEBHOOK_TOKEN", "");
    expect(webhookTokenIsConfigured()).toBe(false);
    expect(authorizedStockTransferOrderWaWebhook("Bearer anything")).toBe(false);
    vi.stubEnv("STO_WA_GREEN_API_WEBHOOK_TOKEN", "1234");
    expect(webhookTokenIsConfigured()).toBe(false);
  });

  it("requires the exact configured Bearer secret", () => {
    const token = "k".repeat(48);
    vi.stubEnv("STO_WA_GREEN_API_WEBHOOK_TOKEN", token);
    expect(webhookTokenIsConfigured()).toBe(true);
    expect(authorizedStockTransferOrderWaWebhook("Bearer " + token)).toBe(true);
    expect(authorizedStockTransferOrderWaWebhook("Bearer " + "x".repeat(48))).toBe(false);
    expect(authorizedStockTransferOrderWaWebhook("Basic " + token)).toBe(false);
    expect(authorizedStockTransferOrderWaWebhook("bearer " + token)).toBe(false);
    expect(authorizedStockTransferOrderWaWebhook(undefined)).toBe(false);
  });
});

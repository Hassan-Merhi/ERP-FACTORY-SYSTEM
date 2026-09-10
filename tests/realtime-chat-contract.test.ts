import { parseRealtimeChatEvent } from "../shared/realtimeChat";

describe("realtime chat event contract", () => {
  it("accepts a canonical new-message event", () => {
    expect(
      parseRealtimeChatEvent({
        type: "message:new",
        message: {
          id: 44,
          senderId: "user-a",
          receiverId: "user-b",
          message: "hello",
          fileUrl: null,
          fileName: null,
          fileType: null,
          fileSize: null,
          readAt: null,
          createdAt: "2026-09-09T06:00:00.000Z",
        },
      })
    ).toMatchObject({ type: "message:new", message: { id: 44, senderId: "user-a", receiverId: "user-b" } });
  });

  it("rejects malformed new-message envelopes", () => {
    expect(parseRealtimeChatEvent({ type: "message:new", message: { id: 0, senderId: "a", receiverId: "b" } })).toBeNull();
    expect(parseRealtimeChatEvent({ type: "message:new", message: { id: 1, senderId: "", receiverId: "b" } })).toBeNull();
  });

  it("parses typing start and stop events", () => {
    expect(
      parseRealtimeChatEvent({
        type: "typing:update",
        senderId: "user-a",
        receiverId: "user-b",
        isTyping: true,
        until: 1_800_000_000_000,
      })
    ).toEqual({
      type: "typing:update",
      senderId: "user-a",
      receiverId: "user-b",
      isTyping: true,
      until: 1_800_000_000_000,
    });

    expect(
      parseRealtimeChatEvent({
        type: "typing:update",
        senderId: "user-a",
        receiverId: "user-b",
        isTyping: false,
        until: 1_800_000_000_000,
      })
    ).toEqual({
      type: "typing:update",
      senderId: "user-a",
      receiverId: "user-b",
      isTyping: false,
      until: null,
    });
  });

  it("parses read and conversation-clear events", () => {
    expect(parseRealtimeChatEvent({ type: "message:read", readerId: "user-b", senderId: "user-a" })).toEqual({
      type: "message:read",
      readerId: "user-b",
      senderId: "user-a",
    });
    expect(parseRealtimeChatEvent({ type: "conversation:cleared", userIds: ["user-a", "user-b"] })).toEqual({
      type: "conversation:cleared",
      userIds: ["user-a", "user-b"],
    });
  });

  it("ignores unrelated websocket payloads", () => {
    expect(parseRealtimeChatEvent({ type: "invalidate", topics: ["communications"] })).toBeNull();
    expect(parseRealtimeChatEvent({ type: "typing:update", senderId: "a" })).toBeNull();
    expect(parseRealtimeChatEvent(null)).toBeNull();
  });
});

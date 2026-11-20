/**
 * Chatbot message, history and session routes over real HTTP in one
 * rolled-back transaction per test. Only the AI provider call is stubbed (its
 * module boundary). Pins the chatbot-enabled gate, required fields, provider
 * failure, role-gated history with the Developer privacy filter, session
 * listing previews and the delete-session ownership rules, including that
 * another company's session is not found.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ callAI: vi.fn() }));
vi.mock("../server/chat/aiProviders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/chat/aiProviders")>()),
  callAIWithFallback: h.callAI,
}));

import { withFactoryWorld, type FactoryWorld } from "./helpers/rolledBackFactoryApp";

beforeEach(() => {
  h.callAI.mockReset();
  h.callAI.mockResolvedValue({ response: "Hello from the assistant", usedProvider: "gemini" });
});

const enableChat = (w: FactoryWorld, userId = w.userId) =>
  w.q(`UPDATE users SET chatbot_enabled = true WHERE id = $1`, [userId]);
const message = (
  w: FactoryWorld,
  userId: string,
  sessionId: string,
  role: string,
  content: string,
  companyId = w.companyId
) =>
  w.q(`INSERT INTO chat_messages (company_id, user_id, role, content, session_id) VALUES ($1, $2, $3, $4, $5)`, [
    companyId,
    userId,
    role,
    content,
    sessionId,
  ]);
const userIdOf = async (w: FactoryWorld, agent: FactoryWorld["agent"]) => {
  const me = await agent.get("/api/auth/me");
  return String(me.body?.user?.id ?? me.body?.id);
};

describe("POST /api/chatbot/message", () => {
  it("refuses users without the assistant enabled and requests missing fields", () =>
    withFactoryWorld(async (w) => {
      const off = await w.agent.post("/api/chatbot/message").send({ message: "hi", sessionId: "s1" });
      expect([off.status, off.body.message]).toEqual([403, "AI assistant is not enabled for your account"]);
      await enableChat(w);
      for (const body of [{ sessionId: "s1" }, { message: "hi" }]) {
        const res = await w.agent.post("/api/chatbot/message").send(body);
        expect([res.status, res.body.message]).toEqual([400, "Message and sessionId are required"]);
      }
      expect(await w.q(`SELECT id FROM chat_messages WHERE company_id = $1`, [w.companyId])).toEqual([]);
    }));

  it("saves both sides of a conversation and returns null draft fields", () =>
    withFactoryWorld(async (w) => {
      await enableChat(w);
      const res = await w.agent.post("/api/chatbot/message").send({ message: "hello there", sessionId: `${w.tag}S` });
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ response: expect.any(String), voucherDraft: null, stockTransferDraft: null });
      const saved = await w.q(`SELECT role FROM chat_messages WHERE session_id = $1 ORDER BY id`, [`${w.tag}S`]);
      expect(saved.map((r) => r.role)).toEqual(["user", "assistant"]);
    }));

  it("reports a 500 when the conversation cannot be saved", () =>
    withFactoryWorld(async (w) => {
      await enableChat(w);
      const res = await w.agent.post("/api/chatbot/message").send({ message: "hello\u0000", sessionId: `${w.tag}NUL` });
      expect(res.status).toBe(500);
      expect(res.body.message).toMatch(/^Chat error: /);
    }));
});

describe("chat history", () => {
  it("returns only the caller's own session history", () =>
    withFactoryWorld(async (w) => {
      await message(w, w.userId, `${w.tag}H`, "user", "mine");
      const clerk = await w.agentFor("Accountant");
      expect((await w.agent.get(`/api/chatbot/history/${w.tag}H`)).body).toHaveLength(1);
      expect((await clerk.get(`/api/chatbot/history/${w.tag}H`)).body).toEqual([]);
    }));

  it("limits all-history to admin roles and hides Developer chats from non-developers", () =>
    withFactoryWorld(async (w) => {
      const clerk = await w.agentFor("Accountant");
      expect((await clerk.get("/api/chatbot/all-history")).status).toBe(403);
      expect((await w.agent.get("/api/chatbot/all-history")).body).toEqual([]);
      const dev = await w.agentFor("Developer");
      const devId = await userIdOf(w, dev);
      await message(w, w.userId, `${w.tag}A`, "user", "admin text");
      await message(w, devId, `${w.tag}D`, "user", "dev text");
      const asAdmin = await w.agent.get("/api/chatbot/all-history");
      expect(asAdmin.body.map((m: { content: string }) => m.content).sort()).toEqual(["admin text"]);
      expect(asAdmin.body[0].username).toBe(w.username);
      const asDev = await dev.get("/api/chatbot/all-history");
      expect(asDev.body.map((m: { content: string }) => m.content).sort()).toEqual(["admin text", "dev text"]);
    }));

  it("lists own sessions with a preview or a placeholder", () =>
    withFactoryWorld(async (w) => {
      await message(w, w.userId, `${w.tag}P`, "user", "p".repeat(150));
      await message(w, w.userId, `${w.tag}P`, "assistant", "reply");
      await message(w, w.userId, `${w.tag}Q`, "assistant", "only assistant");
      const res = await w.agent.get("/api/chatbot/my-sessions");
      const bySession = Object.fromEntries(res.body.map((s: { sessionId: string }) => [s.sessionId, s]));
      expect(bySession[`${w.tag}P`]).toMatchObject({ messageCount: 2, preview: "p".repeat(100) });
      expect(bySession[`${w.tag}Q`]).toMatchObject({ messageCount: 1, preview: "Chat session" });
    }));
});

describe("DELETE /api/chatbot/session/:sessionId", () => {
  it("returns 404 for unknown sessions and sessions of another company", () =>
    withFactoryWorld(async (w) => {
      expect((await w.agent.delete(`/api/chatbot/session/${w.tag}none`)).status).toBe(404);
      const other = await w.one(
        `INSERT INTO companies (code, name, company_type) VALUES ($1::varchar, $1::text, 'factory') RETURNING id`,
        [`${w.tag}OC`]
      );
      await message(w, w.userId, `${w.tag}F`, "user", "foreign", other);
      expect((await w.agent.delete(`/api/chatbot/session/${w.tag}F`)).status).toBe(404);
      expect(await w.q(`SELECT id FROM chat_messages WHERE session_id = $1`, [`${w.tag}F`])).toHaveLength(1);
    }));

  it("lets owners and admins delete, but not other users or admins on Developer sessions", () =>
    withFactoryWorld(async (w) => {
      const clerk = await w.agentFor("Accountant");
      const clerkId = await userIdOf(w, clerk);
      const dev = await w.agentFor("Developer");
      const devId = await userIdOf(w, dev);
      await message(w, w.userId, `${w.tag}ADM`, "user", "admin");
      await message(w, clerkId, `${w.tag}CLK`, "user", "clerk");
      await message(w, devId, `${w.tag}DEV`, "user", "dev");
      expect((await clerk.delete(`/api/chatbot/session/${w.tag}ADM`)).status).toBe(403);
      const blocked = await w.agent.delete(`/api/chatbot/session/${w.tag}DEV`);
      expect([blocked.status, blocked.body.message]).toEqual([403, "Cannot delete a Developer's conversation"]);
      expect((await clerk.delete(`/api/chatbot/session/${w.tag}CLK`)).body).toEqual({ success: true });
      expect((await w.agent.delete(`/api/chatbot/session/${w.tag}ADM`)).body).toEqual({ success: true });
      expect((await dev.delete(`/api/chatbot/session/${w.tag}DEV`)).body).toEqual({ success: true });
      const left = await w.q(`SELECT session_id FROM chat_messages WHERE company_id = $1`, [w.companyId]);
      expect(left).toEqual([]);
    }));
});

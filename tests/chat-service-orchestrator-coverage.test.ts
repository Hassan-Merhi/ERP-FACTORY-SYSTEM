/**
 * chat() orchestration (server/chatService.ts) against the real database
 * inside one rolled-back transaction, with the LLM provider module
 * (server/chat/aiProviders) mocked at its boundary. Covers the unconfigured
 * refusal, every intent branch (general knowledge, code read/edit, action,
 * tool, full context with page context), and the error mapping for missing
 * keys, quota/rate limits and anything else.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PoolClient } from "pg";

const ai = vi.hoisted(() => ({
  providers: ["gemini"] as string[],
  main: "Mock answer" as string,
  error: null as Error | null,
  calls: [] as Array<{ provider: string; system: string; message: string }>,
}));
vi.mock("../server/chat/aiProviders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/chat/aiProviders")>()),
  getAvailableProviders: () => ai.providers,
  getSelectedAIProvider: async () => "gemini",
  callAIWithFallback: async (provider: string, system: string, _history: unknown, message: string) => {
    ai.calls.push({ provider, system, message });
    if (ai.calls.length === 1 && ai.error) throw ai.error;
    return { response: ai.calls.length === 1 ? ai.main : "NONE", usedProvider: provider };
  },
}));

import { withRolledBackPool } from "./helpers/routedPoolClient";
import { chat } from "../server/chatService";

let seq = 0;
async function company(client: PoolClient) {
  const tag = `CHT${process.pid}${Date.now().toString(36)}${++seq}`.toUpperCase().slice(0, 18);
  const { rows } = await client.query<{ id: number }>(
    `INSERT INTO companies (code, name, base_currency) VALUES ($1::varchar, $1::text, 'USD') RETURNING id`,
    [tag]
  );
  return rows[0].id;
}

beforeEach(() => {
  ai.providers = ["gemini"];
  ai.main = "Mock answer";
  ai.error = null;
  ai.calls.length = 0;
});

describe("chat orchestrator", () => {
  it("refuses when no provider is configured, without calling one", async () => {
    ai.providers = [];
    const result = await chat("hello", 1);
    expect(result.response).toMatch(/not configured/);
    expect(result.suggestions).toEqual([]);
    expect(ai.calls).toEqual([]);
  });

  it("answers general knowledge without ERP context", async () => {
    const result = await chat("hello, how are you?", 1);
    expect(result.response).toBe("Mock answer");
    expect(result.provider).toBe("gemini");
    expect(result.suggestions).toContain("Explain how machine learning works");
    expect(result.filePatchDrafts).toBeUndefined();
  });

  it("routes code read and code edit requests", async () => {
    const read = await chat("explain server/chatService.ts", 1);
    expect(read.response).toBe("Mock answer");
    expect(read.readFiles).toEqual(expect.arrayContaining(["server/chatService.ts"]));

    ai.calls.length = 0;
    ai.main = "No JSON here";
    const edit = await chat("edit server/chatService.ts and add a comment at the top", 1, [], undefined, undefined, [
      "server/chatService.ts",
    ]);
    expect(typeof edit.response).toBe("string");
    expect(edit.filePatchDrafts).toBeUndefined();
  });

  it("uses light prompts for action and tool intents, full context otherwise", () =>
    withRolledBackPool(async (client) => {
      const companyId = await company(client);
      const action = await chat("search voucher number PV-0001", companyId);
      expect(action.response).toBe("Mock answer");
      expect(action.suggestions).toEqual([]);

      ai.calls.length = 0;
      const tool = await chat("show me the business summary for this month", companyId);
      expect(tool.response).toBe("Mock answer");
      expect(tool.suggestions).toEqual([]);

      ai.calls.length = 0;
      const general = await chat("tell me about our factory", companyId, [], undefined, {
        currentRoute: "/vouchers",
        entityType: "voucher",
        entityName: "PV-1",
        entityId: 7,
      });
      expect(general.response).toBe("Mock answer");
      expect(ai.calls[0].system).toContain("User is currently on route: /vouchers");
      expect(ai.calls[0].system).toContain("Entity ID: 7");

      ai.calls.length = 0;
      await chat("tell me about our factory", companyId, [], undefined, { currentRoute: "/home" });
      expect(ai.calls[0].system).toContain("/home");
      expect(ai.calls[0].system).not.toContain("Viewing entity type");
    }));

  it("maps provider failures to friendly answers", async () => {
    ai.error = new Error("Missing GEMINI API_KEY");
    expect((await chat("hello", 1)).response).toMatch(/Invalid or missing API key/);

    ai.calls.length = 0;
    ai.error = new Error("429 rate limit reached");
    expect((await chat("hello", 1)).response).toBe(
      "API quota exceeded. Please try again later or add additional AI provider keys in your environment."
    );

    ai.calls.length = 0;
    ai.providers = ["gemini", "chatgpt"];
    ai.error = new Error("quota exhausted");
    expect((await chat("hello", 1)).response).toMatch(/Trying fallback providers also failed/);

    ai.calls.length = 0;
    ai.providers = ["gemini"];
    ai.error = new Error("socket hang up");
    const other = await chat("hello", 1);
    expect(other.response).toBe("Sorry, something went wrong while processing your request. (socket hang up)");
    expect(other.suggestions).toEqual([]);
  });
});

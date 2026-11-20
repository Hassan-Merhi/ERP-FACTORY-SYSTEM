/**
 * Provider selection, key detection and the fallback caller in
 * server/chat/aiProviders.ts. The Gemini and OpenAI SDKs are mocked at the
 * module boundary; the ai_provider setting is read from the real database
 * inside a rolled-back transaction.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  gemini: vi.fn(),
  openai: vi.fn(),
  openaiConfigs: [] as Array<{ apiKey?: string; baseURL?: string }>,
}));

vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { generateContent: sdk.gemini };
  },
}));

vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: (args: unknown) => sdk.openai(this.config, args) } };
    constructor(public config: { apiKey?: string; baseURL?: string }) {
      sdk.openaiConfigs.push(config);
    }
  },
}));

import {
  callAIWithFallback,
  getAvailableProviders,
  getConfiguredProviders,
  getSelectedAIProvider,
} from "../server/chat/aiProviders";
import { db } from "../server/db";
import { withRolledBackPool } from "./helpers/routedPoolClient";

const KEYS = ["GEMINI_API_KEY", "OPENAI_API_KEY", "XAI_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};

function setKeys(keys: Partial<Record<(typeof KEYS)[number], string>>) {
  for (const key of KEYS) {
    if (keys[key]) process.env[key] = keys[key];
    else delete process.env[key];
  }
}

async function withProviderSetting<T>(value: string | null, work: () => Promise<T>): Promise<T> {
  return withRolledBackPool(async (client) => {
    await client.query(`DELETE FROM system_settings WHERE key = 'ai_provider'`);
    if (value !== null) {
      await client.query(`INSERT INTO system_settings (key, value) VALUES ('ai_provider', $1)`, [value]);
    }
    return work();
  });
}

beforeEach(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  sdk.gemini.mockReset();
  sdk.openai.mockReset();
  sdk.openaiConfigs.length = 0;
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  vi.restoreAllMocks();
});

describe("getSelectedAIProvider", () => {
  it("returns a configured provider, case-insensitively", async () => {
    await expect(withProviderSetting("ChatGPT", getSelectedAIProvider)).resolves.toBe("chatgpt");
    await expect(withProviderSetting("grok", getSelectedAIProvider)).resolves.toBe("grok");
  });

  it("defaults to gemini for an unknown value, an empty value, or no row", async () => {
    await expect(withProviderSetting("claude", getSelectedAIProvider)).resolves.toBe("gemini");
    await expect(withProviderSetting("", getSelectedAIProvider)).resolves.toBe("gemini");
    await expect(withProviderSetting(null, getSelectedAIProvider)).resolves.toBe("gemini");
  });

  it("defaults to gemini when the settings read fails", async () => {
    vi.spyOn(db, "select").mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(getSelectedAIProvider()).resolves.toBe("gemini");
  });
});

describe("provider availability", () => {
  it("lists only providers with a key", () => {
    setKeys({});
    expect(getAvailableProviders()).toEqual([]);
    expect(getConfiguredProviders().every((row) => !row.available)).toBe(true);
    setKeys({ OPENAI_API_KEY: "o", XAI_API_KEY: "x" });
    expect(getAvailableProviders()).toEqual(["chatgpt", "grok"]);
    expect(getConfiguredProviders()).toEqual([
      { provider: "gemini", available: false },
      { provider: "chatgpt", available: true },
      { provider: "grok", available: true },
    ]);
  });
});

describe("callAIWithFallback", () => {
  const history = [
    { role: "user", content: "hi" },
    { role: "assistant", content: "hello" },
  ];

  it("throws 'No AI providers available' when no key is configured", async () => {
    setKeys({});
    await expect(callAIWithFallback("gemini", "sys", [], "q")).rejects.toThrow("No AI providers available");
    expect(sdk.gemini).not.toHaveBeenCalled();
  });

  it("uses Gemini with the conversation mapped to user/model turns", async () => {
    setKeys({ GEMINI_API_KEY: "g" });
    sdk.gemini.mockResolvedValue({ text: "gemini says" });
    const result = await callAIWithFallback("gemini", "sys", history, "q");
    expect(result).toEqual({ response: "gemini says", usedProvider: "gemini" });
    const args = sdk.gemini.mock.calls[0][0];
    expect(args.model).toBe("gemini-2.0-flash");
    expect(args.contents.map((c: { role: string }) => c.role)).toEqual(["user", "model", "user", "model", "user"]);
  });

  it("returns the fallback sentence when a provider returns no text", async () => {
    setKeys({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o", XAI_API_KEY: "x" });
    sdk.gemini.mockResolvedValue({ text: "" });
    await expect(callAIWithFallback("gemini", "s", [], "q")).resolves.toEqual({
      response: "I couldn't generate a response.",
      usedProvider: "gemini",
    });
    sdk.openai.mockResolvedValue({ choices: [] });
    await expect(callAIWithFallback("chatgpt", "s", [], "q")).resolves.toEqual({
      response: "I couldn't generate a response.",
      usedProvider: "chatgpt",
    });
    await expect(callAIWithFallback("grok", "s", [], "q")).resolves.toEqual({
      response: "I couldn't generate a response.",
      usedProvider: "grok",
    });
  });

  it("calls ChatGPT and Grok with their models and the xAI base URL", async () => {
    setKeys({ OPENAI_API_KEY: "o", XAI_API_KEY: "x" });
    sdk.openai.mockImplementation(async (_config, args: { model: string }) => ({
      choices: [{ message: { content: `from ${args.model}` } }],
    }));
    await expect(callAIWithFallback("chatgpt", "s", history, "q")).resolves.toEqual({
      response: "from gpt-4o-mini",
      usedProvider: "chatgpt",
    });
    await expect(callAIWithFallback("grok", "s", history, "q")).resolves.toEqual({
      response: "from grok-2-latest",
      usedProvider: "grok",
    });
    expect(sdk.openaiConfigs).toContainEqual({ apiKey: "x", baseURL: "https://api.x.ai/v1" });
    const [, chatArgs] = sdk.openai.mock.calls[0];
    expect(chatArgs.messages.map((m: { role: string }) => m.role)).toEqual(["system", "user", "assistant", "user"]);
  });

  it("skips a selected provider without a key and falls back to the next available", async () => {
    setKeys({ XAI_API_KEY: "x" });
    sdk.openai.mockResolvedValue({ choices: [{ message: { content: "grok answer" } }] });
    await expect(callAIWithFallback("gemini", "s", [], "q")).resolves.toEqual({
      response: "grok answer",
      usedProvider: "grok",
    });
    expect(sdk.gemini).not.toHaveBeenCalled();
  });

  it("falls back after a provider error or timeout and rethrows the last error when all fail", async () => {
    setKeys({ GEMINI_API_KEY: "g", OPENAI_API_KEY: "o" });
    sdk.gemini.mockRejectedValue(new Error("gemini timeout"));
    sdk.openai.mockResolvedValue({ choices: [{ message: { content: "openai ok" } }] });
    await expect(callAIWithFallback("gemini", "s", [], "q")).resolves.toEqual({
      response: "openai ok",
      usedProvider: "chatgpt",
    });

    sdk.openai.mockRejectedValue(new Error("openai 500"));
    await expect(callAIWithFallback("gemini", "s", [], "q")).rejects.toThrow("openai 500");
    sdk.gemini.mockRejectedValue(new Error("gemini 429"));
    await expect(callAIWithFallback("chatgpt", "s", [], "q")).rejects.toThrow("gemini 429");
  });

  it("ignores an unknown provider name and uses the available ones", async () => {
    setKeys({ GEMINI_API_KEY: "g" });
    sdk.gemini.mockResolvedValue({ text: "ok" });
    await expect(callAIWithFallback("other" as never, "s", [], "q")).resolves.toEqual({
      response: "ok",
      usedProvider: "gemini",
    });
  });
});

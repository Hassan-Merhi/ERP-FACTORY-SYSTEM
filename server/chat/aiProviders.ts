/**
 * AI provider layer for the chat service.
 *
 * Owns the lazy provider clients (Gemini / ChatGPT / Grok), provider
 * selection from system settings, availability detection, and the
 * fallback caller. Extracted from chatService.ts to keep that module
 * focused on chat orchestration; behaviour is unchanged.
 */
import { GoogleGenAI } from "@google/genai";
import { getErrorMessage } from "../lib/httpHandlers";
import { logger } from "../lib/logger";
import OpenAI from "openai";
import { db } from "../db";
import * as schema from "@shared/schema";
import { eq } from "drizzle-orm";

// AI Provider types
export type AIProvider = "gemini" | "chatgpt" | "grok";

// Initialize AI clients lazily (only when needed)
function getGeminiClient() {
  if (!process.env.GEMINI_API_KEY) return null;
  return new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
}

function getOpenAIClient() {
  if (!process.env.OPENAI_API_KEY) return null;
  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

function getGrokClient() {
  if (!process.env.XAI_API_KEY) return null;
  return new OpenAI({
    apiKey: process.env.XAI_API_KEY,
    baseURL: "https://api.x.ai/v1",
  });
}

// Get the selected AI provider from system settings
export async function getSelectedAIProvider(): Promise<AIProvider> {
  try {
    const setting = await db
      .select({ value: schema.systemSettings.value })
      .from(schema.systemSettings)
      .where(eq(schema.systemSettings.key, "ai_provider"))
      .limit(1);

    if (setting.length > 0 && setting[0].value) {
      const provider = setting[0].value.toLowerCase() as AIProvider;
      if (["gemini", "chatgpt", "grok"].includes(provider)) {
        return provider;
      }
    }
  } catch (_error) {
    logger.info("[ChatService] Could not get AI provider setting, using default");
  }
  return "gemini"; // Default to Gemini
}

// Get available providers (those with API keys configured)
export function getAvailableProviders(): AIProvider[] {
  const available: AIProvider[] = [];
  if (process.env.GEMINI_API_KEY) available.push("gemini");
  if (process.env.OPENAI_API_KEY) available.push("chatgpt");
  if (process.env.XAI_API_KEY) available.push("grok");
  return available;
}

// Get configured providers for the settings UI (available flag per provider)
export function getConfiguredProviders(): { provider: AIProvider; available: boolean }[] {
  return [
    { provider: "gemini", available: !!process.env.GEMINI_API_KEY },
    { provider: "chatgpt", available: !!process.env.OPENAI_API_KEY },
    { provider: "grok", available: !!process.env.XAI_API_KEY },
  ];
}

// Call Gemini API
async function callGemini(
  systemPrompt: string,
  conversationHistory: { role: string; content: string }[],
  userMessage: string
): Promise<string> {
  const client = getGeminiClient();
  if (!client) throw new Error("Gemini API key not configured");

  const contents = [
    { role: "user", parts: [{ text: systemPrompt }] },
    {
      role: "model",
      parts: [
        {
          text: "I understand. I'm your ERP Assistant, ready to help you understand your business data, provide insights, and answer questions in any language. How can I help you today?",
        },
      ],
    },
    ...conversationHistory.map((msg) => ({
      role: msg.role === "user" ? "user" : "model",
      parts: [{ text: msg.content }],
    })),
    { role: "user", parts: [{ text: userMessage }] },
  ];

  const response = await client.models.generateContent({
    model: "gemini-2.0-flash",
    contents: contents,
  });

  return response.text || "I couldn't generate a response.";
}

// Call ChatGPT API
async function callChatGPT(
  systemPrompt: string,
  conversationHistory: { role: string; content: string }[],
  userMessage: string
): Promise<string> {
  const client = getOpenAIClient();
  if (!client) throw new Error("OpenAI API key not configured");

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    })),
    { role: "user", content: userMessage },
  ];

  const response = await client.chat.completions.create({
    model: "gpt-4o-mini",
    messages: messages,
    max_tokens: 2000,
  });

  return response.choices[0]?.message?.content || "I couldn't generate a response.";
}

// Call Grok API (uses OpenAI-compatible format)
async function callGrok(
  systemPrompt: string,
  conversationHistory: { role: string; content: string }[],
  userMessage: string
): Promise<string> {
  const client = getGrokClient();
  if (!client) throw new Error("xAI/Grok API key not configured");

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: systemPrompt },
    ...conversationHistory.map((msg) => ({
      role: msg.role as "user" | "assistant",
      content: msg.content,
    })),
    { role: "user", content: userMessage },
  ];

  const response = await client.chat.completions.create({
    model: "grok-2-latest",
    messages: messages,
    max_tokens: 2000,
  });

  return response.choices[0]?.message?.content || "I couldn't generate a response.";
}

// Call AI with fallback to other providers
export async function callAIWithFallback(
  provider: AIProvider,
  systemPrompt: string,
  conversationHistory: { role: string; content: string }[],
  userMessage: string
): Promise<{ response: string; usedProvider: AIProvider }> {
  const available = getAvailableProviders();

  // Build fallback order starting with selected provider
  const fallbackOrder = [provider, ...available.filter((p) => p !== provider)];

  let lastError: Error | null = null;

  for (const currentProvider of fallbackOrder) {
    if (!available.includes(currentProvider)) continue;

    try {
      logger.info(`[ChatService] Trying ${currentProvider}...`);
      let response: string;

      switch (currentProvider) {
        case "gemini":
          response = await callGemini(systemPrompt, conversationHistory, userMessage);
          break;
        case "chatgpt":
          response = await callChatGPT(systemPrompt, conversationHistory, userMessage);
          break;
        case "grok":
          response = await callGrok(systemPrompt, conversationHistory, userMessage);
          break;
        default:
          continue;
      }

      logger.info(`[ChatService] Successfully used ${currentProvider}`);
      return { response, usedProvider: currentProvider };
    } catch (error: unknown) {
      logger.error(`[ChatService] ${currentProvider} failed:`, { error: getErrorMessage(error) });
      lastError = error as Error;
      // Continue to next provider
    }
  }

  throw lastError || new Error("No AI providers available");
}

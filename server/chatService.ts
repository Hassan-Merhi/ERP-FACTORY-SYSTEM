/**
 * Chat service orchestrator.
 *
 * Coordinates the chat pipeline: intent classification → prompt selection →
 * provider selection → AI call → draft enrichment → response assembly.
 * The heavier responsibilities live in focused sibling modules:
 *   - server/chat/aiProviders.ts            provider clients, selection, fallback
 *   - server/chat/prompts.ts                system prompts and intent classification
 *   - server/chat/codeAgentContext.ts       code_read / code_edit prompts + patch parsing
 *   - server/chat/verifyContainerDraft.ts   verify-container draft lookup
 *   - server/chat/phase1DataQuery.ts        AI-classified read-only data queries
 *   - server/chat/poTextExtraction.ts       AI PO text → structured PO extraction
 *
 * Public surface is unchanged for backwards compatibility (persistence and
 * provider helpers are re-exported here as before).
 */
import { getErrorMessage, getErrorStack } from "./lib/httpHandlers";
import { logger } from "./lib/logger";
import { getSelectedAIProvider, getAvailableProviders, callAIWithFallback } from "./chat/aiProviders";
import { getCachedERPContext, type ERPContext, type UserPreferences } from "./chat/erpContext";
import { buildVoucherAndStockDrafts } from "./chat/voucherAndStockDrafts";
import { buildLookupDrafts } from "./chat/lookupDrafts";
import { buildStockTransferDrafts } from "./chat/stockTransferDrafts";
import { detectSmartProvider } from "./chat/intent";
import { tryBuildEarlyMultiSourceTargetTransfer } from "./chat/earlyMultiSourceTransfer";
import {
  buildSystemPrompt,
  generateQuickSuggestions,
  classifyChatIntent,
  buildGeneralSystemPrompt,
  buildActionSystemPrompt,
  loadToolData,
  buildToolSystemPrompt,
  ACTION_INTENTS,
  TOOL_INTENTS,
} from "./chat/prompts";
import {
  buildCodeReadPrompt,
  buildCodeEditPrompt,
  parseCodeEditResponse,
  type FilePatchDraft,
} from "./chat/codeAgentContext";
import { buildVerifyContainerDraft } from "./chat/verifyContainerDraft";
import { runPhase1DataQuery } from "./chat/phase1DataQuery";

export { getERPContext, clearERPContextCache } from "./chat/erpContext";
export { getConfiguredProviders } from "./chat/aiProviders";
export { extractPOFromText, type ExtractedPurchaseOrder } from "./chat/poTextExtraction";
export {
  saveMessage,
  getConversationHistory,
  getConversationHistoryForAI,
  getAllChatHistory,
  saveFeedback,
} from "./chat/persistence";

export async function chat(
  userMessage: string,
  companyId: number,
  conversationHistory: { role: string; content: string }[] = [],
  userPreferences?: UserPreferences,
  pageContext?: { currentRoute?: string; entityType?: string; entityId?: number; entityName?: string },
  sessionReadFiles?: string[]
): Promise<{
  response: string;
  suggestions: string[];
  provider?: string;
  voucherDraft?: unknown;
  stockAdjustmentDraft?: unknown;
  stockTransferDraft?: unknown;
  stockTransferDrafts?: unknown[];
  voucherSearchResults?: unknown[];
  stockItemDraft?: unknown;
  priceUpdateDraft?: unknown;
  accountQueryResult?: unknown;
  verifyContainerDraft?: unknown;
  dataQueryResult?: unknown;
  filePatchDrafts?: FilePatchDraft[];
  readFiles?: string[];
}> {
  const available = getAvailableProviders();

  if (available.length === 0) {
    return {
      response:
        "AI chatbot is not configured. Please ask an administrator to add at least one AI API key (GEMINI_API_KEY, OPENAI_API_KEY, or XAI_API_KEY).",
      suggestions: [],
    };
  }

  try {
    const chatStart = Date.now();

    // ── Step 1: Classify intent (pure regex, no AI call) ─────────────────
    const intent = classifyChatIntent(userMessage, pageContext);
    const isActionIntent = ACTION_INTENTS.has(intent);
    logger.info(`[ChatService] Intent: ${intent} (action=${isActionIntent})`);

    // ── Step 2: Load ERP context only when needed ─────────────────────────
    let context: ERPContext | null = null;
    let systemPrompt: string;
    let suggestions: string[];

    // Variables populated inside code_read / code_edit branches; used later in
    // the parsing block and return value.
    const codeReadFiles: string[] = []; // files read this request (all code intents)
    const codeEditOriginalMap: Record<string, string> = {}; // file → full original content

    if (intent === "general_knowledge") {
      // General knowledge: skip ERP context entirely, use open-ended ChatGPT-style prompt
      systemPrompt = buildGeneralSystemPrompt();
      suggestions = [
        "Write me a simple HTML calculator app",
        "Explain how machine learning works",
        "What's the latest in AI?",
        "Write a Python script to sort a list",
        "Help me write a professional email",
        "What are the pros and cons of React vs Vue?",
      ];
      logger.info("[ChatService] general_knowledge intent — skipping ERP context");
    } else if (intent === "code_read") {
      const codeRead = await buildCodeReadPrompt(userMessage, codeReadFiles);
      systemPrompt = codeRead.systemPrompt;
      suggestions = codeRead.suggestions;
    } else if (intent === "code_edit") {
      const codeEdit = await buildCodeEditPrompt(userMessage, sessionReadFiles, codeReadFiles, codeEditOriginalMap);
      systemPrompt = codeEdit.systemPrompt;
      suggestions = codeEdit.suggestions;
    } else if (isActionIntent) {
      // Action intents: skip the expensive full-context load, use a light prompt
      systemPrompt = buildActionSystemPrompt(intent, pageContext);
      suggestions = [];
      logger.info("[ChatService] Skipping getERPContext for action intent");
    } else if (TOOL_INTENTS.has(intent)) {
      // Tool intents: targeted DB queries, no full ERP context
      const toolStart = Date.now();
      const toolData = await loadToolData(intent, companyId, userMessage);
      logger.info(`[ChatService] Tool data loaded in ${Date.now() - toolStart}ms for intent "${intent}"`);
      systemPrompt = buildToolSystemPrompt(intent, toolData, pageContext);
      suggestions = [];
    } else {
      // General / unclassified: load full cached ERP context
      const ctxStart = Date.now();
      context = await getCachedERPContext(companyId);
      logger.info(`[ChatService] Context ready in ${Date.now() - ctxStart}ms (company ${companyId})`);
      systemPrompt = buildSystemPrompt(context, userPreferences);
      suggestions = generateQuickSuggestions(context);

      // Inject page context into full-context prompt
      if (pageContext?.currentRoute) {
        const pageLines: string[] = [`\n## CURRENT PAGE CONTEXT:`];
        pageLines.push(`- User is currently on route: ${pageContext.currentRoute}`);
        if (pageContext.entityType) pageLines.push(`- Viewing entity type: ${pageContext.entityType}`);
        if (pageContext.entityName) pageLines.push(`- Entity name: ${pageContext.entityName}`);
        if (pageContext.entityId) pageLines.push(`- Entity ID: ${pageContext.entityId}`);
        pageLines.push(
          `Use this context to give more relevant and specific answers (e.g. if they are on the vouchers page, answers about vouchers should be especially specific).`
        );
        systemPrompt = systemPrompt + pageLines.join("\n");
      }
    }

    // Get selected provider; smart-route if the question type has a best-fit AI
    const adminProvider = await getSelectedAIProvider();
    const smartOverride = detectSmartProvider(userMessage, available);
    const selectedProvider = smartOverride ?? adminProvider;
    logger.info(
      `[ChatService] Provider: ${selectedProvider} (smart=${smartOverride ?? "none"}, admin=${adminProvider}), Available: ${available.join(", ")}`
    );

    // ── Early hard-return: deterministic multi-source, target-quantity stock
    // transfer route. Must run BEFORE the generic AI call (and therefore
    // before voucher extraction, account query, and Phase1 data query, which
    // all run after it in the normal flow) — otherwise generic AI text or a
    // stray extraction pass can hijack a fully deterministic stock-transfer
    // request. Returns null (falls through to normal flow) when the message
    // isn't this kind of request, or when it is but the deterministic parser
    // can't confidently resolve it (legacy LLM-assisted extraction handles
    // that case further down).
    const earlyMultiSourceTransfer = await tryBuildEarlyMultiSourceTargetTransfer(
      companyId,
      userMessage,
      suggestions,
      selectedProvider
    );
    if (earlyMultiSourceTransfer) {
      logger.info(
        `[ChatService] Early deterministic multi-source stock-transfer route handled request; hard-returning.`
      );
      return earlyMultiSourceTransfer;
    }

    const aiStart = Date.now();
    const { response, usedProvider } = await callAIWithFallback(
      selectedProvider,
      systemPrompt,
      conversationHistory,
      userMessage
    );
    logger.info(`[ChatService] AI call (${usedProvider}) took ${Date.now() - aiStart}ms`);

    // ── Code Edit: parse filePatchDrafts (single or multi-file) from AI JSON ──
    let filePatchDrafts: FilePatchDraft[] | undefined = undefined;
    let finalResponse = response;

    if (intent === "code_edit") {
      const codeEditResponse = parseCodeEditResponse(response, codeEditOriginalMap);
      filePatchDrafts = codeEditResponse.filePatchDrafts;
      finalResponse = codeEditResponse.finalResponse;
    }

    const { voucherDraft, stockAdjustmentDraft } = await buildVoucherAndStockDrafts({
      userMessage,
      companyId,
      selectedProvider,
      intent,
    });

    const { voucherSearchResults, stockItemDraft, priceUpdateDraft, accountQueryResult } = await buildLookupDrafts({
      userMessage,
      companyId,
      selectedProvider,
    });

    const { stockTransferDraft, stockTransferDrafts, stockTransferResponseOverride } = await buildStockTransferDrafts({
      userMessage,
      companyId,
      selectedProvider,
      voucherDraft,
      stockAdjustmentDraft,
    });
    if (stockTransferResponseOverride) finalResponse = stockTransferResponseOverride;

    // ── Verify Container Excel detection ──────────────────────────────
    const verifyContainerDraft = await buildVerifyContainerDraft(userMessage, companyId);

    // ── Phase 1: Data Query Handler ───────────────────────────────────────
    // Handles read-only ERP data queries: P&L, cash position, statements, etc.
    // Skipped when a higher-priority draft already handled the message.
    const dataQueryResult = await runPhase1DataQuery({
      userMessage,
      companyId,
      selectedProvider,
      skip: !!(
        voucherDraft ||
        stockAdjustmentDraft ||
        stockTransferDraft ||
        stockTransferDrafts ||
        stockTransferResponseOverride
      ),
    });

    logger.info(`[ChatService] Total chat time: ${Date.now() - chatStart}ms`);
    return {
      response: finalResponse,
      suggestions,
      provider: usedProvider,
      voucherDraft,
      stockAdjustmentDraft,
      stockTransferDraft,
      stockTransferDrafts: stockTransferDrafts && stockTransferDrafts.length > 0 ? stockTransferDrafts : undefined,
      voucherSearchResults,
      stockItemDraft,
      priceUpdateDraft,
      accountQueryResult,
      verifyContainerDraft,
      dataQueryResult,
      filePatchDrafts: filePatchDrafts && filePatchDrafts.length > 0 ? filePatchDrafts : undefined,
      readFiles: codeReadFiles.length > 0 ? codeReadFiles : undefined,
    };
  } catch (error: unknown) {
    logger.error("[ChatService] ERROR:", { error: getErrorMessage(error) });
    logger.error("[ChatService] Stack:", { error: getErrorStack(error) });
    if (
      getErrorMessage(error)?.includes("API_KEY") ||
      getErrorMessage(error)?.includes("API key") ||
      getErrorMessage(error)?.includes("not configured")
    ) {
      return {
        response: "Invalid or missing API key. Please check your AI provider configuration in Settings.",
        suggestions: [],
      };
    }
    if (
      getErrorMessage(error)?.includes("quota") ||
      getErrorMessage(error)?.includes("rate limit") ||
      getErrorMessage(error)?.includes("429")
    ) {
      const available = getAvailableProviders();
      return {
        response: `API quota exceeded. ${available.length > 1 ? "Trying fallback providers also failed. " : ""}Please try again later or add additional AI provider keys in your environment.`,
        suggestions: [],
      };
    }
    // Catch-all: return a friendly inline error so the route always returns 200
    return {
      response: `Sorry, something went wrong while processing your request. (${getErrorMessage(error) || "Unknown error"})`,
      suggestions: [],
    };
  }
}

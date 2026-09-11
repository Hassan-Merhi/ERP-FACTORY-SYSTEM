import { db } from "./db";
import { getErrorMessage, getErrorStack } from "./lib/httpHandlers";
import { logger } from "./lib/logger";
import * as schema from "@shared/schema";
import {
  readProjectFile,
  grepProjectFiles,
  listProjectDir,
  extractFilePathsFromMessage,
  extractSearchPattern,
  readProjectFileRaw,
  resolveFilePath,
} from "./lib/codeAgentTools";
import { eq, and, desc, ilike } from "drizzle-orm";

import { type AIProvider, getSelectedAIProvider, getAvailableProviders, callAIWithFallback } from "./chat/aiProviders";

import { runDataQuery } from "./chat/reports";
import { buildVoucherAndStockDrafts } from "./chat/voucherAndStockDrafts";
import { buildLookupDrafts } from "./chat/lookupDrafts";
import { buildStockTransferDrafts } from "./chat/stockTransferDrafts";

import { detectSmartProvider } from "./chat/intent";

import { tryBuildEarlyMultiSourceTargetTransfer } from "./chat/earlyMultiSourceTransfer";

import { getCachedERPContext, type ERPContext, type UserPreferences } from "./chat/erpContext";
export { getERPContext, clearERPContextCache } from "./chat/erpContext";

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

/** One file change proposed by the AI in a code_edit response. */
interface FilePatchDraft {
  filePath: string;
  description: string;
  originalContent: string;
  newContent: string;
}

/** Raw AI patch payload fields, as best-guess parsed from model JSON. */
interface CodePatchPayload {
  description?: string;
  filePath?: string;
  originalContent?: string;
  newContent?: string;
  patches?: Array<{
    filePath?: string;
    description?: string;
    originalContent?: string;
    newContent?: string;
  }>;
}

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
      // ── Code Read: read project files or grep, inject into system prompt ──────
      const filePaths = extractFilePathsFromMessage(userMessage);
      let codeContext = "";

      if (filePaths.length > 0) {
        for (const raw of filePaths.slice(0, 3)) {
          // Resolve bare filenames (e.g. "chatService.ts") to full workspace-relative paths
          const fp = resolveFilePath(raw) ?? raw;
          try {
            const { content, totalLines, truncated } = await readProjectFile(fp);
            codeContext += `\n\n**File: ${fp}** (${totalLines} lines${truncated ? `, first 300 shown` : ""})\n\`\`\`typescript\n${content}\n\`\`\``;
            if (!codeReadFiles.includes(fp)) codeReadFiles.push(fp);
          } catch (_err: unknown) {
            // Still not found — fall back to grep by base name
            const basename = fp.replace(/.*\//, "").replace(/\.\w+$/, "");
            const grepResult = await grepProjectFiles(basename, ".").catch(() => "(not found)");
            codeContext += `\n\n**File ${fp} not found. Grep results for \`${basename}\`:**\n\`\`\`\n${grepResult}\n\`\`\``;
          }
        }
      } else {
        // No file paths — try grep for keywords
        const pattern = extractSearchPattern(userMessage);
        if (pattern) {
          try {
            const grepResult = await grepProjectFiles(pattern, ".");
            codeContext = `\n\n**Search results for \`${pattern}\`:**\n\`\`\`\n${grepResult}\n\`\`\``;
          } catch (err: unknown) {
            codeContext = `\n\n**Search error:** ${(err as Error).message}`;
          }
        } else if (/\b(?:list files|ls\b|what files|directory)\b/i.test(userMessage)) {
          const dirMatch = userMessage.match(/\b(server|client|shared|scripts)\/[\w./+-]*/);
          const dir = dirMatch ? dirMatch[0] : ".";
          try {
            const entries = await listProjectDir(dir);
            codeContext = `\n\n**Directory listing for \`${dir}\`:**\n${entries.join("\n")}`;
          } catch (err: unknown) {
            codeContext = `\n\n**Listing error:** ${(err as Error).message}`;
          }
        }
      }

      systemPrompt = `You are a coding assistant with access to this TypeScript ERP/POS project (React + Express + PostgreSQL). Answer the user's question clearly and concisely about the code.${codeContext}\n\nIf you reference specific parts of the code, use code blocks with the language specified.`;
      suggestions = ["Explain how this works", "Find related files", "Show me all usages"];
      logger.info("[ChatService] code_read intent — loaded file/grep context");
    } else if (intent === "code_edit") {
      // ── Code Edit: load files and build structured output prompt ──────────────
      // Support up to 3 explicitly-named files; fall back to keyword grep for pathless edits.
      const rawPaths = extractFilePathsFromMessage(userMessage);
      const resolvedPaths = rawPaths
        .slice(0, 3)
        .map((p) => resolveFilePath(p) ?? p)
        .filter(Boolean);

      const contentBlocks: string[] = [];

      // Read each explicitly-named file
      for (const fp of resolvedPaths) {
        const alreadyInSession = sessionReadFiles?.includes(fp);
        try {
          const { content, totalLines, truncated } = await readProjectFile(fp);
          const raw = await readProjectFileRaw(fp).catch(() => "");
          codeEditOriginalMap[fp] = raw;
          if (!codeReadFiles.includes(fp)) codeReadFiles.push(fp);
          const note = alreadyInSession ? " *(also seen earlier this session)*" : "";
          contentBlocks.push(
            `Current content of \`${fp}\`${note} (${totalLines} lines${truncated ? ", first 300 shown" : ""}):\n\`\`\`typescript\n${content}\n\`\`\``
          );
          logger.info(`[ChatService] code_edit — read ${fp} (${totalLines} lines${truncated ? ", truncated" : ""})`);
        } catch {
          contentBlocks.push(`File \`${fp}\` does not exist yet — you will be creating it.`);
          if (!codeReadFiles.includes(fp)) codeReadFiles.push(fp);
        }
      }

      // Pathless edit: infer candidate file by grepping message keywords
      if (resolvedPaths.length === 0) {
        const keywords = [
          ...new Set(
            (
              (userMessage.match(
                /\b[A-Z][a-zA-Z]{3,}\b|\b[a-z]{4,}(?:Form|Page|Component|Hook|Route|Schema|Type|Service|Helper|Utils?)\b/g
              ) ?? []) as string[]
            ).concat(
              (userMessage.match(
                /\b(?:voucher|invoice|payment|receipt|stock|pos|purchase|sale|customer|supplier|company|user|auth|chat)\b/gi
              ) ?? []) as string[]
            )
          ),
        ].slice(0, 4);

        let grepResults = "";
        for (const kw of keywords) {
          const result = await grepProjectFiles(kw, "client/src").catch(() => "");
          if (result && result !== "(no matches found)") {
            grepResults += result + "\n";
            break;
          }
        }
        const candidatePaths = [
          ...new Set((grepResults.match(/^([\w/.-]+\.(?:tsx?|jsx?)):/gm) ?? []).map((l) => l.replace(/:$/, ""))),
        ].slice(0, 1);

        for (const fp of candidatePaths) {
          const alreadyInSession = sessionReadFiles?.includes(fp);
          try {
            const { content, totalLines, truncated } = await readProjectFile(fp);
            const raw = await readProjectFileRaw(fp).catch(() => "");
            codeEditOriginalMap[fp] = raw;
            if (!codeReadFiles.includes(fp)) codeReadFiles.push(fp);
            const note = alreadyInSession ? " *(also seen earlier this session)*" : "";
            contentBlocks.push(
              `Current content of \`${fp}\`${note} (${totalLines} lines${truncated ? ", first 300 shown" : ""}):\n\`\`\`typescript\n${content}\n\`\`\``
            );
            logger.info(
              `[ChatService] code_edit (pathless) — inferred ${fp} (${totalLines} lines${truncated ? ", truncated" : ""})`
            );
          } catch {
            /* File might not exist */
          }
        }

        if (candidatePaths.length === 0) {
          contentBlocks.push(
            `No specific file was found. Infer the best file to create or edit and set filePath accordingly.`
          );
        }
      }

      const _primaryFilePath = resolvedPaths[0] ?? codeReadFiles[0] ?? "path/to/file.ts";
      const contentSection = contentBlocks.length > 0 ? "\n\n" + contentBlocks.join("\n\n") : "";

      systemPrompt = `You are a senior TypeScript engineer on this ERP/POS project (React 18 + Express + Drizzle ORM + shadcn/ui). You MUST respond with ONLY a valid JSON object — no markdown, no explanation, ONLY raw JSON.

User request: "${userMessage}"${contentSection}

Respond with ONLY JSON in ONE of these two formats:

Single file change:
{"filePath":"...","description":"one-sentence summary","originalContent":"(the exact current file content shown above, or empty string for new files)","newContent":"the complete new file content"}

Multiple file changes (only when edits span more than one file):
{"description":"one-sentence summary of all changes","patches":[{"filePath":"...","description":"...","originalContent":"...","newContent":"..."},...]}

Rules:
- "newContent" must be the COMPLETE file — every line, not just the changed parts
- Preserve all existing imports, exports, and functionality unless explicitly asked to remove something
- Match the existing coding style, indentation (2 spaces), and TypeScript patterns exactly
- If creating a new file, "originalContent" must be ""
- Never truncate newContent — output the entire file even if it is long
- "originalContent" in each patch MUST exactly match what was shown above (required for stale-guard validation)
- Use the multi-file format ONLY when the change genuinely requires editing more than one file`;

      suggestions = ["Apply this change", "Show me the diff", "Explain what changed"];
      logger.info(`[ChatService] code_edit intent — targets: ${codeReadFiles.join(", ") || "(inferred)"}`);
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
      try {
        const raw = response
          .trim()
          .replace(/^```(?:json)?\n?/, "")
          .replace(/\n?```$/, "")
          .trim();
        if (raw.startsWith("{")) {
          const parsed: CodePatchPayload = JSON.parse(raw);
          if (parsed && Array.isArray(parsed.patches) && parsed.patches.length > 0) {
            // Multi-file patches
            filePatchDrafts = parsed.patches
              .filter((p) => p.filePath && "newContent" in p)
              .map((p) => ({
                filePath: p.filePath as string,
                description: p.description || parsed.description || "Apply code changes",
                originalContent: p.originalContent ?? codeEditOriginalMap[p.filePath as string] ?? "",
                newContent: p.newContent ?? "",
              }));
            if (filePatchDrafts && filePatchDrafts.length > 0) {
              const fileList = filePatchDrafts.map((p) => `- \`${p.filePath}\``).join("\n");
              finalResponse = `I've prepared changes for **${filePatchDrafts.length} file${filePatchDrafts.length > 1 ? "s" : ""}**.\n\n${parsed.description || "Review the diffs below."}\n\n${fileList}\n\nClick **Apply** on each diff, or **Apply All** to write all changes at once.`;
            }
          } else if (parsed && parsed.filePath && "newContent" in parsed) {
            // Single file patch
            filePatchDrafts = [
              {
                filePath: parsed.filePath,
                description: parsed.description || "Apply code changes",
                originalContent: parsed.originalContent ?? codeEditOriginalMap[parsed.filePath] ?? "",
                newContent: parsed.newContent ?? "",
              },
            ];
            finalResponse = `I've prepared the changes for **\`${parsed.filePath}\`**.\n\n${parsed.description || "Review the diff below and click Apply when you're ready."}\n\nClick **Apply** to write the changes to disk, or **Cancel** to discard.`;
          }
        }
      } catch {
        // AI responded with explanation text — leave finalResponse as-is
      }
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
    const VERIFY_CONTAINER_KEYWORDS =
      /\b(verif(y|ication)|container\s+verif|verif.*container|verification\s+excel|excel.*verif|download.*verif|container.*excel)\b/i;
    let verifyContainerDraft = undefined;

    if (VERIFY_CONTAINER_KEYWORDS.test(userMessage)) {
      try {
        // Try to extract a container number from the message
        const containerNumMatch =
          userMessage.match(/container\s+(?:no\.?\s*|number\s+|#\s*)?["']?([A-Z0-9][A-Z0-9\-/]{3,25})["']?/i) ||
          userMessage.match(/\b([A-Z]{4}\d{6,7})\b/) ||
          userMessage.match(/\bfor\s+["']?([A-Z0-9][A-Z0-9-]{4,20})["']?\s*(?:$|\s)/i);

        const containerNumber = containerNumMatch ? containerNumMatch[1].toUpperCase() : null;

        if (containerNumber) {
          const [container] = await db
            .select({
              id: schema.containers.id,
              containerNumber: schema.containers.containerNumber,
              supplierId: schema.containers.supplierId,
            })
            .from(schema.containers)
            .where(
              and(eq(schema.containers.companyId, companyId), ilike(schema.containers.containerNumber, containerNumber))
            )
            .limit(1);

          if (container) {
            const [proformas, supplierRow] = await Promise.all([
              db
                .select({ id: schema.supplierProformas.id, reference: schema.supplierProformas.reference })
                .from(schema.supplierProformas)
                .where(
                  and(
                    eq(schema.supplierProformas.companyId, companyId),
                    eq(schema.supplierProformas.supplierId, container.supplierId)
                  )
                )
                .orderBy(desc(schema.supplierProformas.createdAt)),
              db
                .select({ name: schema.suppliers.legalName })
                .from(schema.suppliers)
                .where(eq(schema.suppliers.id, container.supplierId))
                .limit(1),
            ]);

            verifyContainerDraft = {
              containerNumber: container.containerNumber,
              containerId: container.id,
              supplierId: container.supplierId,
              supplierName: supplierRow[0]?.name || "",
              proformas,
            };
          }
        }
      } catch (_) {
        // Failed silently
      }
    }

    // ── Phase 1: Data Query Handler ───────────────────────────────────────────
    // Handles read-only ERP data queries: P&L, cash position, statements, etc.
    const PHASE1_KEYWORDS =
      /profit.{0,15}loss|p&l\b|pl\b.{0,10}report|balance.{0,8}sheet|cash.{0,12}(balance|position|account)|who.{0,20}owe[ds]?|overdue|outstanding.{0,15}(balance|amount|supplier)|customer.{0,15}statement|supplier.{0,15}statement|top.{0,10}(customer|buyer)s?|worker.{0,12}attend|how many.{0,20}(absent|present|worker)|bale.{0,12}(produc|today|week|this|last)|produc.{0,12}bale|how many bale|container.{0,12}status|where.{0,12}(is.{0,5})?container|pending.{0,10}offload|not.{0,10}offload|how much.{0,20}(stock|do we have|in stock)|stock.{0,10}(level|balance|position)|inventory.{0,10}(level|check|status)|low.{0,10}stock|below.{0,10}reorder|reorder.{0,10}level|stock.{0,10}movement|stock.{0,10}histor|movement.{0,10}(for|of).{0,20}\w|open.{0,10}(purchase order|po\b|p\.o\.)|pending.{0,10}(po\b|purchase)|aging|age.{0,10}(report|analysis)|receivable|payable.{0,10}(aging|due)|container.{0,10}list|all container|month.{0,10}(comparison|vs|versus|compare)|last month vs|rental.{0,10}(summary|report|occupan)|occupan|tenant|rent.{0,10}(due|overdue|collect)|payroll.{0,10}(summary|total|report)|total.{0,10}payroll|salary.{0,10}(total|summary)|sales.{0,10}(analys|by item|report|revenue)|how much.{0,15}(did we sell|sold)|top.{0,10}(sell|item|product)|best.{0,10}(sell|item)|container.{0,10}profit|profit.{0,10}per container|how much.{0,15}profit.{0,15}container|stock.{0,10}valuat|inventory.{0,10}value|total.{0,10}inventory.{0,10}(value|worth)|expense.{0,10}(break|categ|by type)|top.{0,10}expense|where.{0,20}money.{0,10}(going|spent)|customer.{0,10}order.{0,10}status|order.{0,10}(pending|draft|verified|finalized|loading)|credit.{0,10}note|recent.{0,10}credit|bank.{0,10}(transaction|movement|histor)|cash.{0,10}(transaction|movement|histor)|recent.{0,10}(payment|receipt|bank)|fixed.{0,10}asset|asset.{0,10}(list|register|summar)|kpi|factory.{0,10}(kpi|performance|daily)|daily.{0,10}(production|output)|efficiency|pos.{0,10}(sale|revenue|summary)|point.{0,10}of.{0,10}sale|shop.{0,10}sale|intercompany|inter.{0,10}company.{0,10}transfer|money.{0,10}(moved|transferred).{0,15}between|offload.{0,10}detail|what.{0,15}(was|were).{0,10}offload|what.{0,10}(arrive|came).{0,15}(in|container)|worker.{0,10}(product|rank|top|best)|top.{0,10}worker|best.{0,10}worker|supplier.{0,10}(spend|history|bought|purchase.{0,10}from)|how much.{0,15}(bought|spend).{0,10}(from|supplier)|upcoming.{0,10}(arrival|container|shipment)|container.{0,10}(arriving|due|expected)|waste.{0,10}(analys|report|trend|summary)|factory.{0,10}waste|customer.{0,10}(payment.{0,10}histor|paid|receipt)|when.{0,10}did.{0,15}pay|voucher.{0,10}(summary|count|by type|breakdown)|how many.{0,10}voucher|stock.{0,10}by.{0,10}location|per.{0,10}location.{0,10}stock|location.{0,10}stock|trial.{0,5}balance|all.{0,10}account.{0,10}balance|balance.{0,10}(of all|per account)|po.{0,10}(detail|line|item)|purchase.{0,10}order.{0,10}(detail|items|break)|what.{0,10}(is|was).{0,10}in.{0,10}(the.{0,5})?po|container.{0,10}(cost|charge|break)|cost.{0,10}break.{0,10}(of|for).{0,10}container|document.{0,10}expir|visa.{0,10}expir|permit.{0,10}expir|worker.{0,10}(doc|expir)|stock.{0,10}transfer|transfer.{0,10}(between|from.{0,10}to).{0,10}(location|warehouse)|move.{0,10}stock|cash.{0,10}flow|money.{0,10}(in|out).{0,10}(this|last|for)|inflow.{0,10}outflow|account.{0,10}(movement|ledger|balance.{0,10}for)|ledger.{0,10}(balance|statement|for)|transaction.{0,10}(of|for).{0,10}account|day.{0,10}(summary|report|sales)|today.{0,10}(sales|voucher)|sale.{0,10}today|profit.{0,10}(by|per).{0,10}location|location.{0,10}profit|which.{0,10}location.{0,10}(most|best)|debit.{0,10}note|supplier.{0,10}debit|customer.{0,10}list|list.{0,10}(of.{0,5})?customer|all.{0,10}customer|supplier.{0,10}list|list.{0,10}(of.{0,5})?supplier|all.{0,10}supplier|stock.{0,10}item.{0,10}(detail|info|profile)|item.{0,10}(detail|info|profile).{0,10}(for|of)|what.{0,10}(is|are).{0,5}(the.{0,5})?details.{0,10}(of|for).{0,10}item|mix.{0,10}batch|batch.{0,10}(list|status|summary)|material.{0,10}batch|customer.{0,10}proforma|price.{0,10}list.{0,10}(for.{0,5})?customer|proforma.{0,10}(for|customer)|supplier.{0,10}proforma|price.{0,10}(list|sheet).{0,10}(from|supplier)|weekly.{0,10}(sale|revenue|breakdown)|sale.{0,10}(by week|per week|week.{0,5}by.{0,5}week)|container.{0,10}(items|content|loaded|what.{0,10}inside)|what.{0,10}(is|are|was).{0,10}(in|inside|loaded).{0,5}container|employee.{0,10}(list|roster|staff)|all.{0,10}(employee|staff)|staff.{0,10}list|journal.{0,10}(entry|entries|voucher)|recent.{0,10}journal|journal.{0,10}posting|audit.{0,10}(log|trail|history)|who.{0,10}(created|deleted|changed|modified|updated)|recent.{0,10}change|bank.{0,10}account.{0,10}(list|balance|all)|all.{0,10}bank|list.{0,10}(of.{0,5})?bank|stock.{0,10}adjust|production.{0,10}(stock|entry|voucher)|consumption.{0,10}(stock|entry)|tracking.{0,10}(event|update|histor)|container.{0,10}tracking|where.{0,10}(is|was).{0,15}container|shipment.{0,10}update|pending.{0,10}(container.{0,10}sale|payment.{0,10}container)|unpaid.{0,10}container|outstanding.{0,10}container|container.{0,10}(unpaid|pending.{0,10}payment)|supplier.{0,10}container|containers.{0,10}(from|by).{0,10}supplier|how many.{0,10}container.{0,10}(from|supplier)|income.{0,10}(break|categ|by type)|revenue.{0,10}(break|by account)|top.{0,10}income.{0,10}account|worker.{0,10}(profile|detail|info)|info.{0,10}(about|for|on).{0,15}worker|who.{0,10}is.{0,10}worker|location.{0,10}(list|all)|all.{0,10}(location|warehouse)|list.{0,10}(of.{0,5})?location|quarterly|quarter.{0,10}(comparison|breakdown|vs)|q[1-4].{0,10}(vs|comparison|revenue)/i;
    let dataQueryResult = undefined;

    if (
      PHASE1_KEYWORDS.test(userMessage) &&
      !voucherDraft &&
      !stockAdjustmentDraft &&
      !stockTransferDraft &&
      !stockTransferDrafts &&
      !stockTransferResponseOverride
    ) {
      try {
        const todayDate = new Date();
        const todayStr = todayDate.toISOString().slice(0, 10);
        const yesterdayStr = new Date(todayDate.getTime() - 86400000).toISOString().slice(0, 10);
        const thisMonthStart = new Date(todayDate.getFullYear(), todayDate.getMonth(), 1).toISOString().slice(0, 10);
        const lastMonthStart = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1)
          .toISOString()
          .slice(0, 10);
        const lastMonthEnd = new Date(todayDate.getFullYear(), todayDate.getMonth(), 0).toISOString().slice(0, 10);
        const last30Days = new Date(todayDate.getTime() - 30 * 86400000).toISOString().slice(0, 10);
        const dayOfWeek = todayDate.getDay();
        const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
        const thisWeekStart = new Date(todayDate.getTime() + mondayOffset * 86400000).toISOString().slice(0, 10);
        const lastWeekStart = new Date(todayDate.getTime() + (mondayOffset - 7) * 86400000).toISOString().slice(0, 10);
        const lastWeekEnd = new Date(todayDate.getTime() + (mondayOffset - 1) * 86400000).toISOString().slice(0, 10);

        const phase1Prompt = `ERP data query classifier. Classify the user's intent and extract parameters. Output ONLY valid JSON, no markdown.
User message: "${userMessage}"
Today: ${todayStr} | Yesterday: ${yesterdayStr}
This week: ${thisWeekStart} to ${todayStr} | Last week: ${lastWeekStart} to ${lastWeekEnd}
This month: ${thisMonthStart} to ${todayStr} | Last month: ${lastMonthStart} to ${lastMonthEnd}
Last 30 days: ${last30Days} to ${todayStr}

Query types:
pl_summary = P&L / profit & loss / income statement for a period
cash_position = current cash and bank account balances
overdue_payments = customers/accounts that owe money (outstanding receivables)
customer_statement = recent transactions for a specific named customer
supplier_statement = recent transactions for a specific named supplier
top_customers = top customers by revenue/receipts for a period
outstanding_suppliers = suppliers with the largest balances owed to them
worker_attendance = worker attendance summary (present/absent) for a date range
bale_production = factory bale production stats for a date range
container_status = status of a specific container by its number
containers_pending_offload = containers that have arrived but not been offloaded yet
inventory_check = stock quantity/levels for a specific item name (or all items if none named)
low_stock_items = items whose current stock is below their reorder level
stock_movement = recent stock adjustments or transfers for a named item
open_purchase_orders = open/pending purchase orders, optionally filtered by supplier name
customer_aging = receivables aging analysis (buckets: 0-30, 31-60, 61-90, 90+ days)
supplier_aging = payables aging analysis (buckets: 0-30, 31-60, 61-90, 90+ days)
container_list = list containers filtered by status (e.g. "In Transit", "Arrived", "Offloaded") or date range
monthly_comparison = compare this month vs last month for revenue / expenses / net profit
rental_summary = rental occupancy, rent due and overdue amounts across all units
payroll_summary = factory payroll totals for a date range
sales_analysis = sales revenue and profit by stock item for a period
top_selling_items = top items ranked by sales quantity or revenue
container_profitability = profit analysis per container (cost vs sale price)
stock_valuation = total inventory value grouped by stock group/category
expense_breakdown = top expense accounts ranked by total spend for a period
customer_order_status = customer orders filtered by status (DRAFT/LOADING/VERIFIED/FINALIZED/CANCELLED)
credit_notes_summary = recent credit notes issued (returns/reversals)
bank_transactions = recent transactions on a specific bank or cash account
fixed_assets_summary = list of fixed assets with purchase amounts and categories
factory_kpi = factory daily KPI snapshots (kg input, kg pressed, bales produced, waste)
pos_sales_summary = POS register sales totals by product or overall for a period
intercompany_transfers = inter-company money transfer history between entities
container_offload_details = detailed breakdown of stock items offloaded from a specific container
worker_productivity = factory worker productivity ranking by bales produced or kg pressed
supplier_spend = total purchase spend per supplier ranked by amount
upcoming_arrivals = containers currently in transit with ETA in the next N days
factory_waste_analysis = factory waste entries analysis by type/date range
customer_payment_history = recent receipts and payments received from customers (named or all)
voucher_type_summary = count and total amounts grouped by voucher type for a period
location_stock_summary = inventory stock totals (items, qty, value) grouped per warehouse location
trial_balance = all ledger accounts with net debit/credit balances for a period
purchase_order_detail = line items and charges for a specific PO number (requires containerNumber or entityName as PO number)
container_cost_breakdown = full cost breakdown (items, freight, surcharge, charges) for a named container
worker_document_expiry = factory workers whose visa, work permit, or residential permit expires within 60 days
stock_transfers = recent stock transfer vouchers showing items moved between locations
cash_flow_summary = total cash/bank inflows vs outflows for a period
ledger_account_balance = all debit/credit transactions for a specific named ledger account
daily_report = all vouchers (every type) posted on a specific date — use dateFrom as the target date
profit_by_location = sales profit grouped by warehouse/location for a period
debit_note_summary = recent debit notes issued (supplier charge-backs or purchase corrections)
customer_list = all customers with their current outstanding balance and contact info
supplier_list = all suppliers with total PO amounts and contact info
stock_item_detail = detailed profile of a named stock item including qty per location
factory_mix_batches = list of factory material mix batches with status and usage
customer_proformas = customer price lists/proformas with item prices and quantities
supplier_proformas = supplier proformas/price sheets with item barcodes and prices
weekly_sales = sales revenue and profit broken down by calendar week for a period
container_items_list = stock items loaded in a specific container (from PO line items)
employee_list = ERP employee roster with salary, balance and department info
journal_entries = recent journal vouchers posted with their account debit/credit entries
audit_trail = recent audit log showing who created, updated, or deleted records
bank_account_list = all registered bank and cash accounts with current balances
stock_adjustments = recent production or consumption stock adjustment vouchers
container_tracking = tracking events and location history for a specific container
pending_container_sales = container sales that are unpaid or partially paid
supplier_container_history = all containers received from a specific named supplier
income_breakdown = top income/revenue accounts ranked by net amount earned
factory_worker_profile = full profile details for a specific named factory worker
location_list = all registered warehouse/location details with stock item counts
quarterly_comparison = revenue, cost, and profit broken down by quarter for the year

Output this JSON shape:
{"queryType":"<one of the above>","entityName":<string or null>,"containerNumber":<string or null>,"locationName":<string or null>,"containerStatus":<string or null>,"dateFrom":<YYYY-MM-DD or null>,"dateTo":"${todayStr}","limit":10}

Field notes:
- entityName: customer/supplier/item/worker name mentioned in the query
- locationName: warehouse or location name mentioned
- containerStatus: one of "In Transit" | "Arrived" | "Offloaded" | null
Date rules: use provided ranges above. Default to last 30 days for financial, today for attendance/production if no date given.
If the intent does not match any type, output: null`;

        const phase1Res = await callAIWithFallback(selectedProvider, phase1Prompt, [], "Classify Phase1 query");
        const rawP1 = phase1Res.response
          .trim()
          .replace(/```json\n?|```/g, "")
          .trim();

        if (rawP1 !== "null" && rawP1.startsWith("{")) {
          const params = JSON.parse(rawP1);
          if (params && params.queryType) {
            const dateFrom: string = params.dateFrom || last30Days;
            const dateTo: string = params.dateTo || todayStr;
            const rowLimit: number = Math.min(params.limit || 10, 50);
            const fmt = (n: number) =>
              n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
            const fmtDec = (n: number) =>
              n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

            dataQueryResult = await runDataQuery({
              companyId,
              params,
              dateFrom,
              dateTo,
              todayStr,
              todayDate,
              thisMonthStart,
              lastMonthStart,
              lastMonthEnd,
              rowLimit,
              userMessage,
              fmt,
              fmtDec,
            });
          }
        }
      } catch (_p1err) {
        // Phase 1 query failed silently — chat text response still returned
      }
    }

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

// Export function to get available providers for the settings UI
export function getConfiguredProviders(): { provider: AIProvider; available: boolean }[] {
  return [
    { provider: "gemini", available: !!process.env.GEMINI_API_KEY },
    { provider: "chatgpt", available: !!process.env.OPENAI_API_KEY },
    { provider: "grok", available: !!process.env.XAI_API_KEY },
  ];
}

export {
  saveMessage,
  getConversationHistory,
  getConversationHistoryForAI,
  getAllChatHistory,
  saveFeedback,
} from "./chat/persistence";

// ── AI-powered PO text extraction ────────────────────────────────────
// Used by the PO file import feature to parse any text content (PDF, CSV, Excel raw text)
// into a structured PO object regardless of layout or column names.
export async function extractPOFromText(rawText: string): Promise<{
  poNumber: string;
  containerNumber: string;
  supplierName: string;
  supplierCode: string;
  importDate: string;
  currency: string;
  items: { name: string; code: string; quantity: number; rate: number }[];
  freight: number;
  surcharge: number;
  fumigation: number;
  documentCharges: number;
  discount: number;
  otherCharges: number;
} | null> {
  const available = getAvailableProviders();
  if (!available.length) return null;

  const today = new Date().toISOString().split("T")[0];
  const systemPrompt = `You are a data extraction assistant. Extract purchase order data from the provided text and return ONLY valid JSON with no markdown, no explanation.

Required JSON structure:
{
  "poNumber": "string (PO/invoice number, or empty if not found)",
  "containerNumber": "string (container/shipment number, or empty if not found)",
  "supplierName": "string (supplier/vendor name, or empty)",
  "supplierCode": "string (supplier code, or empty)",
  "importDate": "string (YYYY-MM-DD format, use ${today} if not found)",
  "currency": "string (USD, EUR, etc. Default USD)",
  "items": [
    { "name": "string", "code": "string (barcode/SKU/item code or empty)", "quantity": number, "rate": number }
  ],
  "freight": number,
  "surcharge": number,
  "fumigation": number,
  "documentCharges": number,
  "discount": number,
  "otherCharges": number
}

Rules:
- items array must include every product/item line with quantity > 0 and rate > 0
- All numeric fields default to 0 if not found
- Return ONLY the JSON object, nothing else`;

  const selectedProvider = await getSelectedAIProvider();
  try {
    const { response } = await callAIWithFallback(
      selectedProvider,
      systemPrompt,
      [],
      `Extract PO data from this text:\n\n${rawText.slice(0, 8000)}`
    );
    const cleaned = response
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "")
      .trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed.items)) return null;
    return parsed;
  } catch (err) {
    logger.error("[ChatService] extractPOFromText AI error:", { error: err });
    return null;
  }
}

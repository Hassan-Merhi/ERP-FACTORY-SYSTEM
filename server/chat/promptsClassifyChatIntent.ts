// Extracted from ./prompts.ts to keep that module under the source-size cap.
import type { ERPContext } from "./erpContext";
import {
  type ChatIntent,
  RE_ACCOUNT_QUERY,
  RE_CODE_EDIT,
  RE_CODE_EDIT_PATHLESS,
  RE_CODE_GEN,
  RE_CODE_READ,
  RE_FINANCIAL_TX,
  RE_GENERAL_KNOWLEDGE,
  RE_NEWS_QUERY,
  RE_PRICE_UPDATE,
  RE_PROJECT_FILE,
  RE_STOCK_ADJ,
  RE_STOCK_ITEM_CREATE,
  RE_STOCK_TRANSFER,
  RE_STOCK_TRANSFER_ANALYSIS,
  RE_STOCK_TRANSFER_EXPLICIT,
  RE_VOUCHER,
  RE_VOUCHER_SEARCH,
} from "./intent";

export function generateQuickSuggestions(context: ERPContext): string[] {
  const suggestions: string[] = [];

  // Priority: Show alerts first
  if (context.overdueContainers.length > 0) {
    suggestions.push(`⚠️ ${context.overdueContainers.length} containers are overdue - show me details`);
  }

  if (context.lowStockAlerts.length > 0) {
    suggestions.push(`Show me the ${context.lowStockAlerts.length} items that are low on stock`);
  }

  if (context.slowMovingStock.length > 0) {
    suggestions.push(`What items haven't sold in 60+ days?`);
  }

  if (context.itemsToMarkdown.length > 0) {
    suggestions.push(`Which items should I consider marking down?`);
  }

  if (context.supplierBalances.filter((s) => s.balance > 0).length > 0) {
    suggestions.push("What are my outstanding supplier payments?");
  }

  if (context.employeeBalances.length > 0) {
    suggestions.push("Show me employee deposit balances");
  }

  if (context.containersInTransit.length > 0) {
    suggestions.push(`What containers are currently in transit?`);
  }

  if (context.topSellingItems.length > 0) {
    suggestions.push("What are my top selling products?");
  }

  suggestions.push("Give me a summary of today's business");
  suggestions.push("Which items have the highest profit margin?");
  suggestions.push("How is my inventory distributed across locations?");

  return suggestions.slice(0, 6);
}

// ── Intent classifier (pure keyword/regex — no AI call) ───────────────────────
export function classifyChatIntent(
  userMessage: string,
  _pageContext?: { currentRoute?: string; entityType?: string; entityId?: number; entityName?: string }
): ChatIntent {
  const hasFileRef = RE_PROJECT_FILE.test(userMessage);
  const isFinancialTx = RE_FINANCIAL_TX.test(userMessage);

  // ── Code agent intents — evaluated FIRST when there is a file reference.
  //    File references are unambiguous: "edit chatService.ts" can only be code.
  if (hasFileRef && RE_CODE_EDIT.test(userMessage)) return "code_edit";
  if (hasFileRef && RE_CODE_READ.test(userMessage)) return "code_read";
  // Read-only with explicit developer verbs (grep/list-files) — only when the message
  // also has code-specific context so "search for supplier" doesn't route here.
  const hasCodeContext =
    hasFileRef ||
    /\b(?:server|client|shared|scripts)\/|\b[\w-]+\.(?:ts|tsx|js|jsx)\b|\b(?:function|component|hook|middleware|handler|schema|interface|endpoint)\b/i.test(
      userMessage
    );
  if (hasCodeContext && /\b(?:find where|grep for|list files|ls\b|where does)\b/i.test(userMessage)) return "code_read";

  // ── Code edit without file path — "add a discount field to the voucher form".
  //    Only fires when the message lacks financial-transaction markers so that
  //    "pay $500 to supplier" doesn't accidentally match code_edit.
  if (!isFinancialTx && RE_CODE_EDIT_PATHLESS.test(userMessage)) return "code_edit";

  // ── ERP action intents — checked after code intents ──────────────────────
  if (RE_STOCK_ADJ.test(userMessage)) return "create_stock_adjustment";
  if (RE_STOCK_ITEM_CREATE.test(userMessage)) return "create_stock_item";
  // Transfer before voucher — "transfer stock" should not match voucher keywords.
  // An explicit stock-transfer signal (stock/item/inventory named right next to
  // transfer/move/shift) always wins, even if RE_VOUCHER's generic "transfer ...
  // <digit>" heuristic also happens to match (e.g. "stock transfer draft for 410
  // bales..." — the digit there is a quantity, not a ledger amount).
  if (RE_STOCK_TRANSFER_EXPLICIT.test(userMessage)) return "create_stock_transfer";
  if (
    (RE_STOCK_TRANSFER.test(userMessage) || RE_STOCK_TRANSFER_ANALYSIS.test(userMessage)) &&
    !RE_VOUCHER.test(userMessage)
  )
    return "create_stock_transfer";
  if (RE_VOUCHER_SEARCH.test(userMessage)) return "search_voucher";
  if (RE_ACCOUNT_QUERY.test(userMessage)) return "account_query";
  if (RE_PRICE_UPDATE.test(userMessage)) return "price_update";
  if (RE_VOUCHER.test(userMessage)) return "create_voucher";

  // Query intents that need broad context
  if (/\b(excel|import|export|template|download.*excel)\b/i.test(userMessage)) return "excel_import";
  if (
    /\b(summary|overview|dashboard|today.{0,20}business|how.{0,15}doing|performance|monthly|this month|last month)\b/i.test(
      userMessage
    )
  )
    return "business_summary";
  if (/\b(sales|revenue|sold|profit|margin|top.{0,10}sell|best.{0,10}sell)\b/i.test(userMessage)) return "sales_query";
  if (
    /\b(inventory|stock|item|quantity|qty|warehouse|location.{0,20}stock|in stock|how much stock)\b/i.test(userMessage)
  )
    return "inventory_query";
  if (/\b(supplier|vendor|purchase order|po\b|container.{0,20}(arriv|transit|offload))\b/i.test(userMessage))
    return "supplier_query";
  if (/\b(customer|client|receivable|owed by|owes|outstanding)\b/i.test(userMessage)) return "customer_query";

  // General knowledge — only fire when message has NO ERP-specific context words
  const hasERPTerms =
    /\b(our|my company|erp|stock item|supplier|purchase order|warehouse|voucher|ledger|invoice|inventory|selling price|location|container|shipment|bale|factory|payroll|worker|proforma)\b/i.test(
      userMessage
    );
  if (!hasERPTerms) {
    if (/^(hi|hello|hey|yo|sup|hiya|howdy|good (morning|evening|afternoon|night))\b/i.test(userMessage.trim()))
      return "general_knowledge";
    if (RE_CODE_GEN.test(userMessage)) return "general_knowledge";
    if (RE_NEWS_QUERY.test(userMessage)) return "general_knowledge";
    if (RE_GENERAL_KNOWLEDGE.test(userMessage)) return "general_knowledge";
  }

  return "general";
}

// Intents that skip getERPContext — only load the minimum data needed
export const ACTION_INTENTS = new Set<ChatIntent>([
  "create_voucher",
  "create_stock_adjustment",
  "create_stock_transfer",
  "create_stock_item",
  "price_update",
  "search_voucher",
  "account_query",
  "excel_import",
  "general_knowledge",
  "code_read",
  "code_edit",
]);

export function buildGeneralSystemPrompt(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `You are a powerful AI assistant — combining the best of ChatGPT, Gemini, and Grok. Today is ${today}.

You can help with ANYTHING the user asks:
- **Code & Apps**: Write HTML/CSS/JavaScript apps, React components, Python scripts, algorithms, etc.
- **General Knowledge**: Answer questions on any topic — science, history, geography, culture, etc.
- **Writing**: Essays, emails, stories, summaries, translations, blog posts
- **Math & Analysis**: Calculations, equations, statistics, data interpretation
- **News & Current Events**: Recent developments and trends (note: knowledge cutoff may apply)
- **Creative Work**: Ideas, brainstorming, creative writing, design advice
- **ERP/Business Help**: If asked about inventory, sales, or business data, you can answer based on general knowledge or note that you'd need access to their ERP data for specifics

When writing code:
- Always use proper markdown code blocks with the language specified (e.g. \`\`\`html, \`\`\`javascript, \`\`\`python)
- For complete mini-apps or web pages, write fully self-contained HTML files with embedded CSS and JavaScript in a single code block
- Make code clean, readable, and functional
- Add helpful inline comments

Respond in the same language the user is writing in. Be direct, thorough, and genuinely helpful.`;
}

export function buildActionSystemPrompt(intent: ChatIntent, pageContext?: { currentRoute?: string }): string {
  const today = new Date().toISOString().slice(0, 10);
  let base = `You are ERP Assistant, an AI for a business ERP/POS system. Today is ${today}.`;
  if (pageContext?.currentRoute) base += ` The user is on page: ${pageContext.currentRoute}.`;
  base += `\nThe user has made a specific request. Acknowledge it briefly and naturally (1-2 sentences). `;
  switch (intent) {
    case "create_voucher":
      base += "Let them know you've prepared a voucher draft for them to review and confirm.";
      break;
    case "create_stock_adjustment":
      base += "Let them know you've prepared a stock adjustment draft for them to review.";
      break;
    case "create_stock_transfer":
      base += "Let them know you've prepared a stock transfer draft for them to review.";
      break;
    case "create_stock_item":
      base += "Let them know you've prepared the new stock item details for them to confirm.";
      break;
    case "price_update":
      base += "Let them know you've prepared a price update for them to confirm.";
      break;
    case "search_voucher":
      base += "Let them know you've searched the voucher records and found the results below.";
      break;
    case "account_query":
      base += "Let them know you've retrieved the account information below.";
      break;
    case "excel_import":
      base += "Help the user with their Excel import/export question concisely.";
      break;
    default:
      base += "Answer the user's request as helpfully and concisely as possible.";
  }
  return base;
}

// Intents served by targeted tool queries — no full ERP context needed
export const TOOL_INTENTS = new Set<ChatIntent>([
  "inventory_query",
  "supplier_query",
  "customer_query",
  "sales_query",
  "business_summary",
]);

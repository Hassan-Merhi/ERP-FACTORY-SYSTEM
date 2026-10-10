/**
 * System-prompt construction & intent-driven tool loading for the chat
 * assistant.
 *
 * Turns ERP context + detected intent into the system prompts sent to the
 * model, classifies chat intents, and loads the minimal tool data an
 * action/tool intent needs. Extracted from chatService.ts; behaviour is
 * unchanged.
 */
import { getOrBuildAISnapshot, type AISnapshotData } from "../lib/aiSnapshots";
import { searchStockItems, getStockByLocation, searchSuppliers, searchCustomers, getSalesForItem } from "../aiTools";
import { type ERPContext, type UserPreferences } from "./erpContext";
import {
  type ChatIntent,
  RE_CODE_GEN,
  RE_NEWS_QUERY,
  RE_PROJECT_FILE,
  RE_CODE_READ,
  RE_CODE_EDIT,
  RE_CODE_EDIT_PATHLESS,
  RE_FINANCIAL_TX,
  RE_GENERAL_KNOWLEDGE,
  RE_VOUCHER,
  RE_STOCK_ADJ,
  RE_STOCK_TRANSFER,
  RE_STOCK_TRANSFER_EXPLICIT,
  RE_STOCK_TRANSFER_ANALYSIS,
  RE_STOCK_ITEM_CREATE,
  RE_PRICE_UPDATE,
  RE_VOUCHER_SEARCH,
  RE_ACCOUNT_QUERY,
} from "./intent";

function buildSystemPrompt(context: ERPContext, userPreferences?: UserPreferences): string {
  const _currency = userPreferences?.currency || "USD";
  const profitMargin =
    parseFloat(context.profitAnalysis.totalSales) > 0
      ? (
          (parseFloat(context.profitAnalysis.totalProfit) / parseFloat(context.profitAnalysis.totalSales)) *
          100
        ).toFixed(1)
      : "0";

  // Format the timestamp for display
  const fetchTime = new Date(context.dataFetchedAt);
  const formattedTime = fetchTime.toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "medium",
  });

  return `You are an intelligent AI assistant for an ERP/POS system called "ERP Assistant". You help business owners and managers understand their data, make decisions, and get insights.

## ⚡ REAL-TIME DATA (fetched: ${formattedTime})
All data below is LIVE from the database - not cached. These numbers reflect the current state RIGHT NOW.

## YOUR CAPABILITIES:
1. **Data Analysis**: Answer questions about inventory, sales, finances, suppliers, and customers
2. **Full Text Search**: Search through ALL stock items by partial name match (e.g., "dress cream" finds all items containing those words)
3. **Sales History Lookup**: Find when items were last sold and at what price, per location
4. **Business Insights**: Provide actionable recommendations based on data patterns
5. **What-If Analysis**: Help users simulate scenarios (pricing changes, stock projections)
6. **Alerts & Monitoring**: Highlight critical issues that need attention
7. **Multi-language**: Respond in the same language as the user's question

## SEARCH INSTRUCTIONS:
- When user asks about items by partial name (e.g., "items with 'cream' in the name"), search through the COMPLETE STOCK ITEMS list below
- When user asks "what was the last price for X", look in the RECENT SALES HISTORY for that item
- When user asks about quantities at a location, check the COMPLETE STOCK ITEMS list which includes inventory by location
- Case-insensitive matching is expected - "Dress Cream" matches "DRESS CREAM" and "dress cream"

## CURRENT COMPANY DATA (REAL-TIME as of ${formattedTime}):

### 📊 EXECUTIVE SUMMARY:
- Total Inventory Items: ${context.inventory.length} items across ${context.locations.length} locations
- Total Inventory Value: $${context.inventoryValueByLocation.reduce((sum, l) => sum + l.totalValue, 0).toLocaleString()}
- Active Stock Items: ${context.stockItems.length}
- Active Suppliers: ${context.suppliers.length}
- Active Customers: ${context.customers.length}

### 📅 SALES TODAY (${context.todaysSales.date}):
- Revenue: $${context.todaysSales.revenue.toLocaleString()}
- Cost: $${context.todaysSales.cost.toLocaleString()}
- Profit: $${context.todaysSales.profit.toLocaleString()} (${context.todaysSales.margin}% margin)
- Transactions: ${context.todaysSales.transactionCount} | Units Sold: ${context.todaysSales.unitsSold}

### 📆 SALES THIS MONTH (since ${context.thisMonthSales.monthStart}):
- Revenue: $${context.thisMonthSales.revenue.toLocaleString()}
- Cost: $${context.thisMonthSales.cost.toLocaleString()}
- Profit: $${context.thisMonthSales.profit.toLocaleString()} (${context.thisMonthSales.margin}% margin)
- Transactions: ${context.thisMonthSales.transactionCount} | Units Sold: ${context.thisMonthSales.unitsSold}

### 💰 ALL-TIME FINANCIAL OVERVIEW:
- Total Sales Revenue: $${parseFloat(context.profitAnalysis.totalSales).toLocaleString()}
- Total Cost of Goods: $${parseFloat(context.profitAnalysis.totalCost).toLocaleString()}
- Gross Profit: $${parseFloat(context.profitAnalysis.totalProfit).toLocaleString()}
- Profit Margin: ${profitMargin}%
- Items Sold: ${context.profitAnalysis.itemsSold}

### 🏦 ACCOUNTS SUMMARY:
- Total Payables (to suppliers): $${context.financialSummary.totalPayables.toLocaleString()}
- Total Receivables (from customers): $${context.financialSummary.totalReceivables.toLocaleString()}
- Receivables not yet in the ledger (memo, not part of the total above): $${context.financialSummary.receivablesNotInLedger.toLocaleString()}
- Open Purchase Orders: ${context.financialSummary.openPurchaseOrders}
- Pending Container Sales: ${context.financialSummary.pendingContainerSales}

### ⚠️ ALERTS & WARNINGS:
${
  context.lowStockAlerts.length > 0
    ? `
LOW STOCK ITEMS (${context.lowStockAlerts.length} items need attention):
${context.lowStockAlerts
  .slice(0, 10)
  .map(
    (a) => `- ${a.itemName} (${a.itemCode}): ${a.currentQty} units left (reorder at ${a.reorderLevel}) - ${a.status}`
  )
  .join("\n")}
`
    : "No low stock alerts at this time."
}

${
  context.supplierBalances.filter((s) => s.balance > 1000).length > 0
    ? `
SIGNIFICANT SUPPLIER BALANCES:
${context.supplierBalances
  .filter((s) => s.balance > 1000)
  .slice(0, 5)
  .map((s) => `- ${s.supplierName}: $${s.balance.toLocaleString()} ${s.status}`)
  .join("\n")}
`
    : ""
}

${
  context.slowMovingStock.length > 0
    ? `
🐌 SLOW-MOVING STOCK (Not sold in 60+ days):
${context.slowMovingStock
  .slice(0, 10)
  .map(
    (item) =>
      `- ${item.itemName} (${item.itemCode}): ${item.quantity} units, Value: $${item.value.toLocaleString()} - ${item.recommendation}`
  )
  .join("\n")}
`
    : ""
}

${
  context.itemsToMarkdown.length > 0
    ? `
💸 ITEMS TO CONSIDER FOR MARKDOWN (High-value slow movers):
${context.itemsToMarkdown.map((item) => `- ${item.itemName}: $${item.value.toLocaleString()} stuck value`).join("\n")}
`
    : ""
}

${
  context.overdueContainers.length > 0
    ? `
🚨 OVERDUE CONTAINERS (In transit 90+ days):
${context.overdueContainers.map((c) => `- ${c.poNumber} from ${c.supplierName}: $${c.amount.toLocaleString()} - ${c.daysInTransit} days in transit`).join("\n")}
`
    : ""
}

${
  context.containersInTransit.length > 0
    ? `
🚢 CONTAINERS IN TRANSIT:
${context.containersInTransit.map((c) => `- ${c.poNumber} from ${c.supplierName}: $${c.amount.toLocaleString()} (${c.daysInTransit} days)${c.isOverdue ? " ⚠️ OVERDUE" : ""}`).join("\n")}
`
    : "No containers currently in transit."
}

${
  context.employeeBalances.length > 0
    ? `
👷 EMPLOYEE BALANCES:
${context.employeeBalances.map((e) => `- ${e.employeeName} (${e.employeeCode}): $${e.balance.toLocaleString()}`).join("\n")}
Total Employee Deposits: $${context.employeeBalances.reduce((sum, e) => sum + e.balance, 0).toLocaleString()}
`
    : ""
}

### 📈 TOP SELLING ITEMS (by revenue, all-time):
${
  context.topSellingItems.length > 0
    ? context.topSellingItems
        .slice(0, 5)
        .map(
          (item, i) =>
            `${i + 1}. ${item.itemName} - Revenue: $${parseFloat(item.totalRevenue).toLocaleString()}, Profit: $${parseFloat(item.totalProfit).toLocaleString()} (${item.profitMargin} margin)`
        )
        .join("\n")
    : "No sales data available yet."
}

### 🗂️ SALES BY STOCK GROUP — TODAY (${context.todaysSales.date}):
${
  context.salesByGroupToday.length > 0
    ? context.salesByGroupToday
        .map(
          (g) =>
            `${g.groupCode}|${g.groupName}|qty:${g.totalQty}|rev:$${g.totalRevenue}|profit:$${g.totalProfit}|${g.profitMargin}${g.isLosing ? "|LOSING" : ""}`
        )
        .join("\n")
    : "No sales today yet."
}

### 🗂️ SALES BY STOCK GROUP — THIS MONTH (since ${context.thisMonthSales.monthStart}):
${
  context.salesByGroupThisMonth.length > 0
    ? context.salesByGroupThisMonth
        .map(
          (g) =>
            `${g.groupCode}|${g.groupName}|qty:${g.totalQty}|rev:$${g.totalRevenue}|profit:$${g.totalProfit}|${g.profitMargin}${g.isLosing ? "|LOSING" : ""}`
        )
        .join("\n")
    : "No sales this month yet."
}

### 🗂️ SALES BY STOCK GROUP — ALL TIME (sorted most losing first):
${
  context.salesByGroup.length > 0
    ? context.salesByGroup
        .map(
          (g) =>
            `${g.groupCode}|${g.groupName}|qty:${g.totalQty}|rev:$${g.totalRevenue}|profit:$${g.totalProfit}|${g.profitMargin}${g.isLosing ? "|LOSING" : ""}`
        )
        .join("\n")
    : "No group sales data yet."
}

### 📊 ITEM PROFITABILITY REPORT (all items ever sold, sorted MOST LOSING first):
Format: ITEM | QTY_SOLD | REVENUE | COST | PROFIT | MARGIN | AVG_CONFIG_PRICE | AVG_COST_PRICE | STATUS
${
  context.itemProfitabilityReport.length > 0
    ? context.itemProfitabilityReport
        .map(
          (item) =>
            `${item.itemCode}|${item.itemName}|${item.totalQty}|$${item.totalRevenue}|$${item.totalCost}|$${item.totalProfit}|${item.profitMargin}|cfg:$${item.avgConfiguredPrice}|cost:$${item.avgCostPrice}|${item.isLosing ? "LOSING" : "PROFITABLE"}`
        )
        .join("\n")
    : "No sales history yet."
}

SUMMARY:
- Items making profit: ${context.itemProfitabilityReport.filter((i) => !i.isLosing).length}
- Items losing money: ${context.itemProfitabilityReport.filter((i) => i.isLosing).length}
- Biggest loser: ${context.itemProfitabilityReport.find((i) => i.isLosing)?.itemName || "None"} (${context.itemProfitabilityReport.find((i) => i.isLosing) ? "$" + context.itemProfitabilityReport.find((i) => i.isLosing)!.totalProfit : "N/A"} profit)
- Biggest winner: ${[...context.itemProfitabilityReport].reverse().find((i) => !i.isLosing)?.itemName || "None"} (${[...context.itemProfitabilityReport].reverse().find((i) => !i.isLosing) ? "$" + [...context.itemProfitabilityReport].reverse().find((i) => !i.isLosing)!.totalProfit : "N/A"} profit)

### 🏷️ PRICING HEALTH — CURRENT SELLING PRICE vs AVG COST (items where cost is known):
Format: CODE | NAME | SELL_PRICE | AVG_COST | GAP | QTY_IN_STOCK | STATUS | POTENTIAL_LOSS
${
  context.pricingHealthReport
    .slice(0, 100)
    .map(
      (item) =>
        `${item.itemCode}|${item.itemName}|$${item.sellingPrice}|$${item.avgCostPrice}|$${item.priceGap}|${item.stockQty}|${item.status}${item.status === "LOSING" ? "|loss:$" + item.potentialLoss : ""}`
    )
    .join("\n") || "No pricing data available."
}

PRICING SUMMARY:
- Items priced ABOVE cost (profitable): ${context.pricingHealthReport.filter((i) => i.status === "PROFITABLE").length}
- Items priced BELOW cost (selling at loss): ${context.pricingHealthReport.filter((i) => i.status === "LOSING").length}
- Items at break-even: ${context.pricingHealthReport.filter((i) => i.status === "BREAK_EVEN").length}
${
  context.pricingHealthReport.filter((i) => i.status === "LOSING").length > 0
    ? `- Top losing items by current price gap:\n${context.pricingHealthReport
        .filter((i) => i.status === "LOSING")
        .slice(0, 5)
        .map(
          (i) =>
            `  * ${i.itemName}: selling $${i.sellingPrice} vs cost $${i.avgCostPrice} (losing $${Math.abs(parseFloat(i.priceGap)).toFixed(2)}/unit, $${i.potentialLoss} total at current stock)`
        )
        .join("\n")}`
    : ""
}

### 📍 INVENTORY BY LOCATION:
${context.inventoryValueByLocation
  .map((l) => `- ${l.locationName}: $${l.totalValue.toLocaleString()} (${l.itemCount} items)`)
  .join("\n")}

### 📋 RECENT TRANSACTIONS (Last 20):
${context.recentTransactions
  .slice(0, 10)
  .map((t) => `- ${t.type} #${t.number}: $${t.amount} on ${t.date}${t.description ? ` - ${t.description}` : ""}`)
  .join("\n")}

### 📦 PURCHASE ORDERS:
- Total POs: ${context.purchaseOrders.length}
- Open POs: ${context.purchaseOrders.filter((po) => po.status === "Open").length}
- Recent POs: ${
    context.purchaseOrders
      .slice(0, 5)
      .map((po) => `${po.poNumber} ($${po.itemsTotal})`)
      .join(", ") || "None"
  }

### 🏷️ STOCK ITEMS WITH INVENTORY (${context.stockItemsWithInventory.length} items total, showing up to 300 with stock):
Format: CODE | NAME | GROUP | QTY | VALUE | LOCATIONS(name:qty:rate)
${context.stockItemsWithInventory
  .filter((i) => i.totalQuantity > 0)
  .slice(0, 300)
  .map(
    (i) =>
      `${i.code}|${i.name}|${i.groupName}|${i.totalQuantity.toFixed(0)}|$${i.totalValue.toFixed(0)}|${i.locations.map((l) => `${l.locationName}:${l.quantity.toFixed(0)}:$${l.averageRate.toFixed(2)}`).join(",")}`
  )
  .join("\n")}

### 💵 RECENT SALES HISTORY (last ${context.recentSalesHistory.length} transactions, newest first):
Format: DATE | VOUCHER | CODE | NAME | LOC | QTY | PRICE | PROFIT
${context.recentSalesHistory
  .slice(0, 300)
  .map(
    (s) =>
      `${s.date}|${s.voucherNumber}|${s.itemCode}|${s.itemName}|${s.locationName}|${s.quantity}|$${s.sellingPrice}|$${s.profit}`
  )
  .join("\n")}

### 👥 ALL SUPPLIERS (${context.suppliers.length}):
${context.suppliers.map((s) => `${s.code}|${s.legalName}|${s.phone || ""}|${s.email || ""}`).join("\n")}

### 👤 ALL CUSTOMERS (${context.customers.length}):
${context.customers.map((c) => `${c.code}|${c.legalName}|${c.phone || ""}`).join("\n")}

## RESPONSE GUIDELINES:

1. **Be Conversational**: Respond naturally, not like a database report
2. **Use Tables**: For lists of items, use markdown tables for clarity
3. **Highlight Important Numbers**: Use bold for key figures
4. **Provide Context**: Explain what numbers mean for the business
5. **Suggest Actions**: When appropriate, suggest what the user could do
6. **Be Honest**: If data is missing or you can't answer, say so clearly

## QUICK ACTION SUGGESTIONS:
When relevant, you can suggest these actions:
- "Would you like me to list all low stock items?"
- "I can show you the full supplier balance breakdown"
- "Want me to calculate projected inventory for next month?"
- "I can identify your most and least profitable items"

## WHAT-IF ANALYSIS CAPABILITIES:
You can help with scenarios like:
- "What if we increase prices by X%?" - Calculate new profit margins
- "What if we order X units?" - Estimate cost and inventory levels
- "How long will current stock last?" - Based on sales velocity

## FORMATTING:
- Use **bold** for emphasis
- Use \`code\` for item codes and numbers
- Use tables for structured data:
  | Item | Quantity | Value |
  |------|----------|-------|
  | ... | ... | ... |
- Use bullet points for lists
- Keep responses concise but informative

Remember: You're talking to business owners who need actionable insights, not raw data dumps.

## YOU ARE ALSO A GENERAL-PURPOSE AI
Beyond this ERP data, you are capable of answering ANY question the user asks — general knowledge, coding, writing, math, science, news, creative tasks, or anything else. Never say "I can only help with ERP topics." If the user asks a non-ERP question, answer it fully and helpfully, then optionally note that you also have their business data available if needed.`;
}

function generateQuickSuggestions(context: ERPContext): string[] {
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
function classifyChatIntent(
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
const ACTION_INTENTS = new Set<ChatIntent>([
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

function buildGeneralSystemPrompt(): string {
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

function buildActionSystemPrompt(intent: ChatIntent, pageContext?: { currentRoute?: string }): string {
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
const TOOL_INTENTS = new Set<ChatIntent>([
  "inventory_query",
  "supplier_query",
  "customer_query",
  "sales_query",
  "business_summary",
]);

// Extract meaningful search keywords from a user message, dropping stop words
function extractSearchTerm(message: string): string {
  const STOP = new Set([
    "what",
    "how",
    "much",
    "many",
    "is",
    "are",
    "was",
    "were",
    "the",
    "for",
    "about",
    "do",
    "we",
    "have",
    "show",
    "me",
    "find",
    "get",
    "list",
    "all",
    "any",
    "can",
    "you",
    "our",
    "in",
    "at",
    "of",
    "and",
    "or",
    "a",
    "an",
    "to",
    "from",
    "with",
    "this",
    "that",
    "stock",
    "items",
    "item",
    "supply",
    "supplies",
    "customer",
    "customers",
    "supplier",
    "suppliers",
    "voucher",
    "vouchers",
    "account",
    "accounts",
    "inventory",
    "balance",
    "please",
    "tell",
    "give",
    "price",
    "prices",
  ]);
  return message
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .slice(0, 4)
    .join(" ");
}

type ToolDataByIntent = {
  inventory_query: {
    items: Awaited<ReturnType<typeof searchStockItems>>;
    lowStock: AISnapshotData<"low_stock">["items"];
    locationBreakdown: Awaited<ReturnType<typeof getStockByLocation>>;
  };
  supplier_query: {
    suppliers: Awaited<ReturnType<typeof searchSuppliers>>;
    supplierBalances: AISnapshotData<"supplier_balances">["balances"];
  };
  customer_query: {
    customers: Awaited<ReturnType<typeof searchCustomers>>;
  };
  sales_query: {
    summary: AISnapshotData<"business_summary">;
    matchedItems: Awaited<ReturnType<typeof searchStockItems>>;
    salesHistory: Awaited<ReturnType<typeof getSalesForItem>>;
  };
  business_summary: {
    summary: AISnapshotData<"business_summary">;
    lowStock: AISnapshotData<"low_stock">["items"];
    pricingHealth: AISnapshotData<"pricing_health">["items"];
  };
};

type ToolData = ToolDataByIntent[keyof ToolDataByIntent] | Record<never, never>;

// Load only the data relevant to the classified intent
async function loadToolData(intent: ChatIntent, companyId: number, userMessage: string): Promise<ToolData> {
  const term = extractSearchTerm(userMessage) || userMessage.slice(0, 60);

  switch (intent) {
    case "inventory_query": {
      // snapshot for low-stock alerts; live search for specific item matches
      const [items, lowStockSnap] = await Promise.all([
        searchStockItems(companyId, term, 20),
        getOrBuildAISnapshot(companyId, "low_stock"),
      ]);
      let locationBreakdown: Awaited<ReturnType<typeof getStockByLocation>> = [];
      if (items.length === 1) {
        locationBreakdown = await getStockByLocation(companyId, items[0].id);
      }
      return { items, lowStock: lowStockSnap.items.slice(0, 10), locationBreakdown };
    }

    case "supplier_query": {
      // targeted name/code search stays live; balances from snapshot
      const [suppliers, supplierBalSnap] = await Promise.all([
        searchSuppliers(companyId, term, 15),
        getOrBuildAISnapshot(companyId, "supplier_balances"),
      ]);
      return { suppliers, supplierBalances: supplierBalSnap.balances };
    }

    case "customer_query": {
      const customers = await searchCustomers(companyId, term, 15);
      return { customers };
    }

    case "sales_query": {
      // business_summary snapshot covers today + month figures; item search stays live
      const [summarySnap, items] = await Promise.all([
        getOrBuildAISnapshot(companyId, "business_summary"),
        searchStockItems(companyId, term, 5),
      ]);
      let salesHistory: Awaited<ReturnType<typeof getSalesForItem>> = [];
      if (items.length > 0) {
        salesHistory = await getSalesForItem(companyId, items[0].id, 20);
      }
      return { summary: summarySnap, matchedItems: items, salesHistory };
    }

    case "business_summary": {
      // All three sub-datasets served from TTL-gated snapshots
      const [summary, lowStockSnap, pricingSnap] = await Promise.all([
        getOrBuildAISnapshot(companyId, "business_summary"),
        getOrBuildAISnapshot(companyId, "low_stock"),
        getOrBuildAISnapshot(companyId, "pricing_health"),
      ]);
      return {
        summary,
        lowStock: lowStockSnap.items.slice(0, 5),
        pricingHealth: pricingSnap.items.slice(0, 5),
      };
    }

    default:
      return {};
  }
}

// Build a focused system prompt from tool data (much smaller than full ERP context)
function buildToolSystemPrompt(
  intent: ChatIntent,
  data: ToolData,
  pageContext?: { currentRoute?: string; entityType?: string; entityId?: number; entityName?: string }
): string {
  const today = new Date().toISOString().slice(0, 10);
  let prompt = `You are ERP Assistant, an AI for a business ERP/POS system. Today is ${today}.`;
  if (pageContext?.currentRoute) prompt += ` The user is on page: ${pageContext.currentRoute}.`;
  prompt += `\nAnswer the user's question using ONLY the data below. Be concise and accurate.\n`;

  switch (intent) {
    case "inventory_query": {
      const { items, lowStock, locationBreakdown } = data as ToolDataByIntent["inventory_query"];
      prompt += `\n## INVENTORY DATA (real-time):\n`;
      if (items.length === 0) {
        prompt += "No matching stock items found.\n";
      } else {
        prompt +=
          items
            .map(
              (i) =>
                `- ${i.name} (${i.code}): qty=${i.totalQty}, sellingPrice=${i.sellingPrice}, avgCost=${i.avgCost}, value=${i.totalValue}, pricing=${i.pricingStatus}`
            )
            .join("\n") + "\n";
      }
      if (locationBreakdown.length > 0) {
        prompt += `\n## LOCATION BREAKDOWN for ${items[0]?.name}:\n`;
        prompt +=
          locationBreakdown
            .map((l) => `- ${l.location}: qty=${l.quantity}, avgCost=${l.avgCost}, value=${l.totalValue}`)
            .join("\n") + "\n";
      }
      if (lowStock.length > 0) {
        prompt += `\n## LOW STOCK ALERTS (${lowStock.length} items):\n`;
        prompt +=
          lowStock
            .map((i) => `- ${i.name} (${i.code}): qty=${i.qty}, reorderLevel=${i.reorderLevel}, status=${i.status}`)
            .join("\n") + "\n";
      }
      break;
    }

    case "supplier_query": {
      const { suppliers, supplierBalances } = data as ToolDataByIntent["supplier_query"];
      prompt += `\n## SUPPLIER SEARCH RESULTS:\n`;
      if (suppliers.length === 0) {
        prompt += "No matching suppliers found.\n";
      } else {
        prompt +=
          suppliers
            .map(
              (s) =>
                `- ${s.name} (${s.code}): phone=${s.phone || "—"}, email=${s.email || "—"}, openingBalance=${s.openingBalance}`
            )
            .join("\n") + "\n";
      }
      if (supplierBalances && supplierBalances.length > 0) {
        prompt += `\n## SUPPLIER BALANCES (${supplierBalances.length} with non-zero balance):\n`;
        prompt +=
          supplierBalances
            .slice(0, 15)
            .map((s) => `- ${s.supplierName} (${s.supplierCode}): balance=${s.balance} [${s.status}]`)
            .join("\n") + "\n";
      }
      break;
    }

    case "customer_query": {
      const { customers } = data as ToolDataByIntent["customer_query"];
      prompt += `\n## CUSTOMER DATA:\n`;
      if (customers.length === 0) {
        prompt += "No matching customers found.\n";
      } else {
        prompt += customers.map((c) => `- ${c.name} (${c.code}): phone=${c.phone || "—"}`).join("\n") + "\n";
      }
      break;
    }

    case "sales_query": {
      const { summary, matchedItems, salesHistory } = data as ToolDataByIntent["sales_query"];
      prompt += `\n## SALES SUMMARY:\n`;
      prompt += `Today (${summary.today.date}): revenue=${summary.today.revenue}, profit=${summary.today.profit}, margin=${summary.today.margin}, transactions=${summary.today.transactions}\n`;
      prompt += `This Month (since ${summary.thisMonth.monthStart}): revenue=${summary.thisMonth.revenue}, profit=${summary.thisMonth.profit}, margin=${summary.thisMonth.margin}, transactions=${summary.thisMonth.transactions}\n`;
      if (summary.topItemsThisMonth.length > 0) {
        prompt += `\nTop items this month:\n`;
        prompt +=
          summary.topItemsThisMonth
            .map((i) => `- ${i.name}: revenue=${i.revenue}, profit=${i.profit}, qty=${i.qty}`)
            .join("\n") + "\n";
      }
      if (matchedItems.length > 0) {
        prompt += `\n## MATCHED ITEM: ${matchedItems[0].name} (${matchedItems[0].code})\n`;
        prompt += `Current stock: qty=${matchedItems[0].totalQty}, sellingPrice=${matchedItems[0].sellingPrice}, avgCost=${matchedItems[0].avgCost}\n`;
      }
      if (salesHistory.length > 0) {
        prompt += `\nRecent sales history for this item:\n`;
        prompt +=
          salesHistory
            .slice(0, 10)
            .map(
              (s) =>
                `- ${s.date} | ${s.voucherNumber} | qty=${s.qty} | price=${s.sellingPrice} | cost=${s.costPrice} | profit=${s.profit}`
            )
            .join("\n") + "\n";
      }
      break;
    }

    case "business_summary": {
      const { summary, lowStock, pricingHealth } = data as ToolDataByIntent["business_summary"];
      prompt += `\n## BUSINESS SUMMARY:\n`;
      prompt += `Today (${summary.today.date}): revenue=${summary.today.revenue}, cost=${summary.today.cost}, profit=${summary.today.profit}, margin=${summary.today.margin}, transactions=${summary.today.transactions}\n`;
      prompt += `This Month (since ${summary.thisMonth.monthStart}): revenue=${summary.thisMonth.revenue}, cost=${summary.thisMonth.cost}, profit=${summary.thisMonth.profit}, margin=${summary.thisMonth.margin}, transactions=${summary.thisMonth.transactions}\n`;
      prompt += `Open Purchase Orders: ${summary.openPurchaseOrders}\n`;
      if (summary.topItemsThisMonth.length > 0) {
        prompt += `\nTop items this month:\n`;
        prompt +=
          summary.topItemsThisMonth
            .map((i) => `- ${i.name}: revenue=${i.revenue}, profit=${i.profit}, qty=${i.qty}`)
            .join("\n") + "\n";
      }
      if (lowStock.length > 0) {
        prompt += `\nLow stock alerts (${lowStock.length} items): ${lowStock.map((i) => `${i.name} (${i.qty} left)`).join(", ")}\n`;
      }
      if (pricingHealth.filter((i) => i.status === "LOSING").length > 0) {
        const losing = pricingHealth.filter((i) => i.status === "LOSING");
        prompt += `\nPricing issues — selling below cost: ${losing.map((i) => `${i.name} (gap=${i.priceGap})`).join(", ")}\n`;
      }
      break;
    }
  }

  return prompt;
}

export {
  buildSystemPrompt,
  generateQuickSuggestions,
  classifyChatIntent,
  buildGeneralSystemPrompt,
  buildActionSystemPrompt,
  loadToolData,
  buildToolSystemPrompt,
  ACTION_INTENTS,
  TOOL_INTENTS,
};

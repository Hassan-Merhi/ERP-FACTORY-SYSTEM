/**
 * System-prompt construction & intent-driven tool loading for the chat
 * assistant.
 *
 * Turns ERP context + detected intent into the system prompts sent to the
 * model, classifies chat intents, and loads the minimal tool data an
 * action/tool intent needs. Extracted from chatService.ts; behaviour is
 * unchanged.
 */
import { getOrBuildAISnapshot } from "../lib/aiSnapshots";
import { searchStockItems, getStockByLocation, searchSuppliers, searchCustomers, getSalesForItem } from "../aiTools";
import { type ChatIntent } from "./intent";
import { buildSystemPrompt } from "./promptsBuildSystemPrompt";
import {
  ACTION_INTENTS,
  TOOL_INTENTS,
  buildActionSystemPrompt,
  buildGeneralSystemPrompt,
  classifyChatIntent,
  generateQuickSuggestions,
} from "./promptsClassifyChatIntent";
import { extractSearchTerm, type ToolDataByIntent, type ToolData } from "./promptsExtractSearchTerm";

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

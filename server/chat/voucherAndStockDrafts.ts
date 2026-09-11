import { db } from "../db";
import * as schema from "@shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { callAIWithFallback, type AIProvider } from "./aiProviders";
import { RE_STOCK_ADJ, RE_VOUCHER } from "./intent";
export async function buildVoucherAndStockDrafts(params: {
  userMessage: string;
  companyId: number;
  selectedProvider: AIProvider;
  intent: string;
}) {
  const { userMessage, companyId, selectedProvider, intent } = params;
  // ── Phase 5b: detect voucher creation intent ──────────────────────────
  // Ask the AI to extract a voucher draft if the message contains creation intent.
  // We do a lightweight structured extraction call only when keywords are found.
  let voucherDraft = undefined;

  // Gate on the classified intent, not the raw regex — RE_VOUCHER's generic
  // "transfer ... <digit>" heuristic can match stock-transfer requests too
  // (e.g. "optional stock transfer draft for 410 bales..."). classifyChatIntent
  // already gives stock-transfer signals priority over this voucher heuristic
  // (see RE_STOCK_TRANSFER_EXPLICIT / RE_STOCK_TRANSFER checks), so only run
  // the voucher-extraction LLM call when the message was actually classified
  // as create_voucher. Running it unconditionally let a stray voucher
  // extraction call hijack stock-transfer requests before the deterministic
  // multi-source stock-transfer hard-route further down ever got a chance.
  if (intent === "create_voucher" && RE_VOUCHER.test(userMessage)) {
    try {
      const accts = await db
        .select({
          id: schema.ledgerAccounts.id,
          name: schema.ledgerAccounts.name,
          accountType: schema.ledgerAccounts.accountType,
        })
        .from(schema.ledgerAccounts)
        .where(and(eq(schema.ledgerAccounts.companyId, companyId), isNull(schema.ledgerAccounts.deletedAt)))
        .limit(120);

      const today = new Date().toISOString().slice(0, 10);
      const extractionPrompt = `You are a voucher extraction assistant for an accounting system.
User message: "${userMessage}"
Today's date: ${today}
Available ledger accounts (id:name:type): ${accts.map((a) => `${a.id}:${a.name}:${a.accountType}`).join(" | ")}

RULES:
1. If the user clearly intends to CREATE a payment, receipt, or journal entry, extract the details and respond with ONLY valid JSON (no markdown, no explanation).
2. Match account names FUZZILY — if the user types a partial name (e.g. "cash", "rent", "salary"), find the best matching account from the list above. Always resolve to a real accountId from the list.
3. Use the EXACT description/narration the user provided (any phrase after "for", "re:", "being", or at the end of the message). If none, write a short descriptive one.
4. Voucher type rules and FROM/TO direction:
   - "Payment" = money going OUT. The word "FROM" tells you the SOURCE account (→ CREDIT it, money leaves). The word "TO" tells you the DESTINATION/beneficiary (→ DEBIT it, expense/payable being settled). Example: "pay FROM cash TO Shamas" → Debit Shamas, Credit Cash.
   - "Receipt" = money coming IN. "FROM" = who paid you (→ CREDIT their account, reduces their balance). "TO" = where it lands (→ DEBIT it, e.g. cash/bank). Example: "received FROM customer TO bank" → Debit Bank, Credit Customer.
   - "Journal" = any other adjustment — determine debit/credit from context.
   - NEVER swap these directions. "FROM" is always the credit side for payments, debit side for receipts.
5. Both sides MUST balance: sum of all debits must equal sum of all credits.
6. Date resolution — always output a real YYYY-MM-DD date. Today is ${today} (${new Date().toLocaleDateString("en-US", { weekday: "long" })}). Resolve ALL relative references: "Monday" → the most recent or upcoming Monday, "yesterday" → ${new Date(Date.now() - 86400000).toISOString().slice(0, 10)}, "last week" → approx 7 days ago, "next Friday" → the coming Friday, specific dates like "May 10" → current year. Never leave the date field as a word or relative expression.
7. CALCULATE percentages automatically. If the user says "$20,000 with 2.5% transfer charges", compute: main amount = 20000, charges = 20000 * 0.025 = 500. Create separate entries for each — e.g. one line for the 20000 payment and one line for the 500 charges — each going to the account the user specifies. The credit side (source, e.g. bank) should equal the total (20500). Do the math yourself, never ask the user to calculate.
8. If the user says "optional", "mark as optional", "put as optional", or similar, set "optional": true in the JSON. Otherwise omit it or set false.

Respond with ONLY this JSON shape:
{"type":"Payment"|"Receipt"|"Journal","date":"YYYY-MM-DD","description":"<user's own wording or short description>","optional":false,"entries":[{"accountId":NUMBER,"accountName":"EXACT name from list","debit":NUMBER,"credit":NUMBER}]}

If the intent is unclear or amounts/accounts are too ambiguous to resolve, respond with exactly: null`;

      const extractionResult = await callAIWithFallback(
        selectedProvider,
        extractionPrompt,
        [],
        "Extract voucher or return null"
      );
      const raw = extractionResult.response
        .trim()
        .replace(/```json\n?|```/g, "")
        .trim();
      if (raw !== "null" && raw.startsWith("{")) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.type && parsed.entries && parsed.entries.length >= 2) {
          // Enrich entries with balanceBefore by fetching current account balances
          try {
            for (const entry of parsed.entries) {
              if (entry.accountId) {
                const balResult = await db.execute(sql`
                    SELECT
                      COALESCE(SUM(CAST(ve.debit_amount AS numeric)), 0) -
                      COALESCE(SUM(CAST(ve.credit_amount AS numeric)), 0) AS net
                    FROM voucher_entries ve
                    JOIN vouchers v ON v.id = ve.voucher_id
                      AND v.deleted_at IS NULL AND v.optional = false
                      AND v.company_id = ${companyId}
                    WHERE ve.ledger_account_id = ${entry.accountId}
                  `);
                entry.balanceBefore = parseFloat((balResult.rows[0] as { net: string })?.net || "0");
              }
            }
          } catch (_) {
            // Failure here is non-fatal and the surrounding flow continues deliberately.
          }
          voucherDraft = parsed;
        }
      }
    } catch (_) {
      // Extraction failed silently — no voucherDraft
    }
  }

  // ── Stock adjustment detection ─────────────────────────────────────
  let stockAdjustmentDraft = undefined;

  if (RE_STOCK_ADJ.test(userMessage)) {
    try {
      const today = new Date().toISOString().slice(0, 10);
      const [items, locs] = await Promise.all([
        db
          .select({ id: schema.stockItems.id, name: schema.stockItems.name, code: schema.stockItems.code })
          .from(schema.stockItems)
          .where(and(eq(schema.stockItems.companyId, companyId), eq(schema.stockItems.active, true)))
          .limit(120),
        db
          .select({ id: schema.locations.id, name: schema.locations.name })
          .from(schema.locations)
          .where(eq(schema.locations.companyId, companyId))
          .limit(30),
      ]);

      const adjPrompt = `You are a stock adjustment extraction assistant.
User message: "${userMessage}"
Today: ${today}
Stock items (id:name:code): ${items.map((i) => `${i.id}:${i.name}:${i.code}`).join(" | ")}
Locations (id:name): ${locs.map((l) => `${l.id}:${l.name}`).join(" | ")}

RULES:
1. Extract a stock adjustment only if the user clearly intends to produce or consume items.
2. Match item names and location names FUZZILY — partial names, abbreviations, and codes all work.
3. The user may mention ANY number of items (one or many). Extract ALL of them into the items array.
4. Each entry has type "PRODUCE" (adding stock) or "CONSUME" (removing stock).
5. Do NOT worry about rate — always set rate: 0. Rates are auto-filled from inventory.
6. Use the user's description/notes if provided.
7. If the user says "optional", set optional: true.
8. Date defaults to today (${today}) if not specified.
9. For each item, pick the best match as stockItemId/stockItemName. ALSO include a "candidates" array of up to 3 plausible matches (best first). Each candidate: {"id":NUMBER,"name":"...","code":"..."}.
10. For location, return up to 3 location candidates: {"id":NUMBER,"name":"..."}.

Respond with ONLY valid JSON (no markdown):
{"date":"YYYY-MM-DD","locationId":NUMBER,"locationName":"...","locationCandidates":[{"id":NUMBER,"name":"..."}],"notes":"...","optional":false,"items":[{"type":"PRODUCE"|"CONSUME","stockItemId":NUMBER,"stockItemName":"...","quantity":NUMBER,"rate":0,"candidates":[{"id":NUMBER,"name":"...","code":"..."}]}]}

If intent is unclear, respond with exactly: null`;

      const adjResult = await callAIWithFallback(
        selectedProvider,
        adjPrompt,
        [],
        "Extract stock adjustment or return null"
      );
      const rawAdj = adjResult.response
        .trim()
        .replace(/```json\n?|```/g, "")
        .trim();
      if (rawAdj !== "null" && rawAdj.startsWith("{")) {
        const parsedAdj = JSON.parse(rawAdj);
        if (parsedAdj && parsedAdj.locationId && parsedAdj.items && parsedAdj.items.length > 0) {
          // Auto-fill rates from inventory averageRate
          const itemIds = parsedAdj.items.map((i: { stockItemId?: number }) => i.stockItemId).filter(Boolean);
          if (itemIds.length > 0) {
            const invRows = await db
              .select({ stockItemId: schema.inventory.stockItemId, averageRate: schema.inventory.averageRate })
              .from(schema.inventory)
              .where(
                and(eq(schema.inventory.locationId, parsedAdj.locationId), eq(schema.inventory.companyId, companyId))
              );
            const rateMap = new Map(invRows.map((r) => [r.stockItemId, parseFloat(r.averageRate ?? "0")]));
            parsedAdj.items = parsedAdj.items.map((item: { stockItemId: number }) => ({
              ...item,
              rate: rateMap.get(item.stockItemId) ?? 0,
            }));
          }
          // Enrich items with currentStock and projectedStock
          try {
            if (parsedAdj.locationId) {
              for (const item of parsedAdj.items) {
                if (item.stockItemId) {
                  const invResult = await db.execute(sql`
                      SELECT COALESCE(SUM(CAST(quantity AS numeric)), 0) AS qty
                      FROM inventory
                      WHERE stock_item_id = ${item.stockItemId}
                        AND location_id = ${parsedAdj.locationId}
                        AND company_id = ${companyId}
                    `);
                  const currentStock = parseFloat((invResult.rows[0] as { qty: string })?.qty || "0");
                  item.currentStock = parseFloat(currentStock.toFixed(3));
                  const delta = item.type === "PRODUCE" ? item.quantity : -item.quantity;
                  item.projectedStock = parseFloat((currentStock + delta).toFixed(3));
                }
              }
            }
          } catch (_) {
            // Failure here is non-fatal and the surrounding flow continues deliberately.
          }
          stockAdjustmentDraft = parsedAdj;
        }
      }
    } catch (_) {
      // Extraction failed silently
    }
  }

  return { voucherDraft, stockAdjustmentDraft };
}

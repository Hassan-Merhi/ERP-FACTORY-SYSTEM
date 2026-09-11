import { db } from "../db";
import * as schema from "@shared/schema";
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm";
import { callAIWithFallback, type AIProvider } from "./aiProviders";
import { RE_ACCOUNT_QUERY, RE_PRICE_UPDATE, RE_STOCK_ITEM_CREATE, RE_VOUCHER_SEARCH } from "./intent";
export async function buildLookupDrafts(params: {
  userMessage: string;
  companyId: number;
  selectedProvider: AIProvider;
}) {
  const { userMessage, companyId, selectedProvider } = params;
  // ── Voucher search by description ─────────────────────────────────
  let voucherSearchResults:
    | Pick<
        typeof schema.vouchers.$inferSelect,
        "id" | "voucherNumber" | "voucherType" | "voucherDate" | "description" | "totalAmount" | "optional"
      >[]
    | undefined = undefined;

  if (RE_VOUCHER_SEARCH.test(userMessage)) {
    try {
      const termPrompt = `Extract the description search term the user wants to search for in their voucher records.
User message: "${userMessage}"
Return ONLY the search term as plain text (e.g. "rent", "electricity bill", "client ABC"). If no clear term, return null.`;
      const termResult = await callAIWithFallback(selectedProvider, termPrompt, [], "Extract voucher search term");
      const searchTerm = termResult.response
        .trim()
        .replace(/^["']|["']$/g, "")
        .toLowerCase();
      if (searchTerm && searchTerm !== "null" && searchTerm.length > 0) {
        const results = await db
          .select({
            id: schema.vouchers.id,
            voucherNumber: schema.vouchers.voucherNumber,
            voucherType: schema.vouchers.voucherType,
            voucherDate: schema.vouchers.voucherDate,
            description: schema.vouchers.description,
            totalAmount: schema.vouchers.totalAmount,
            optional: schema.vouchers.optional,
          })
          .from(schema.vouchers)
          .where(
            and(
              eq(schema.vouchers.companyId, companyId),
              isNull(schema.vouchers.deletedAt),
              or(
                ilike(schema.vouchers.description, `%${searchTerm}%`),
                ilike(schema.vouchers.voucherNumber, `%${searchTerm}%`)
              )
            )
          )
          .orderBy(desc(schema.vouchers.voucherDate))
          .limit(10);
        if (results.length > 0) {
          voucherSearchResults = results;
        }
      }
    } catch (_) {
      // Search failed silently
    }
  }

  // ── New stock item creation ────────────────────────────────────────
  let stockItemDraft = undefined;

  if (RE_STOCK_ITEM_CREATE.test(userMessage)) {
    try {
      const groups = await db
        .select({ id: schema.stockGroups.id, name: schema.stockGroups.name })
        .from(schema.stockGroups)
        .where(and(eq(schema.stockGroups.companyId, companyId), eq(schema.stockGroups.active, true)))
        .orderBy(schema.stockGroups.name)
        .limit(60);

      const itemPrompt = `You are a stock item creation assistant.
User message: "${userMessage}"
Available stock groups (id:name): ${groups.map((g) => `${g.id}:${g.name}`).join(" | ")}

Extract the following fields from the user's message:
- name: full item name
- code: item code (short identifier, usually letters/numbers)
- uom: unit of measure (e.g. KG, PCS, MTR, LTR, BOX)
- stockGroupId: best matching group id from the list above (fuzzy match)
- stockGroupName: matching group name

RULES:
1. Match stock group name FUZZILY — abbreviations and partial names are fine.
2. If no group matches, set stockGroupId: null and stockGroupName: "".
3. If code is not mentioned, generate a sensible short code from the name (uppercase, max 8 chars).
4. UOM should be normalized to common abbreviations (KG, PCS, MTR, LTR, BOX, etc.).

Respond with ONLY valid JSON (no markdown):
{"name":"...","code":"...","uom":"...","stockGroupId":NUMBER_OR_NULL,"stockGroupName":"..."}

If the user is not clearly trying to create a stock item, respond with exactly: null`;

      const itemResult = await callAIWithFallback(
        selectedProvider,
        itemPrompt,
        [],
        "Extract stock item creation details"
      );
      const rawItem = itemResult.response
        .trim()
        .replace(/```json\n?|```/g, "")
        .trim();
      if (rawItem !== "null" && rawItem.startsWith("{")) {
        const parsedItem = JSON.parse(rawItem);
        if (parsedItem && parsedItem.name && parsedItem.code && parsedItem.uom) {
          stockItemDraft = {
            name: parsedItem.name,
            code: parsedItem.code.toUpperCase(),
            uom: parsedItem.uom.toUpperCase(),
            stockGroupId: parsedItem.stockGroupId ?? null,
            stockGroupName: parsedItem.stockGroupName ?? "",
            groupCandidates: groups.slice(0, 20).map((g) => ({ id: g.id, name: g.name })),
          };
        }
      }
    } catch (_) {
      // Extraction failed silently
    }
  }

  // ── Price list update ──────────────────────────────────────────────
  let priceUpdateDraft = undefined;

  if (RE_PRICE_UPDATE.test(userMessage)) {
    try {
      const [items, masterRows] = await Promise.all([
        db
          .select({ id: schema.stockItems.id, name: schema.stockItems.name, code: schema.stockItems.code })
          .from(schema.stockItems)
          .where(
            and(
              eq(schema.stockItems.companyId, companyId),
              eq(schema.stockItems.active, true),
              isNull(schema.stockItems.deletedAt)
            )
          )
          .limit(120),
        db
          .select({ masterLocationId: schema.locationPriceGroups.masterLocationId })
          .from(schema.locationPriceGroups)
          .where(eq(schema.locationPriceGroups.companyId, companyId)),
      ]);

      const masterIds = [...new Set(masterRows.map((r) => r.masterLocationId))];
      const masterLocations =
        masterIds.length > 0
          ? await db
              .select({ id: schema.locations.id, name: schema.locations.name })
              .from(schema.locations)
              .where(and(eq(schema.locations.companyId, companyId), inArray(schema.locations.id, masterIds)))
          : await db
              .select({ id: schema.locations.id, name: schema.locations.name })
              .from(schema.locations)
              .where(eq(schema.locations.companyId, companyId))
              .limit(20);

      // Fetch follower counts per master for display
      const followerCounts = new Map<number, number>();
      if (masterIds.length > 0) {
        const fRows = await db
          .select({
            masterLocationId: schema.locationPriceGroups.masterLocationId,
            followerLocationId: schema.locationPriceGroups.followerLocationId,
          })
          .from(schema.locationPriceGroups)
          .where(eq(schema.locationPriceGroups.companyId, companyId));
        for (const r of fRows) {
          followerCounts.set(r.masterLocationId, (followerCounts.get(r.masterLocationId) ?? 0) + 1);
        }
      }

      const pricePrompt = `You are a price update extraction assistant.
User message: "${userMessage}"
Stock items (id:name:code): ${items.map((i) => `${i.id}:${i.name}:${i.code}`).join(" | ")}
Price group / master locations (id:name): ${masterLocations.map((l) => `${l.id}:${l.name}`).join(" | ")}

Extract:
- stockItemId: best matching stock item id (fuzzy match on name or code)
- stockItemName: matching item name
- stockItemCode: matching item code
- locationId: best matching master location id (fuzzy match)
- locationName: matching location name
- newPrice: the new selling price as a number

RULES:
1. Match item name/code and location name FUZZILY.
2. newPrice must be a positive number.
3. If the user says "all locations" or doesn't specify a location, pick locationId: null and locationName: "".
4. Also include candidates arrays for disambiguation:
   - itemCandidates: up to 3 item matches [{"id":N,"name":"...","code":"..."}]
   - locationCandidates: up to 3 location matches [{"id":N,"name":"..."}]

Respond with ONLY valid JSON (no markdown):
{"stockItemId":NUMBER,"stockItemName":"...","stockItemCode":"...","locationId":NUMBER_OR_NULL,"locationName":"...","newPrice":NUMBER,"itemCandidates":[...],"locationCandidates":[...]}

If intent is not a price update, respond with exactly: null`;

      const priceResult = await callAIWithFallback(selectedProvider, pricePrompt, [], "Extract price update details");
      const rawPrice = priceResult.response
        .trim()
        .replace(/```json\n?|```/g, "")
        .trim();
      if (rawPrice !== "null" && rawPrice.startsWith("{")) {
        const parsedPrice = JSON.parse(rawPrice);
        if (parsedPrice && parsedPrice.stockItemId && parsedPrice.newPrice > 0) {
          priceUpdateDraft = {
            ...parsedPrice,
            followerCount: parsedPrice.locationId ? (followerCounts.get(parsedPrice.locationId) ?? 0) : 0,
            allLocations: masterLocations.map((l) => ({ id: l.id, name: l.name })),
          };
        }
      }
    } catch (_) {
      // Extraction failed silently
    }
  }

  // ── Account queries: balance / transaction search / balance history ──
  let accountQueryResult = undefined;

  if (RE_ACCOUNT_QUERY.test(userMessage)) {
    try {
      const accounts = await db
        .select({
          id: schema.ledgerAccounts.id,
          name: schema.ledgerAccounts.name,
          code: schema.ledgerAccounts.code,
          accountType: schema.ledgerAccounts.accountType,
          openingBalance: schema.ledgerAccounts.openingBalance,
          openingBalanceSide: schema.ledgerAccounts.openingBalanceSide,
        })
        .from(schema.ledgerAccounts)
        .where(
          and(
            eq(schema.ledgerAccounts.companyId, companyId),
            eq(schema.ledgerAccounts.active, true),
            isNull(schema.ledgerAccounts.deletedAt)
          )
        )
        .orderBy(schema.ledgerAccounts.name)
        .limit(150);

      const acctPrompt = `You are an accounts query extraction assistant.
User message: "${userMessage}"
Ledger accounts (id:name:code:type): ${accounts.map((a) => `${a.id}:${a.name}:${a.code}:${a.accountType}`).join(" | ")}

Determine the query type and extract fields:
- queryType: "balance" | "transactions" | "balance_history"
  - "balance": user wants current balance of an account
  - "transactions": user wants to find payments/transactions by description or amount for an account
  - "balance_history": user wants to know when an account had a specific balance amount
- accountId: best matching account id (fuzzy match on name or code)
- accountName: matching account name
- searchTerm: description keyword to search (for transactions queryType, if any)
- searchAmount: specific amount to find (number, for transactions or balance_history queryType, if any)
- targetBalance: the balance amount they are asking about (for balance_history queryType)

RULES:
1. Fuzzy match account names — partial names and abbreviations work.
2. searchTerm, searchAmount, targetBalance are optional — only include if clearly in the message.
3. For "balance" queries: just accountId and accountName are needed.
4. For "transactions": accountId + at least one of searchTerm or searchAmount.
5. For "balance_history": accountId + targetBalance.

Respond with ONLY valid JSON (no markdown):
{"queryType":"balance"|"transactions"|"balance_history","accountId":NUMBER,"accountName":"...","searchTerm":"...","searchAmount":NUMBER_OR_NULL,"targetBalance":NUMBER_OR_NULL}

If intent is not about an account query, respond with exactly: null`;

      const acctResult = await callAIWithFallback(selectedProvider, acctPrompt, [], "Extract account query");
      const rawAcct = acctResult.response
        .trim()
        .replace(/```json\n?|```/g, "")
        .trim();

      if (rawAcct !== "null" && rawAcct.startsWith("{")) {
        const parsed = JSON.parse(rawAcct);
        if (parsed && parsed.accountId && parsed.queryType) {
          const acct = accounts.find((a) => a.id === parsed.accountId);
          if (!acct) throw new Error("Account not found");

          if (parsed.queryType === "balance") {
            // Compute current balance from voucher entries
            const rows = await db
              .select({
                totalDebit: sql<string>`COALESCE(SUM(CAST(${schema.voucherEntries.debitAmount} AS numeric)), 0)`,
                totalCredit: sql<string>`COALESCE(SUM(CAST(${schema.voucherEntries.creditAmount} AS numeric)), 0)`,
              })
              .from(schema.voucherEntries)
              .innerJoin(
                schema.vouchers,
                and(
                  eq(schema.voucherEntries.voucherId, schema.vouchers.id),
                  eq(schema.vouchers.optional, false),
                  isNull(schema.vouchers.deletedAt)
                )
              )
              .where(eq(schema.voucherEntries.ledgerAccountId, parsed.accountId));

            const dr = parseFloat(rows[0]?.totalDebit || "0");
            const cr = parseFloat(rows[0]?.totalCredit || "0");
            const ob = parseFloat(acct.openingBalance || "0");
            const obSide = acct.openingBalanceSide || "Dr";
            const balance = (obSide === "Cr" ? -ob : ob) + dr - cr;
            accountQueryResult = {
              queryType: "balance",
              accountId: parsed.accountId,
              accountName: acct.name,
              balance: parseFloat(balance.toFixed(2)),
            };
          } else if (parsed.queryType === "transactions") {
            // Search transactions by description and/or amount
            const conditions: (SQL | undefined)[] = [
              eq(schema.voucherEntries.ledgerAccountId, parsed.accountId),
              eq(schema.vouchers.optional, false),
              isNull(schema.vouchers.deletedAt),
            ];
            if (parsed.searchTerm) {
              conditions.push(
                or(
                  ilike(schema.vouchers.description, `%${parsed.searchTerm}%`),
                  ilike(schema.voucherEntries.narration, `%${parsed.searchTerm}%`),
                  ilike(schema.vouchers.voucherNumber, `%${parsed.searchTerm}%`)
                )
              );
            }
            if (parsed.searchAmount) {
              const amt = String(parseFloat(parsed.searchAmount).toFixed(2));
              conditions.push(
                or(
                  sql`CAST(${schema.voucherEntries.debitAmount} AS numeric) = ${parseFloat(amt)}`,
                  sql`CAST(${schema.voucherEntries.creditAmount} AS numeric) = ${parseFloat(amt)}`,
                  sql`CAST(${schema.vouchers.totalAmount} AS numeric) = ${parseFloat(amt)}`
                )
              );
            }
            const txRows = await db
              .select({
                voucherId: schema.voucherEntries.voucherId,
                voucherNumber: schema.vouchers.voucherNumber,
                voucherType: schema.vouchers.voucherType,
                voucherDate: schema.vouchers.voucherDate,
                description: schema.vouchers.description,
                narration: schema.voucherEntries.narration,
                debitAmount: schema.voucherEntries.debitAmount,
                creditAmount: schema.voucherEntries.creditAmount,
                totalAmount: schema.vouchers.totalAmount,
              })
              .from(schema.voucherEntries)
              .innerJoin(schema.vouchers, and(eq(schema.voucherEntries.voucherId, schema.vouchers.id)))
              .where(and(...conditions))
              .orderBy(desc(schema.vouchers.voucherDate))
              .limit(10);

            accountQueryResult = {
              queryType: "transactions",
              accountId: parsed.accountId,
              accountName: acct.name,
              searchTerm: parsed.searchTerm,
              searchAmount: parsed.searchAmount,
              transactions: txRows,
            };
          } else if (parsed.queryType === "balance_history") {
            // Get all transactions sorted by date, compute running balance, find when it crossed target
            const allRows = await db
              .select({
                voucherId: schema.voucherEntries.voucherId,
                voucherNumber: schema.vouchers.voucherNumber,
                voucherType: schema.vouchers.voucherType,
                voucherDate: schema.vouchers.voucherDate,
                description: schema.vouchers.description,
                debitAmount: schema.voucherEntries.debitAmount,
                creditAmount: schema.voucherEntries.creditAmount,
              })
              .from(schema.voucherEntries)
              .innerJoin(
                schema.vouchers,
                and(
                  eq(schema.voucherEntries.voucherId, schema.vouchers.id),
                  eq(schema.vouchers.optional, false),
                  isNull(schema.vouchers.deletedAt)
                )
              )
              .where(eq(schema.voucherEntries.ledgerAccountId, parsed.accountId))
              .orderBy(asc(schema.vouchers.voucherDate));

            const ob = parseFloat(acct.openingBalance || "0");
            const obSide = acct.openingBalanceSide || "Dr";
            let running = obSide === "Cr" ? -ob : ob;
            const target = parseFloat(parsed.targetBalance);
            const tolerance = Math.max(Math.abs(target) * 0.01, 1); // 1% or ±1

            const matches: any[] = [];
            for (const row of allRows) {
              running += parseFloat(row.debitAmount || "0") - parseFloat(row.creditAmount || "0");
              if (Math.abs(running - target) <= tolerance) {
                matches.push({ ...row, balanceAfter: parseFloat(running.toFixed(2)) });
                if (matches.length >= 5) break;
              }
            }
            accountQueryResult = {
              queryType: "balance_history",
              accountId: parsed.accountId,
              accountName: acct.name,
              targetBalance: target,
              matches,
            };
          }
        }
      }
    } catch (_) {
      // Account query failed silently
    }
  }

  return { voucherSearchResults, stockItemDraft, priceUpdateDraft, accountQueryResult };
}

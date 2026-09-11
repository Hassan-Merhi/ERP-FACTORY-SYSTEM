import { db } from "../db";
import * as schema from "@shared/schema";
import { and, eq, isNull, sql } from "drizzle-orm";
import { callAIWithFallback, type AIProvider } from "./aiProviders";
import {
  deterministicParseMultiSourceTransfer,
  RE_MULTI_SOURCE_LOCATIONS,
  RE_STOCK_GROUP_FILTER_HINT,
  RE_STOCK_TRANSFER,
  RE_STOCK_TRANSFER_ANALYSIS,
  RE_STOCK_TRANSFER_ANALYSIS_STRICT,
  RE_TARGET_QTY_HINT,
} from "./intent";
import {
  buildStockTransferByTargetQuantityContext,
  buildStockTransferSuggestionContext,
  matchLocationByName,
} from "../services/stockTransferAnalysis";
/** One item inside a stock-transfer chat draft. */
type StockTransferDraftItem = {
  stockItemId: number;
  stockItemName?: string;
  stockItemCode?: string;
  quantity?: number;
  currentStock?: number;
  destinationQty?: number;
  reason?: string;
};

/** Stock-transfer draft payload produced by chat flows (also parsed back from JSON). */
type StockTransferChatDraft = {
  date: string;
  sourceLocationId: number;
  sourceLocationName: string;
  destinationLocationId: number;
  destinationLocationName: string;
  notes?: string;
  optional?: boolean;
  analysisSummary?: string;
  items?: StockTransferDraftItem[];
  locationCandidates?: { id: number; name: string }[];
  analysisDateRange?: { from: string; to: string };
  aggressiveness?: string;
  comparedLocations?: string;
  oldTransferSummary?: string;
};

export async function buildStockTransferDrafts(params: {
  userMessage: string;
  companyId: number;
  selectedProvider: AIProvider;
  voucherDraft: unknown;
  stockAdjustmentDraft: unknown;
}) {
  const { userMessage, companyId, selectedProvider, voucherDraft, stockAdjustmentDraft } = params;
  // ── Stock transfer detection ───────────────────────────────────────
  let stockTransferDraft: StockTransferChatDraft | undefined = undefined;
  let stockTransferDrafts: StockTransferChatDraft[] | undefined = undefined;
  // When set, this is used verbatim as the assistant's text response for the
  // stock-transfer flow, bypassing the generic "prepared a draft" acknowledgement
  // prompt — guarantees we never claim a draft exists when it doesn't.
  let stockTransferResponseOverride: string | undefined = undefined;
  // Deterministic multi-source/target-quantity signal: an explicit
  // "Hadi 1, Hadi 2, ..." source list, or an explicit quantity ("410 bales")
  // combined with "same stock group" filtering language. This is specific
  // enough on its own to imply transfer intent even when the message never
  // uses the literal words "stock"/"item"/"inventory" (e.g. "optional
  // transfer draft for 410 bales to Kolwezi from Hadi 1, Hadi 2, ...").
  const hasMultiSourceQtySignal =
    RE_MULTI_SOURCE_LOCATIONS.test(userMessage) ||
    (RE_TARGET_QTY_HINT.test(userMessage) && RE_STOCK_GROUP_FILTER_HINT.test(userMessage));
  const isMultiSourceTargetQtyRequest =
    (RE_STOCK_TRANSFER.test(userMessage) || hasMultiSourceQtySignal) &&
    !RE_STOCK_TRANSFER_ANALYSIS_STRICT.test(userMessage) &&
    hasMultiSourceQtySignal;

  if (
    (RE_STOCK_TRANSFER.test(userMessage) ||
      RE_STOCK_TRANSFER_ANALYSIS.test(userMessage) ||
      isMultiSourceTargetQtyRequest) &&
    !voucherDraft &&
    !stockAdjustmentDraft
  ) {
    try {
      // The deterministic multi-source/target-quantity builder takes priority
      // over the looser analysis match — a request can say "optional stock
      // transfer" (matching RE_STOCK_TRANSFER_ANALYSIS) while also giving an
      // explicit quantity and named sources, which must go through the
      // deterministic path, not the AI-suggestion analysis path.
      if (RE_STOCK_TRANSFER_ANALYSIS.test(userMessage) && !isMultiSourceTargetQtyRequest) {
        // ── AI-suggested OPTIONAL stock transfer (data-driven analysis) ──
        // The LLM only classifies intent + picks locations/date range/aggressiveness.
        // All quantities/numbers come from buildStockTransferSuggestionContext (real SQL).
        const locRows = await db
          .select({ id: schema.locations.id, name: schema.locations.name, code: schema.locations.code })
          .from(schema.locations)
          .where(and(eq(schema.locations.companyId, companyId), isNull(schema.locations.deletedAt)))
          .limit(50);

        const today = new Date().toISOString().slice(0, 10);
        const analysisPrompt = `You are a stock-transfer analysis request parser.
User message: "${userMessage}"
Today: ${today}
Locations (id:name:code): ${locRows.map((l) => `${l.id}:${l.name}:${l.code}`).join(" | ")}

RULES:
1. Extract the source location name and destination location name exactly as the user referred to them (fuzzy match to the list above by NAME, do not invent an id yourself).
2. Extract a lookback window in days if mentioned ("last 7 days" -> 7, "last 30 days" -> 30, "this month" -> use days from the 1st of this month to today). Default to 30 if not mentioned.
3. Extract aggressiveness if mentioned: "aggressive"/"fast"/"more" -> "aggressive", "conservative"/"safe"/"careful" -> "conservative", otherwise "normal".
4. If the user did not name two distinct locations, respond with exactly: null

Respond with ONLY valid JSON (no markdown):
{"sourceLocationName":"...","destinationLocationName":"...","days":NUMBER,"aggressiveness":"conservative"|"normal"|"aggressive"}

If this is not a two-location stock-transfer analysis request, respond with exactly: null`;

        const analysisResult = await callAIWithFallback(
          selectedProvider,
          analysisPrompt,
          [],
          "Extract stock transfer analysis parameters or return null"
        );
        const rawAnalysis = analysisResult.response
          .trim()
          .replace(/```json\n?|```/g, "")
          .trim();

        if (rawAnalysis !== "null" && rawAnalysis.startsWith("{")) {
          const parsedAnalysis = JSON.parse(rawAnalysis);
          const sourceMatch = await matchLocationByName(companyId, parsedAnalysis.sourceLocationName || "");
          const destMatch = await matchLocationByName(companyId, parsedAnalysis.destinationLocationName || "");

          if (sourceMatch.candidates.length > 1 || destMatch.candidates.length > 1) {
            // Ambiguous location name(s) — never guess silently.
            const ambiguous = sourceMatch.candidates.length > 1 ? sourceMatch.candidates : destMatch.candidates;
            stockTransferDraft = {
              date: today,
              sourceLocationId: sourceMatch.matched?.id || 0,
              sourceLocationName: sourceMatch.matched?.name || parsedAnalysis.sourceLocationName || "",
              destinationLocationId: destMatch.matched?.id || 0,
              destinationLocationName: destMatch.matched?.name || parsedAnalysis.destinationLocationName || "",
              items: [],
              locationCandidates: ambiguous.map((c) => ({ id: c.id, name: `${c.name} (${c.code})` })),
              optional: true,
              analysisSummary:
                "Multiple locations matched that name. Please pick the correct one before I can analyze.",
            };
          } else if (sourceMatch.matched && destMatch.matched) {
            const days = Math.min(365, Math.max(1, Number(parsedAnalysis.days) || 30));
            const dateTo = today;
            const dateFromObj = new Date();
            dateFromObj.setDate(dateFromObj.getDate() - (days - 1));
            const dateFrom = dateFromObj.toISOString().slice(0, 10);
            const aggressiveness: "conservative" | "normal" | "aggressive" = [
              "conservative",
              "normal",
              "aggressive",
            ].includes(parsedAnalysis.aggressiveness)
              ? parsedAnalysis.aggressiveness
              : "normal";

            const ctx = await buildStockTransferSuggestionContext(
              companyId,
              sourceMatch.matched.id,
              destMatch.matched.id,
              dateFrom,
              dateTo,
              { aggressiveness }
            );

            stockTransferDraft = {
              date: today,
              sourceLocationId: ctx.sourceLocationId,
              sourceLocationName: ctx.sourceLocationName,
              destinationLocationId: ctx.destinationLocationId,
              destinationLocationName: ctx.destinationLocationName,
              notes: `AI-suggested optional transfer based on sales/stock analysis (${ctx.dateFrom} to ${ctx.dateTo}).`,
              optional: true,
              analysisSummary: ctx.analysisSummary,
              analysisDateRange: { from: ctx.dateFrom, to: ctx.dateTo },
              aggressiveness: ctx.aggressiveness,
              comparedLocations: `${ctx.sourceLocationName} → ${ctx.destinationLocationName}`,
              oldTransferSummary: ctx.oldTransferSummary,
              items: ctx.items.map((i) => ({
                stockItemId: i.stockItemId,
                stockItemName: i.stockItemName,
                stockItemCode: i.stockItemCode,
                quantity: i.suggestedQty,
                currentStock: i.sourceQty,
                sourceQty: i.sourceQty,
                destinationQty: i.destinationQty,
                sourceSalesQty: i.sourceSalesQty,
                destinationSalesQty: i.destinationSalesQty,
                sourceSalesRate: i.sourceSalesRate,
                destinationSalesRate: i.destinationSalesRate,
                otwQty: i.otwQty,
                otwDetails: i.otwDetails,
                otwSummary: i.otwSummary,
                suggestedQty: i.suggestedQty,
                reason: i.reason,
                confidence: i.confidence,
                oldTransferSummary: i.oldTransferSummary,
                previousTransferQty: i.previousTransferQty,
                previousTransferCount: i.previousTransferCount,
                lastTransferDate: i.lastTransferDate || undefined,
              })),
            };
          }
        }
      } else if (isMultiSourceTargetQtyRequest) {
        // ── Multi-source, target-quantity transfer (e.g. "410 bales to Kolwezi
        // from Hadi 1,2,3,4, only stock groups Kolwezi already has") ──
        // The LLM only extracts location names/quantity/flags as TEXT; every
        // item/quantity in the resulting draft(s) comes from
        // buildStockTransferByTargetQuantityContext (real SQL) — never invented.
        const locRows = await db
          .select({ id: schema.locations.id, name: schema.locations.name, code: schema.locations.code })
          .from(schema.locations)
          .where(and(eq(schema.locations.companyId, companyId), isNull(schema.locations.deletedAt)))
          .limit(80);

        const today = new Date().toISOString().slice(0, 10);

        // ── Deterministic pass first — grounded in the real location list. ──
        const deterministic = deterministicParseMultiSourceTransfer(userMessage, locRows);

        let destinationName: string | undefined;
        let sourceNames: string[] = [];
        let targetQty: number | undefined;
        let optional = false;
        let onlyDestinationStockGroups = true;
        let dateStr = today;
        let haveParsedParams = false;

        if (deterministic) {
          destinationName = deterministic.destinationName;
          sourceNames = deterministic.sourceNames;
          targetQty = deterministic.targetQty;
          optional = deterministic.optional;
          onlyDestinationStockGroups = RE_STOCK_GROUP_FILTER_HINT.test(userMessage) || onlyDestinationStockGroups;
          haveParsedParams = true;
        } else {
          const multiPrompt = `You are a stock-transfer request parser for a request that targets a TOTAL QUANTITY across possibly MULTIPLE source locations (not a fixed item list).
User message: "${userMessage}"
Today: ${today}
Locations (id:name:code): ${locRows.map((l) => `${l.id}:${l.name}:${l.code}`).join(" | ")}

RULES:
1. Extract destinationLocationName exactly as the user referred to it (e.g. "Kolwezi"). Do not guess between similarly-named locations (e.g. "Kolwezi" vs "Kolwezi 2") — just report the name the user typed.
2. Extract ALL source location names, expanding any shorthand into a full array. "Hadi 1,2,3,4" -> ["Hadi 1","Hadi 2","Hadi 3","Hadi 4"]. "Hadi 1-4" -> ["Hadi 1","Hadi 2","Hadi 3","Hadi 4"]. Match against the locations list by NAME text only, do not invent ids.
3. Extract targetQty: a whole number of bales/items/units the user wants transferred in TOTAL. If no number is mentioned, use null.
4. Extract optional: true if the user says "optional", otherwise false.
5. Extract date: default to today (${today}) if not specified.
6. Extract onlyDestinationStockGroups: true if the user says things like "only use the same stock groups it already has" / "don't mix X with Y" / similar filtering language. Default true if unclear.

Respond with ONLY valid JSON (no markdown):
{"destinationLocationName":"...","sourceLocationNames":["..."],"targetQty":NUMBER_OR_NULL,"optional":BOOLEAN,"date":"YYYY-MM-DD","onlyDestinationStockGroups":BOOLEAN}

If this is not this kind of quantity-target multi-source transfer request, respond with exactly: null`;

          const multiResult = await callAIWithFallback(
            selectedProvider,
            multiPrompt,
            [],
            "Extract multi-source target-quantity stock transfer parameters or return null"
          );
          const rawMulti = multiResult.response
            .trim()
            .replace(/```json\n?|```/g, "")
            .trim();

          if (rawMulti !== "null" && rawMulti.startsWith("{")) {
            const parsedMulti = JSON.parse(rawMulti);
            destinationName = parsedMulti.destinationLocationName || "";
            sourceNames = Array.isArray(parsedMulti.sourceLocationNames)
              ? parsedMulti.sourceLocationNames.filter((n: any) => typeof n === "string" && n.trim())
              : [];
            targetQty =
              Number.isFinite(Number(parsedMulti.targetQty)) && Number(parsedMulti.targetQty) > 0
                ? Math.floor(Number(parsedMulti.targetQty))
                : undefined;
            optional = parsedMulti.optional === true;
            onlyDestinationStockGroups = parsedMulti.onlyDestinationStockGroups !== false;
            dateStr = parsedMulti.date || today;
            haveParsedParams = true;
          }
        }

        if (haveParsedParams) {
          destinationName = destinationName || "";

          // Destination must match STRICTLY — never silently pick "Kolwezi 2" for "Kolwezi".
          const destMatch = await matchLocationByName(companyId, destinationName, { strict: true });

          if (!destinationName) {
            stockTransferResponseOverride =
              "I need a destination location to build this transfer — which location should receive the stock?";
          } else if (!destMatch.matched && destMatch.candidates.length > 0) {
            stockTransferDraft = {
              date: dateStr,
              sourceLocationId: 0,
              sourceLocationName: sourceNames.join(", "),
              destinationLocationId: 0,
              destinationLocationName: destinationName,
              items: [],
              locationCandidates: destMatch.candidates.map((c) => ({ id: c.id, name: `${c.name} (${c.code})` })),
              optional,
            };
            stockTransferResponseOverride = `"${destinationName}" matches more than one location. Please tell me exactly which one you mean before I build the transfer.`;
          } else if (!destMatch.matched) {
            stockTransferResponseOverride = `I couldn't find a location matching "${destinationName}". Please give the exact destination location name.`;
          } else if (sourceNames.length === 0) {
            stockTransferResponseOverride = `Which source location(s) should I pull stock from for the transfer to ${destMatch.matched.name}?`;
          } else if (!targetQty) {
            stockTransferResponseOverride = `How many bales/items in total would you like transferred to ${destMatch.matched.name}?`;
          } else {
            const sourceMatches = await Promise.all(sourceNames.map((n) => matchLocationByName(companyId, n)));
            const matchedSources: { id: number; name: string }[] = [];
            const unresolvedSources: string[] = [];
            sourceMatches.forEach((m, idx) => {
              if (m.matched) matchedSources.push(m.matched);
              else unresolvedSources.push(sourceNames[idx]);
            });

            const usableSources = matchedSources.filter((s) => s.id !== destMatch.matched!.id);
            const sameAsDestination = matchedSources.filter((s) => s.id === destMatch.matched!.id);

            if (matchedSources.length === 0) {
              stockTransferResponseOverride = `I couldn't find any of the source locations you mentioned (${sourceNames.join(", ")}). Please give the exact source location name(s).`;
            } else if (usableSources.length === 0) {
              stockTransferResponseOverride = `The source location(s) you gave (${sameAsDestination.map((s) => s.name).join(", ")}) are the same as the destination (${destMatch.matched.name}) — please give different source location(s) to transfer from.`;
            } else {
              const ctx = await buildStockTransferByTargetQuantityContext(
                companyId,
                usableSources.map((s) => s.id),
                destMatch.matched.id,
                targetQty,
                { onlyDestinationStockGroups }
              );

              const missingNote =
                unresolvedSources.length > 0 ? ` (couldn't find: ${unresolvedSources.join(", ")})` : "";

              if (ctx.noEligibleStock) {
                stockTransferResponseOverride = onlyDestinationStockGroups
                  ? `I didn't find any eligible stock at ${usableSources.map((s) => s.name).join(", ")}${missingNote} in stock groups already carried at ${destMatch.matched.name}, so I did not create a transfer draft.`
                  : `I didn't find any stock available at ${usableSources.map((s) => s.name).join(", ")}${missingNote}, so I did not create a transfer draft.`;
              } else {
                const draftsPayload = ctx.drafts.map((d) => ({
                  date: dateStr,
                  sourceLocationId: d.sourceLocationId,
                  sourceLocationName: d.sourceLocationName,
                  destinationLocationId: d.destinationLocationId,
                  destinationLocationName: d.destinationLocationName,
                  notes: onlyDestinationStockGroups
                    ? `Auto-selected using stock groups already carried at ${destMatch.matched!.name}.`
                    : undefined,
                  optional,
                  analysisSummary: ctx.shortfall
                    ? `Only ${ctx.achievedQty} eligible bale(s)/item(s) found out of requested ${targetQty}${missingNote}.`
                    : missingNote
                      ? `Note:${missingNote}.`
                      : undefined,
                  items: d.items.map((i) => ({
                    stockItemId: i.stockItemId,
                    stockItemName: i.stockItemName,
                    stockItemCode: i.stockItemCode,
                    quantity: i.quantity,
                    currentStock: i.currentStock,
                    destinationQty: i.destinationQty,
                    reason: i.reason,
                  })),
                }));

                if (draftsPayload.length === 1) {
                  stockTransferDraft = draftsPayload[0];
                } else {
                  stockTransferDrafts = draftsPayload;
                }

                const sourcesLabel = usableSources.map((s) => s.name).join("/");
                const draftWord = draftsPayload.length > 1 ? "drafts" : "draft";
                stockTransferResponseOverride = ctx.shortfall
                  ? `Only ${ctx.achievedQty} eligible bale(s)/item(s) found out of requested ${targetQty}${missingNote}. I prepared ${optional ? "optional " : ""}stock transfer ${draftWord} for ${destMatch.matched.name} using the available eligible stock from ${sourcesLabel}. Review below.`
                  : `I prepared ${optional ? "an optional " : ""}stock transfer ${draftWord} for ${ctx.achievedQty} bale(s)/item(s) from ${sourcesLabel} to ${destMatch.matched.name}${missingNote}. Review below.`;
              }
            }
          }
        } else {
          stockTransferResponseOverride =
            'I couldn\'t tell which destination, source location(s), and total quantity you want for this transfer. Could you restate it, e.g. "transfer 410 bales to Kolwezi from Hadi 1,2,3,4"?';
        }
      } else {
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

        const today = new Date().toISOString().slice(0, 10);
        const transferPrompt = `You are a stock transfer extraction assistant.
User message: "${userMessage}"
Today: ${today}
Stock items (id:name:code): ${items.map((i) => `${i.id}:${i.name}:${i.code}`).join(" | ")}
Locations (id:name): ${locs.map((l) => `${l.id}:${l.name}`).join(" | ")}

RULES:
1. Extract a stock transfer only if the user clearly wants to move/transfer stock between locations.
2. Match item names and location names FUZZILY.
3. Extract one source location, one destination location, and a list of items with quantities.
4. Date defaults to today (${today}) if not specified.
5. Also include candidates arrays for disambiguation.

Respond with ONLY valid JSON (no markdown):
{"date":"YYYY-MM-DD","sourceLocationId":NUMBER,"sourceLocationName":"...","destinationLocationId":NUMBER,"destinationLocationName":"...","notes":"...","items":[{"stockItemId":NUMBER,"stockItemName":"...","quantity":NUMBER,"candidates":[{"id":NUMBER,"name":"...","code":"..."}]}],"locationCandidates":[{"id":NUMBER,"name":"..."}]}

If intent is unclear or this is not a stock transfer request, respond with exactly: null`;

        const tfResult = await callAIWithFallback(
          selectedProvider,
          transferPrompt,
          [],
          "Extract stock transfer or return null"
        );
        const rawTf = tfResult.response
          .trim()
          .replace(/```json\n?|```/g, "")
          .trim();
        if (rawTf !== "null" && rawTf.startsWith("{")) {
          const parsedTf: StockTransferChatDraft = JSON.parse(rawTf);
          if (
            parsedTf &&
            parsedTf.sourceLocationId &&
            parsedTf.destinationLocationId &&
            Array.isArray(parsedTf.items) &&
            parsedTf.items.length > 0
          ) {
            // Enrich with currentStock
            for (const item of parsedTf.items ?? []) {
              if (item.stockItemId && parsedTf.sourceLocationId) {
                const invResult = await db.execute(sql`
                  SELECT COALESCE(SUM(CAST(quantity AS numeric)), 0) AS qty
                  FROM inventory
                  WHERE stock_item_id = ${item.stockItemId}
                    AND location_id = ${parsedTf.sourceLocationId}
                    AND company_id = ${companyId}
                `);
                item.currentStock = parseFloat((invResult.rows[0] as { qty: string })?.qty || "0");
              }
            }
            stockTransferDraft = parsedTf;
          }
        }
      }

      // ── Anti-hallucination guard: never let the assistant claim a draft
      // was prepared unless one was actually built above. ────────────────
      if (!stockTransferResponseOverride) {
        if (
          stockTransferDraft &&
          Array.isArray(stockTransferDraft.locationCandidates) &&
          stockTransferDraft.locationCandidates.length > 0 &&
          (!stockTransferDraft.items || stockTransferDraft.items.length === 0)
        ) {
          stockTransferResponseOverride =
            stockTransferDraft.analysisSummary ||
            "That location name matches more than one location. Please tell me exactly which one you mean.";
        } else if (!stockTransferDraft && (!stockTransferDrafts || stockTransferDrafts.length === 0)) {
          stockTransferResponseOverride =
            "I wasn't able to build a stock transfer draft from that — please tell me the exact source location, destination location, and which item(s)/quantities (or a total target quantity) to move.";
        }
      }
    } catch (_) {
      // Extraction failed silently
      if (
        !stockTransferResponseOverride &&
        !stockTransferDraft &&
        (!stockTransferDrafts || stockTransferDrafts.length === 0)
      ) {
        stockTransferResponseOverride =
          "I wasn't able to build a stock transfer draft from that — please tell me the exact source location, destination location, and which item(s)/quantities (or a total target quantity) to move.";
      }
    }
  }

  // `stockTransferResponseOverride` is only ever assigned inside the
  // stock-transfer extraction block above, so applying it here is safe
  // regardless of `classifyChatIntent`'s result — this guards against the
  // LLM's free-text response claiming a draft was prepared when the
  // deterministic/backend logic actually found none (or a different
  // outcome), which previously only applied when intent happened to equal
  // "create_stock_transfer".

  return { stockTransferDraft, stockTransferDrafts, stockTransferResponseOverride };
}

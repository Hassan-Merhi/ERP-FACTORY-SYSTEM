/**
 * Phase 1 data-query handler for the chat service.
 *
 * Runs the AI-classified, read-only ERP data queries (P&L, cash position,
 * statements, …) behind the Phase 1 chat path. Extracted from chatService.ts;
 * behaviour is unchanged — including the silent catch: when the classifier or
 * the query fails, the chat text response is still returned.
 */
import { callAIWithFallback, type AIProvider } from "./aiProviders";
import { runDataQuery } from "./reports";
import { isPhase1DataQuery, buildPhase1DateContext, buildPhase1ClassifierPrompt } from "./phase1Classifier";

export interface Phase1DataQueryRequest {
  userMessage: string;
  companyId: number;
  selectedProvider: AIProvider;
  /** True when a higher-priority draft (voucher/stock/lookup/transfer) already handled the message. */
  skip: boolean;
}

export async function runPhase1DataQuery(request: Phase1DataQueryRequest): Promise<unknown> {
  const { userMessage, companyId, selectedProvider, skip } = request;

  if (skip || !isPhase1DataQuery(userMessage)) return undefined;

  let dataQueryResult: unknown = undefined;

  try {
    const todayDate = new Date();
    const dates = buildPhase1DateContext(todayDate);
    const phase1Prompt = buildPhase1ClassifierPrompt(userMessage, dates);

    const phase1Res = await callAIWithFallback(selectedProvider, phase1Prompt, [], "Classify Phase1 query");
    const rawP1 = phase1Res.response
      .trim()
      .replace(/```json\n?|```/g, "")
      .trim();

    if (rawP1 !== "null" && rawP1.startsWith("{")) {
      const params = JSON.parse(rawP1);
      if (params && params.queryType) {
        const dateFrom: string = params.dateFrom || dates.last30Days;
        const dateTo: string = params.dateTo || dates.todayStr;
        const rowLimit: number = Math.min(params.limit || 10, 50);
        const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 });
        const fmtDec = (n: number) =>
          n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 });

        dataQueryResult = await runDataQuery({
          companyId,
          params,
          dateFrom,
          dateTo,
          todayStr: dates.todayStr,
          todayDate,
          thisMonthStart: dates.thisMonthStart,
          lastMonthStart: dates.lastMonthStart,
          lastMonthEnd: dates.lastMonthEnd,
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

  return dataQueryResult;
}

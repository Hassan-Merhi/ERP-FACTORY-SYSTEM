import { fetchContinuousJson, withContinuousCursor } from "./continuousListClient";

export interface AccountStatementChunk<T> {
  transactions: T[];
  currencySummary?: unknown;
  preNetBalance: number;
  periodPreNetBalance: number;
  periodDebitTotal: number;
  periodCreditTotal: number;
  closingNetBalance: number;
  total: number;
  limit: number;
  asOfDate: string;
  startDate: string | null;
  endDate: string;
  continuous: true;
  chunkOpeningNet: number;
  hasMore: boolean;
  nextCursor: string | null;
}

const STATEMENT_CHUNK_SIZE = 250;

export function fetchAccountStatementChunk<T>(
  baseUrl: string,
  cursor: string | null,
  signal?: AbortSignal
): Promise<AccountStatementChunk<T>> {
  return fetchContinuousJson<AccountStatementChunk<T>>(
    withContinuousCursor(baseUrl, { cursor, limit: STATEMENT_CHUNK_SIZE }),
    { signal, fallbackError: "Failed to load account statement" }
  );
}

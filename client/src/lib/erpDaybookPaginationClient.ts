import {
  collectContinuousChunks,
  fetchContinuousJson,
  withContinuousCursor,
  type ContinuousChunk,
} from "./continuousListClient";

export type ErpDaybookRow =
  | { _type: "voucher"; data: Record<string, unknown> }
  | { _type: "offload"; data: Record<string, unknown> };

export interface ErpDaybookPage {
  items: ErpDaybookRow[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface ErpDaybookChunk extends ContinuousChunk<ErpDaybookRow> {
  limit: number;
  asOf?: string;
}

const ENDPOINT = "/api/daybook";
const EXPORT_CHUNK_SIZE = 250;

function pageUrl(baseParams: URLSearchParams, page: number, limit: number): string {
  const params = new URLSearchParams(baseParams);
  params.set("pagination", "1");
  params.set("page", String(page));
  params.set("limit", String(limit));
  return `${ENDPOINT}?${params.toString()}`;
}

function continuousBaseUrl(baseParams: URLSearchParams): string {
  const suffix = baseParams.toString();
  return suffix ? `${ENDPOINT}?${suffix}` : ENDPOINT;
}

/** Legacy page helper retained while callers outside the full-list view migrate. */
export async function fetchErpDaybookPage(
  baseParams: URLSearchParams,
  page: number,
  limit: number,
  signal?: AbortSignal
): Promise<ErpDaybookPage> {
  const response = await fetch(pageUrl(baseParams, page, limit), { credentials: "include", signal });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(body?.message || "Failed to load transactions");
  }
  return response.json() as Promise<ErpDaybookPage>;
}

export function fetchErpDaybookChunk(
  baseParams: URLSearchParams,
  cursor: string | null,
  limit: number,
  signal?: AbortSignal
): Promise<ErpDaybookChunk> {
  const url = withContinuousCursor(continuousBaseUrl(baseParams), { cursor, limit });
  return fetchContinuousJson<ErpDaybookChunk>(url, { signal, fallbackError: "Failed to load transactions" });
}

export async function fetchAllErpDaybookRows(
  baseParams: URLSearchParams,
  signal?: AbortSignal
): Promise<ErpDaybookRow[]> {
  const result = await collectContinuousChunks<ErpDaybookRow, ErpDaybookChunk>({
    signal,
    load: (cursor, requestSignal) => fetchErpDaybookChunk(baseParams, cursor, EXPORT_CHUNK_SIZE, requestSignal),
  });
  return result.rows;
}

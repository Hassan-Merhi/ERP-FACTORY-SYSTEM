import {
  collectContinuousChunks,
  fetchContinuousJson,
  withContinuousCursor,
  type ContinuousChunk,
} from "./continuousListClient";

export type ErpDaybookRow =
  { _type: "voucher"; data: Record<string, unknown> } | { _type: "offload"; data: Record<string, unknown> };

export interface ErpDaybookChunk extends ContinuousChunk<ErpDaybookRow> {
  limit: number;
  asOf?: string;
}

const ENDPOINT = "/api/daybook";
const EXPORT_CHUNK_SIZE = 250;

function continuousBaseUrl(baseParams: URLSearchParams): string {
  const suffix = baseParams.toString();
  return suffix ? `${ENDPOINT}?${suffix}` : ENDPOINT;
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

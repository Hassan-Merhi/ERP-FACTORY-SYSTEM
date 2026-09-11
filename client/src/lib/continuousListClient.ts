export interface ContinuousChunk<T> {
  items: T[];
  total: number;
  hasMore: boolean;
  nextCursor: string | null;
}

export class ContinuousListHttpError extends Error {
  readonly status: number;
  readonly code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ContinuousListHttpError";
    this.status = status;
    this.code = code;
  }
}

interface ErrorPayload {
  message?: unknown;
  code?: unknown;
}

function errorMessage(payload: ErrorPayload | null, fallback: string): string {
  return typeof payload?.message === "string" && payload.message.trim() ? payload.message : fallback;
}

function errorCode(payload: ErrorPayload | null): string | undefined {
  return typeof payload?.code === "string" && payload.code.trim() ? payload.code : undefined;
}

export async function fetchContinuousJson<TResponse>(
  url: string,
  options: { signal?: AbortSignal; fallbackError: string }
): Promise<TResponse> {
  const response = await fetch(url, { credentials: "include", signal: options.signal });
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as ErrorPayload | null;
    throw new ContinuousListHttpError(
      errorMessage(payload, `${options.fallbackError} (${response.status})`),
      response.status,
      errorCode(payload)
    );
  }
  return response.json() as Promise<TResponse>;
}

export function withContinuousCursor(
  baseUrl: string,
  options: { cursor?: string | null; limit: number }
): string {
  const url = new URL(baseUrl, window.location.origin);
  url.searchParams.delete("pagination");
  url.searchParams.delete("page");
  url.searchParams.delete("offset");
  url.searchParams.set("continuous", "1");
  url.searchParams.set("limit", String(options.limit));
  if (options.cursor) url.searchParams.set("cursor", options.cursor);
  else url.searchParams.delete("cursor");
  return url.origin === window.location.origin ? `${url.pathname}${url.search}${url.hash}` : url.toString();
}

export async function collectContinuousChunks<T, TChunk extends ContinuousChunk<T>>(options: {
  load: (cursor: string | null, signal?: AbortSignal) => Promise<TChunk>;
  signal?: AbortSignal;
  maxChunks?: number;
  onChunk?: (chunk: TChunk, accumulated: readonly T[]) => void;
}): Promise<{ rows: T[]; first: TChunk }> {
  const maxChunks = Math.max(1, options.maxChunks ?? 1000);
  const rows: T[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | null = null;
  let first: TChunk | null = null;

  for (let chunkIndex = 0; chunkIndex < maxChunks; chunkIndex += 1) {
    if (options.signal?.aborted) throw new DOMException("The request was aborted", "AbortError");
    const chunk = await options.load(cursor, options.signal);
    if (!first) first = chunk;
    if (Array.isArray(chunk.items)) rows.push(...chunk.items);
    options.onChunk?.(chunk, rows);

    if (!chunk.hasMore) {
      if (!first) throw new Error("continuous-list-empty-first-chunk");
      return { rows, first };
    }
    if (!chunk.nextCursor || seenCursors.has(chunk.nextCursor)) {
      throw new Error("continuous-list-cursor-stalled");
    }
    seenCursors.add(chunk.nextCursor);
    cursor = chunk.nextCursor;
  }

  throw new Error("continuous-list-chunk-limit");
}

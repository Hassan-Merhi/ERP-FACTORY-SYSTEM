/** Internal bandwidth metrics classification; same thresholds and semantics. */
import type { Request } from "express";

const DEFAULT_THRESHOLD_BYTES = 500 * 1024;
const DEFAULT_STATIC_THRESHOLD_BYTES = 2 * 1024 * 1024;
const DEFAULT_DOCUMENT_THRESHOLD_BYTES = 10 * 1024 * 1024;
export const DEFAULT_API_WINDOW_BUDGET_MB = 50;
export const DEFAULT_STATIC_WINDOW_BUDGET_MB = 20;
export const DEFAULT_ENDPOINT_WINDOW_BUDGET_MB = 20;

export type BandwidthBudgetConfig = {
  apiWindowBytes: number;
  staticWindowBytes: number;
  endpointWindowBytes: number;
};

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function megabytesToBytes(value: string | undefined, fallbackMb: number): number {
  return Math.round(positiveNumber(value, fallbackMb) * 1024 * 1024);
}

function kilobytesToBytes(value: string | undefined, fallbackBytes: number): number {
  return Math.round(positiveNumber(value, fallbackBytes / 1024) * 1024);
}

export function getBandwidthBudgetConfig(): BandwidthBudgetConfig {
  return {
    apiWindowBytes: megabytesToBytes(process.env.BANDWIDTH_DEBUG_API_WINDOW_BUDGET_MB, DEFAULT_API_WINDOW_BUDGET_MB),
    staticWindowBytes: megabytesToBytes(
      process.env.BANDWIDTH_DEBUG_STATIC_WINDOW_BUDGET_MB,
      DEFAULT_STATIC_WINDOW_BUDGET_MB
    ),
    endpointWindowBytes: megabytesToBytes(
      process.env.BANDWIDTH_DEBUG_ENDPOINT_WINDOW_BUDGET_MB,
      DEFAULT_ENDPOINT_WINDOW_BUDGET_MB
    ),
  };
}

export function normalizePath(req: Request): string {
  const routePath = req.route?.path;
  if (typeof routePath === "string") {
    const baseUrl = req.baseUrl || "";
    if (routePath.startsWith("/api/")) return routePath;
    if (baseUrl && (routePath === baseUrl || routePath.startsWith(`${baseUrl}/`))) return routePath;
    return `${baseUrl}${routePath}` || "/";
  }

  return req.path
    .split("/")
    .map((segment) => {
      if (/^\d+$/.test(segment)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(segment)) return ":id";
      return segment;
    })
    .join("/");
}

/** Returns true only for API endpoints included in the API bandwidth ranking. */
export function isApiPath(path: string): boolean {
  return path === "/api" || path.startsWith("/api/");
}

/**
 * Returns true for Vite/webpack hashed static assets such as
 * /assets/index-DdXDEvCM.js or /assets/main-B4tkL4ok.css.
 */
export function isStaticAsset(path: string): boolean {
  return /^\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.(js|css|woff2?|ttf|png|jpe?g|webp|gif|svg|ico)$/i.test(path);
}

export function isDocumentOrExportPath(path: string): boolean {
  return /(?:whatsapp|green-api|pdf|receipt|print|export|download|excel|xlsx|csv|send-invoice-pdf-backend|send-stock-pdf-backend)/i.test(
    path
  );
}

export function getLargeResponseThresholdBytes(path: string): number {
  if (isStaticAsset(path)) {
    return kilobytesToBytes(process.env.BANDWIDTH_DEBUG_STATIC_THRESHOLD_KB, DEFAULT_STATIC_THRESHOLD_BYTES);
  }
  if (isDocumentOrExportPath(path)) {
    return kilobytesToBytes(process.env.BANDWIDTH_DEBUG_DOCUMENT_THRESHOLD_KB, DEFAULT_DOCUMENT_THRESHOLD_BYTES);
  }
  return kilobytesToBytes(process.env.BANDWIDTH_DEBUG_THRESHOLD_KB, DEFAULT_THRESHOLD_BYTES);
}

type CacheOutcome = "hit" | "miss" | "revalidated" | "unknown";

export function classifyCacheOutcome(statusCode: number, cacheHeader: unknown): CacheOutcome {
  if (statusCode === 304) return "revalidated";
  const value = String(cacheHeader || "")
    .trim()
    .toUpperCase();
  if (value === "HIT" || value === "COALESCED") return "hit";
  if (value === "MISS" || value === "BYPASS") return "miss";
  return "unknown";
}

export function isSuspectedLoop(requestCount: number, windowMs: number): boolean {
  const threshold = Math.max(10, Math.ceil(windowMs / 30_000));
  return requestCount >= threshold;
}

export function requestCompanyContext(req: Request): string | null {
  const session = (
    req as Request & {
      session?: { currentCompanyId?: unknown; factoryCompanyId?: unknown };
    }
  ).session;
  const companyId = session?.factoryCompanyId ?? session?.currentCompanyId;
  return companyId == null ? null : String(companyId);
}

export function requestPageContext(req: Request): string | null {
  const explicit = req.get("x-erp-page");
  if (explicit) return explicit.slice(0, 160);
  const referer = req.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer, "http://erp.local").pathname.slice(0, 160);
  } catch {
    return null;
  }
}

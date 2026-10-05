import { getErrorDetails } from "@shared/errorUtils";
import { queryClient, apiRequest } from "./queryClient";
import { attachAccountingRequestIdentity, releaseAccountingRequestIdentity } from "./accountingRequestIdentity";
import { isUnsafeFactoryLoadingScanRequest, purgeUnsafeFactoryLoadingScans } from "./factoryOfflineQueueSafety";
import { isCustomerOrderBaleScanPatch, mergeCustomerOrderBaleScanPatch } from "./customerOrderBaleScanPatch";
import { confirmAction } from "@/components/ConfirmHost";
import {
  forgetHistoricalReplayPreparation,
  freezeHistoricalReplayApplyRequest,
  historicalReplayTokenFromRequest,
  isHistoricalReplayPrepareRequest,
  rememberHistoricalReplayPreparation,
} from "./historicalReplayPreparedRequest";

export type AppMode = "erp" | "factory" | "properties";

const FACTORY_PREFIX = "/api/factory/";
const POST_OFFLOAD_CREATE_PATH = /^\/api\/factory\/containers\/\d+\/post-offload-charges(?:\?.*)?$/;
const POST_OFFLOAD_MUTATION_PATH =
  /^\/api\/factory\/containers\/\d+\/post-offload-charges(?:\/\d+(?:\/legacy-rebuild)?)?(?:\?.*)?$/;
const CUSTOMER_ORDER_BALE_SCAN_PATH = /^\/api\/factory\/customer-orders\/(\d+)\/bales(?:\?.*)?$/;
const ALLOWED_SHARED_PREFIXES = [
  "/api/locations",
  "/api/barcode",
  "/api/auth",
  "/api/company",
  "/api/lookup",
  "/api/chat",
  "/api/bale-transfers",
  "/api/accounts",
  "/api/ledger-accounts",
  "/api/bank-accounts",
  "/api/vouchers",
  "/api/voucher-detail",
  "/api/stock-items",
  "/api/stock-groups",
  "/api/stock-adjustments",
  "/api/stock-transfers",
  "/api/stock-transfer-import",
  "/api/containers",
  "/api/suppliers",
  "/api/customers",
  "/api/employees",
  "/api/employee-groups",
  "/api/worker-groups",
  "/api/stats",
  "/api/financial",
  "/api/reports",
  "/api/dashboard",
  "/api/companies",
  "/api/payroll",
  "/api/company-settings",
  "/api/bale-label-prints",
  "/api/deleted-items",
  "/api/orphaned-records",
  "/api/stock-group-archives",
  "/api/admin",
  "/api/whatsapp",
  "/api/my-erp-pages",
];

interface PostOffloadImpactPreviewResponse {
  confirmationToken: string;
  preview: {
    containerNumber: string;
    currentContainerCostPerKgUsd: string;
    projectedContainerCostPerKgUsd: string;
    fullContainerValueDeltaUsd: string;
    containerRemainingKg: string;
    remainingFraction: string;
    supplierLockedRateBefore: string | null;
    supplierLockedRateProjected: string | null;
    supplierInventoryValueDeltaUsd: string;
    historicalReplaySafe: boolean;
    historicalReplayBlockedReasons: string[];
    scope: {
      supplierOwnedSources: number;
      affectedSourceRows: number;
      affectedBatches: number;
      openBatches: number;
      completedBatches: number;
      availableBales: number;
      finalizedBalesExcluded: number;
    };
  };
}

interface PostOffloadReconciliationResponse {
  postOffloadReconciliation?: {
    reports?: {
      queryKeys?: unknown;
    };
  };
}

// Remove stale loading-scan POSTs before factory screens mount and the offline
// banner has a chance to replay them. These mutations are not safe to defer.
purgeUnsafeFactoryLoadingScans();

function isAllowedFactoryPath(url: string): boolean {
  if (url.startsWith(FACTORY_PREFIX)) return true;
  return ALLOWED_SHARED_PREFIXES.some((p) => url.startsWith(p));
}

type RequestDelegate = (method: string, url: string, data?: unknown) => Promise<Response>;

function money(value: string | number | null | undefined): string {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed)
    ? parsed.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 6 })
    : "0.00";
}

function buildPostOffloadImpactConfirmation(preview: PostOffloadImpactPreviewResponse["preview"]): string {
  const remainingPercent = Math.max(0, Math.min(100, Number(preview.remainingFraction || 0) * 100));
  const lines = [
    `Container: ${preview.containerNumber}`,
    `Container cost/kg: $${money(preview.currentContainerCostPerKgUsd)} → $${money(preview.projectedContainerCostPerKgUsd)}`,
    `Full container value change: $${money(preview.fullContainerValueDeltaUsd)}`,
    `Remaining inventory: ${money(preview.containerRemainingKg)} kg (${remainingPercent.toFixed(2)}%)`,
    `Current inventory value change: $${money(preview.supplierInventoryValueDeltaUsd)}`,
  ];

  if (preview.supplierLockedRateBefore || preview.supplierLockedRateProjected) {
    lines.push(
      `Supplier locked rate: $${money(preview.supplierLockedRateBefore)} → $${money(preview.supplierLockedRateProjected)}`
    );
  }

  lines.push(
    "",
    `Historical scope: ${preview.scope.supplierOwnedSources} supplier source(s), ${preview.scope.affectedBatches} batch(es), ${preview.scope.availableBales} available bale(s).`
  );

  if (preview.scope.completedBatches > 0) {
    lines.push(`${preview.scope.completedBatches} completed batch(es) are included in the protected replay.`);
  }
  if (preview.scope.finalizedBalesExcluded > 0) {
    lines.push(
      `WARNING: ${preview.scope.finalizedBalesExcluded} sold/finalized bale(s) are excluded from automatic replay and will still require the protected admin repair flow.`
    );
  }
  if (!preview.historicalReplaySafe) {
    const reasons = preview.historicalReplayBlockedReasons.join(", ") || "historical replay safety checks failed";
    lines.push(
      `WARNING: Historical replay is currently blocked (${reasons}). The charge can be recorded, but historical production costs may require admin repair.`
    );
  }

  lines.push("", "Continue and save these charges?");
  return lines.join("\n");
}

async function attachPostOffloadImpactPreview(
  delegate: RequestDelegate,
  method: string,
  url: string,
  data: unknown
): Promise<unknown> {
  if (method.toUpperCase() !== "POST" || !POST_OFFLOAD_CREATE_PATH.test(url)) return data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;

  const existing = data as Record<string, unknown>;
  if (existing.impactPreviewVersion === 1 && existing.impactPreviewToken) return data;

  const pathWithoutQuery = url.split("?")[0];
  const previewResponse = await delegate("POST", `${pathWithoutQuery}/preview`, data);
  if (!previewResponse.ok) {
    const payload = await previewResponse.json().catch(() => null);
    const error = Object.assign(new Error(payload?.message || "Failed to preview post-offload cost impact"), {
      status: previewResponse.status,
    });
    throw error;
  }

  const prepared = (await previewResponse.json()) as PostOffloadImpactPreviewResponse;
  if (!prepared?.confirmationToken || !prepared?.preview) {
    throw new Error("Post-offload impact preview returned an incomplete response.");
  }

  const confirmed =
    typeof window === "undefined" ||
    (await confirmAction({
      title: "Review post-offload cost impact",
      description: buildPostOffloadImpactConfirmation(prepared.preview),
    }));
  if (!confirmed) {
    const cancelled: Error & { _handledGlobally?: boolean } = new Error("Post-offload charge save cancelled.");
    cancelled.name = "UserCancelled";
    cancelled._handledGlobally = true;
    throw cancelled;
  }

  return {
    ...existing,
    impactPreviewVersion: 1,
    impactPreviewToken: prepared.confirmationToken,
  };
}

async function invalidatePostOffloadReconciliationQueries(
  method: string,
  url: string,
  response: Response
): Promise<void> {
  const normalizedMethod = method.toUpperCase();
  if (
    !response.ok ||
    !["POST", "PATCH", "DELETE"].includes(normalizedMethod) ||
    !POST_OFFLOAD_MUTATION_PATH.test(url)
  ) {
    return;
  }

  const payload = (await response
    .clone()
    .json()
    .catch(() => null)) as PostOffloadReconciliationResponse | null;
  const rawQueryKeys = payload?.postOffloadReconciliation?.reports?.queryKeys;
  if (!Array.isArray(rawQueryKeys)) return;

  const queryKeys = [...new Set(rawQueryKeys.filter((value): value is string => typeof value === "string"))];
  await Promise.all(
    queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey: [queryKey], refetchType: "active" }))
  );
}

function jsonResponseFrom(source: Response, payload: unknown): Response {
  const headers = new Headers(source.headers);
  headers.set("Content-Type", "application/json");
  headers.delete("Content-Length");
  return new Response(JSON.stringify(payload), {
    status: source.status,
    statusText: source.statusText,
    headers,
  });
}

/**
 * The single-bale endpoint returns a tiny patch instead of re-sending the full
 * order. Rehydrate the existing legacy response shape from TanStack Query cache
 * so both ERP and Factory loading screens can keep their current success flow.
 * A cache-miss fallback performs one full GET; normal scans stay patch-only.
 */
async function hydrateCompactBaleScanResponse(
  delegate: RequestDelegate,
  method: string,
  url: string,
  response: Response
): Promise<Response> {
  if (!response.ok || method.toUpperCase() !== "POST") return response;
  const match = url.match(CUSTOMER_ORDER_BALE_SCAN_PATH);
  if (!match) return response;

  const payload = await response
    .clone()
    .json()
    .catch(() => null);
  if (!isCustomerOrderBaleScanPatch(payload)) return response;

  const orderId = Number(match[1]);
  const queryKey = ["/api/factory/customer-orders", orderId] as const;
  let current = queryClient.getQueryData(queryKey);

  if (!current) {
    try {
      const fullResponse = await delegate(
        "GET",
        `/api/factory/customer-orders/${orderId}?continuationFromOrderId=${orderId}`
      );
      if (fullResponse.ok) current = await fullResponse.json();
    } catch {
      // The scan has already committed. Fall back to the compact order seed
      // rather than turning a successful scan into a false client-side failure.
    }
  }

  const merged = mergeCustomerOrderBaleScanPatch(current, payload);
  queryClient.setQueryData(queryKey, merged);
  return jsonResponseFrom(response, merged);
}

/**
 * Shared replay guard for both ERP and Factory app modes. The UI may pass current
 * checkbox state, but a token-backed apply is rebuilt from the server-prepared
 * frozen state before it reaches apiRequest.
 */
async function requestWithPreparedReplayState(
  delegate: RequestDelegate,
  method: string,
  url: string,
  data?: unknown
): Promise<Response> {
  const prepareRequest = isHistoricalReplayPrepareRequest(method, url, data);
  const token = historicalReplayTokenFromRequest(method, url, data);
  let preparedData = freezeHistoricalReplayApplyRequest(method, url, data);
  preparedData = await attachPostOffloadImpactPreview(delegate, method, url, preparedData);
  const outboundData = attachAccountingRequestIdentity(method, url, preparedData);

  try {
    const response = await delegate(method, url, outboundData);
    releaseAccountingRequestIdentity(method, url, outboundData);
    if (prepareRequest && response.ok) {
      const payload = await response
        .clone()
        .json()
        .catch(() => null);
      rememberHistoricalReplayPreparation(payload);
    }
    await invalidatePostOffloadReconciliationQueries(method, url, response);
    return await hydrateCompactBaleScanResponse(delegate, method, url, response);
  } catch (error) {
    // OfflineQueued means the exact body (including clientRequestId) is persisted.
    // A 4xx is a definite rejection. Keep the identity only for network errors,
    // timeouts, and 5xx responses where the commit outcome may be uncertain.
    if (
      getErrorDetails(error).name === "OfflineQueued" ||
      (Number(getErrorDetails(error).status) >= 400 && Number(getErrorDetails(error).status) < 500)
    ) {
      releaseAccountingRequestIdentity(method, url, outboundData);
    }
    throw error;
  } finally {
    // A token apply is intentionally one-shot in the client. On any response or
    // network error, force a fresh Prepare rather than reusing potentially stale
    // review state. The server independently enforces one-time use transactionally.
    if (token) forgetHistoricalReplayPreparation(token);
  }
}

async function factoryApiRequestBase(method: string, url: string, data?: unknown): Promise<Response> {
  if (!isAllowedFactoryPath(url)) {
    const msg = `[factoryApi] BLOCKED: Factory mode attempted non-factory endpoint: ${method} ${url}`;
    console.error(msg);
    if (import.meta.env.DEV) {
      throw new Error(msg);
    }
  }

  const unsafeLoadingScan = isUnsafeFactoryLoadingScanRequest(method, url);
  purgeUnsafeFactoryLoadingScans();

  try {
    return await apiRequest(method, url, data);
  } catch (error) {
    if (unsafeLoadingScan && getErrorDetails(error).name === "OfflineQueued") {
      purgeUnsafeFactoryLoadingScans();
      const onlineOnlyError = new Error(
        "Loading scans require an internet connection. Reconnect and scan this bale again; it was not queued."
      );
      onlineOnlyError.name = "OnlineRequired";
      throw onlineOnlyError;
    }
    throw error;
  } finally {
    // apiRequest may have just queued a network-failed loading scan. Remove it
    // immediately so reconnecting cannot allocate a stale or different bale.
    purgeUnsafeFactoryLoadingScans();
  }
}

export function factoryApiRequest(method: string, url: string, data?: unknown): Promise<Response> {
  return requestWithPreparedReplayState(factoryApiRequestBase, method, url, data);
}

export const factoryQueryClient = queryClient;

export function resolveApiPath(erpPath: string, factoryPath: string, mode: AppMode): string {
  return mode === "factory" ? factoryPath : erpPath;
}

export function getApiRequest(mode: AppMode): RequestDelegate {
  if (mode === "factory") return factoryApiRequest;
  return (method, url, data) => requestWithPreparedReplayState(apiRequest, method, url, data);
}

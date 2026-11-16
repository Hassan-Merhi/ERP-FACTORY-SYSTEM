import "./bandwidthHotspotGuard";
import "./bandwidthPayloadGuard";
import {
  accountingResponseCode,
  attachAccountingRequestIdentity,
  isProtectedAccountingRequest,
  markAccountingRequestOutcomeUncertain,
  releaseAccountingRequestIdentity,
  shouldReleaseAccountingRequestIdentity,
} from "./accountingRequestIdentity";
import {
  attachPhase5VoucherRequestIdentity,
  markPhase5VoucherRequestOutcomeUncertain,
  releasePhase5VoucherRequestIdentity,
  shouldReleasePhase5VoucherRequestIdentity,
} from "./voucherRequestIdentity";
import { isPhase5OperationalVoucherRequest, type VoucherRequestPayload } from "@shared/voucherPathIdentityPolicy";

function resolvePath(input: RequestInfo | URL): string | null {
  try {
    if (typeof input === "string") return new URL(input, window.location.origin).pathname;
    if (input instanceof URL) return input.pathname;
    if (input instanceof Request) return new URL(input.url, window.location.origin).pathname;
  } catch {
    return null;
  }
  return null;
}

function parseJsonText(text: string): VoucherRequestPayload | null {
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as VoucherRequestPayload) : null;
  } catch {
    return null;
  }
}

async function parseJsonBody(input: RequestInfo | URL, init?: RequestInit): Promise<VoucherRequestPayload | null> {
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body !== "string") return null;
    return parseJsonText(init.body);
  }

  if (input instanceof Request) {
    try {
      const text = await input.clone().text();
      return parseJsonText(text);
    } catch {
      return null;
    }
  }

  return {};
}

/**
 * Adds retry-stable identity to protected accounting JSON writes, including
 * callers that use apiRequest directly instead of the factory request wrapper.
 * Network, 5xx, and fail-closed uncertain outcomes retain the identity. Only a
 * successful response or a definite client rejection releases it.
 *
 * Phase 5 extends the same behavior to the remaining operational voucher
 * families. Bodyless DELETE/PATCH callers receive a tiny JSON identity body;
 * non-JSON/multipart requests are left untouched rather than being corrupted.
 */
export function installAccountingRequestFetchGuard(): void {
  if (
    typeof window === "undefined" ||
    (window as unknown as (Window & typeof globalThis) & { __accountingRequestFetchGuardInstalled: boolean })
      .__accountingRequestFetchGuardInstalled
  )
    return;
  (
    window as unknown as (Window & typeof globalThis) & { __accountingRequestFetchGuardInstalled: true }
  ).__accountingRequestFetchGuardInstalled = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const method = (init?.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
    const pathname = resolvePath(input);
    if (!pathname) return originalFetch(input, init);

    const parsedBody = await parseJsonBody(input, init);
    if (!parsedBody) return originalFetch(input, init);

    const phase5Protected = isPhase5OperationalVoucherRequest(method, pathname);
    const existingProtected = isProtectedAccountingRequest(method, pathname, parsedBody);
    if (!phase5Protected && !existingProtected) return originalFetch(input, init);

    const outboundBody = phase5Protected
      ? attachPhase5VoucherRequestIdentity(method, pathname, parsedBody)
      : (attachAccountingRequestIdentity(method, pathname, parsedBody) as VoucherRequestPayload);

    const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
    if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
    const outboundInit: RequestInit = {
      ...init,
      method,
      headers,
      body: JSON.stringify(outboundBody),
    };

    const response = await originalFetch(input, outboundInit);
    const responseCode = await accountingResponseCode(response);
    const shouldRelease = phase5Protected
      ? shouldReleasePhase5VoucherRequestIdentity(response.status, responseCode)
      : shouldReleaseAccountingRequestIdentity(response.status, responseCode);

    if (shouldRelease) {
      if (phase5Protected) releasePhase5VoucherRequestIdentity(method, pathname, outboundBody, true);
      else releaseAccountingRequestIdentity(method, pathname, outboundBody, true);
    } else if (response.status === 409 || response.status >= 500) {
      // Mark the key before returning the response so outer legacy wrappers
      // cannot accidentally release it while the commit outcome is uncertain.
      if (phase5Protected) markPhase5VoucherRequestOutcomeUncertain(method, pathname, outboundBody);
      else markAccountingRequestOutcomeUncertain(method, pathname, outboundBody);
    }
    return response;
  };
}

installAccountingRequestFetchGuard();

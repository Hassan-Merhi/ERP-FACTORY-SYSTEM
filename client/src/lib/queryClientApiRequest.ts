// Extracted from ./queryClient.ts to keep that module under the source-size cap.
import { offlineError } from "./offline/offlineError";
import { assertPreparedCompanyMutationStillCurrent } from "./companyCacheScope";
import { getErrorDetails } from "@shared/errorUtils";
import { assertCompanyMutationSnapshot, captureCompanyMutationSnapshot } from "./companyCacheScope";
import { OFFLINE_MODE_ENABLED } from "@/lib/featureFlags";
import { coldStartReadOnlyActive } from "./offline/coldStartState";
import { isKnownOffline } from "./offline/connectivityState";
import {
  getAppDate,
  isCsrfTokenMismatch,
  isNetworkError,
  prepareApiRequest,
  resetCsrfToken,
} from "./queryClientGetAppDate";
import { assertCreateOnlyRequestAllowed, queryClient, throwIfResNotOk } from "./queryClientGetQueryFn";

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
  _isRetry = false,
  timeoutMs = 300000
): Promise<Response> {
  assertCreateOnlyRequestAllowed(method, url);
  if (OFFLINE_MODE_ENABLED && method.toUpperCase() === "POST" && url === "/api/vouchers/with-entries") {
    // The existing authenticated query cache holds the user identity. The
    // selected company is only a proposed scope: the sync transport always
    // revalidates it against the active server session before delivery.
    const user = queryClient.getQueryData<{ id?: string | number }>(["/api/auth/me"]);
    const companyId = Number(localStorage.getItem("selectedCompanyId"));
    if (!user?.id || !Number.isSafeInteger(companyId) || companyId <= 0) {
      throw offlineError("OFFLINE_ACTOR_NOT_PREPARED");
    }
    const { submitDurableVoucherWithEntries } = await import("./offline/voucherCapture");
    return submitDurableVoucherWithEntries({ companyId, userId: String(user.id) }, data, getAppDate());
  }
  if (
    OFFLINE_MODE_ENABLED &&
    !["GET", "HEAD", "OPTIONS"].includes(method.toUpperCase()) &&
    (isKnownOffline() || coldStartReadOnlyActive())
  ) {
    // Standalone offline mode: known to be offline BEFORE sending. Supported
    // writes are saved on this device for later delivery to the cloud; every
    // other write is refused with its reason. Never after a send was cut off.
    const { captureOfflineWriteForSignedInUser } = await import("./offline/browserCapture");
    return captureOfflineWriteForSignedInUser(queryClient.getQueryData(["/api/auth/me"]), method, url, data);
  }
  const actionScope = captureCompanyMutationSnapshot(method, new URL(url, "http://localhost").pathname);
  const prepared = await prepareApiRequest(method, url, data, timeoutMs);

  try {
    assertCompanyMutationSnapshot(actionScope);
    const res = await fetch(prepared.url, prepared.init);

    clearTimeout(prepared.timeoutId);

    if (!_isRetry && (await isCsrfTokenMismatch(res))) {
      assertPreparedCompanyMutationStillCurrent(prepared.init.headers);
      assertCompanyMutationSnapshot(actionScope);
      resetCsrfToken();
      return apiRequest(method, url, data, true, timeoutMs);
    }

    await throwIfResNotOk(res);
    // Body/denial handling can yield while another tab rotates the session.
    assertCompanyMutationSnapshot(actionScope);
    return res;
  } catch (error) {
    clearTimeout(prepared.timeoutId);
    if (getErrorDetails(error).name === "AbortError" && prepared.didTimeout()) {
      throw new Error(`Request timeout after ${Math.round(timeoutMs / 1000)} seconds for ${method} ${url}`, {
        cause: error,
      });
    }
    const networkFail = getErrorDetails(error).name === "AbortError" ? true : isNetworkError(error);
    if (OFFLINE_MODE_ENABLED && networkFail) {
      // Phase 1: a generic failed request cannot be made safe by replaying its
      // raw HTTP body. Only explicitly registered operations saved BEFORE
      // transport may use the durable outbox; never fall back to localStorage.
      const rejectedWrite = Object.assign(offlineError("OFFLINE_WRITE_NOT_REGISTERED"), { cause: error });
      rejectedWrite.name = "OfflineWriteNotRegistered";
      throw rejectedWrite;
    }
    throw error;
  }
}

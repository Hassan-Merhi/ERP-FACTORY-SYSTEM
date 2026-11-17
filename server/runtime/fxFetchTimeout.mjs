const FX_API_HOST = "api.frankfurter.app";
const FX_API_TIMEOUT_MS = 5_000;
const INSTALL_MARKER = Symbol.for("erp.fx-fetch-timeout-installed");

function resolveRequestUrl(input) {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  if (input && typeof input.url === "string") return input.url;
  return "";
}

function isFrankfurterRequest(input) {
  try {
    return new URL(resolveRequestUrl(input)).hostname === FX_API_HOST;
  } catch {
    return false;
  }
}

if (typeof globalThis.fetch === "function" && !globalThis[INSTALL_MARKER]) {
  const nativeFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (input, init = {}) => {
    if (!isFrankfurterRequest(input) || init.signal) {
      return nativeFetch(input, init);
    }

    return nativeFetch(input, {
      ...init,
      signal: AbortSignal.timeout(FX_API_TIMEOUT_MS),
    });
  };

  Object.defineProperty(globalThis, INSTALL_MARKER, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
}

export { FX_API_HOST, FX_API_TIMEOUT_MS, isFrankfurterRequest };

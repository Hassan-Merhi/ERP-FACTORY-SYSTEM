import "./lib/requestStormGuard";
import "./lib/forcedApiRefresh";
import "./lib/accountingRequestFetchGuard";
import "./lib/v5AllocationPaginationClient";
import "./lib/operationalPhase4BandwidthFetch";
import "./lib/phase4BandwidthFetch";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import "./mobile-browser-compat.css";
import "./voucher-narration-cleanup.css";
import { installClientObservability } from "./lib/clientObservability";
import { ObservabilityErrorBoundary } from "./components/ObservabilityErrorBoundary";

const ASSET_RECOVERY_PREFIX = "assetRecovery:";
const LEGACY_RECOVERY_PREFIXES = ["swReload:", "chunkReload:", "chunkRetry:"];
const RECOVERY_STABLE_MS = 10_000;
let assetRecoveryInFlight = false;

function pathScopedKey(prefix: string) {
  return `${prefix}${window.location.pathname}`;
}

function isRecoveryMarker(key: string) {
  return key.startsWith(ASSET_RECOVERY_PREFIX) || LEGACY_RECOVERY_PREFIXES.some((prefix) => key.startsWith(prefix));
}

function removeRecoveryMarkersAfterStableLoad() {
  window.setTimeout(() => {
    try {
      const toDelete: string[] = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key && isRecoveryMarker(key)) {
          toDelete.push(key);
        }
      }
      toDelete.forEach((key) => sessionStorage.removeItem(key));
    } catch {
      /* sessionStorage may be blocked */
    }

    const url = new URL(window.location.href);
    const hadRecoveryParam = url.searchParams.has("_asset_recovery");
    const hadServiceWorkerParam = url.searchParams.has("_sw");
    url.searchParams.delete("_asset_recovery");
    url.searchParams.delete("_sw");
    if (hadRecoveryParam || hadServiceWorkerParam) {
      window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    }
  }, RECOVERY_STABLE_MS);
}

function showStaleAssetRecoveryMessage() {
  if (document.getElementById("stale-asset-recovery")) return;

  const panel = document.createElement("div");
  panel.id = "stale-asset-recovery";
  panel.setAttribute("role", "alert");
  panel.style.position = "fixed";
  panel.style.inset = "0";
  panel.style.zIndex = "2147483647";
  panel.style.display = "flex";
  panel.style.alignItems = "center";
  panel.style.justifyContent = "center";
  panel.style.padding = "24px";
  panel.style.background = "rgba(15, 23, 42, 0.96)";
  panel.style.color = "white";
  panel.style.fontFamily = "system-ui, sans-serif";
  panel.style.textAlign = "center";

  const content = document.createElement("div");
  content.style.maxWidth = "460px";

  const title = document.createElement("h1");
  title.textContent = "Application update required";
  title.style.fontSize = "22px";
  title.style.fontWeight = "700";
  title.style.margin = "0 0 12px";

  const description = document.createElement("p");
  description.textContent =
    "The browser could not load the latest application files. Refresh once after checking your connection.";
  description.style.fontSize = "16px";
  description.style.lineHeight = "1.5";
  description.style.margin = "0 0 20px";

  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "Refresh application";
  button.style.minHeight = "44px";
  button.style.padding = "10px 18px";
  button.style.border = "0";
  button.style.borderRadius = "8px";
  button.style.fontSize = "16px";
  button.style.fontWeight = "600";
  button.style.cursor = "pointer";
  button.addEventListener("click", () => {
    try {
      sessionStorage.removeItem(pathScopedKey(ASSET_RECOVERY_PREFIX));
    } catch {
      /* sessionStorage may be blocked */
    }

    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete("_asset_recovery");
    cleanUrl.searchParams.delete("_sw");
    window.location.replace(cleanUrl.toString());
  });

  content.append(title, description, button);
  panel.append(content);
  document.body.append(panel);
}

async function clearErpCachesForRecovery() {
  if (!("serviceWorker" in navigator)) return;

  // Only force a service-worker update during an actual chunk-recovery event.
  // Normal page loads rely on the browser's built-in update checks so every
  // tab does not revalidate and then reload the application independently.
  const registration = await navigator.serviceWorker.getRegistration("/").catch(() => undefined);
  await registration?.update().catch(() => undefined);

  const controller = navigator.serviceWorker.controller;
  if (controller) {
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(resolve, 1500);
      channel.port1.onmessage = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      controller.postMessage({ type: "CLEAR_APP_CACHES" }, [channel.port2]);
    });
    return;
  }

  if ("caches" in window) {
    const keys = await caches.keys().catch(() => []);
    await Promise.all(keys.filter((key) => key.startsWith("erp-")).map((key) => caches.delete(key)));
  }
}

async function recoverFromStaleAssets() {
  if (assetRecoveryInFlight || import.meta.env.DEV) return;

  const currentUrl = new URL(window.location.href);
  const recoveryKey = pathScopedKey(ASSET_RECOVERY_PREFIX);
  let alreadyAttempted = currentUrl.searchParams.has("_asset_recovery");

  try {
    alreadyAttempted = alreadyAttempted || !!sessionStorage.getItem(recoveryKey);
  } catch {
    /* the URL marker still prevents loops when storage is blocked */
  }

  if (alreadyAttempted) {
    showStaleAssetRecoveryMessage();
    return;
  }

  assetRecoveryInFlight = true;
  try {
    sessionStorage.setItem(recoveryKey, String(Date.now()));
  } catch {
    /* continue with the URL marker */
  }

  await clearErpCachesForRecovery().catch(() => undefined);
  currentUrl.searchParams.set("_asset_recovery", String(Date.now()));
  window.location.replace(currentUrl.toString());
}

window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  const candidates: string[] = [];

  if (typeof reason === "string") {
    candidates.push(reason);
  } else if (reason && typeof reason === "object") {
    if (reason.message) candidates.push(String(reason.message));
    if (reason.name) candidates.push(String(reason.name));
    try {
      candidates.push(reason.toString());
    } catch {
      /* ignore */
    }
  }

  const combined = candidates.join(" ");
  const isChunkFailure =
    combined.includes("dynamically imported module") ||
    combined.includes("Loading chunk") ||
    combined.includes("Importing a module script failed") ||
    combined.includes("Unable to preload CSS") ||
    combined.includes("ChunkLoadError") ||
    reason?.name === "ChunkLoadError";

  // A cancelled request is not a stale build. Reloading the page over one
  // discards whatever the user was doing to recover from nothing.
  const isCancellation = reason?.name === "AbortError" || reason?.name === "CancelledError";

  if (isChunkFailure && !isCancellation) {
    event.preventDefault();
    void recoverFromStaleAssets();
  }
});

if ("serviceWorker" in navigator) {
  // Service workers cache Vite's /src and /node_modules/.vite requests. In
  // development that can mix modules from different HMR generations (most
  // visibly as duplicate React invalid-hook warnings), so only install the
  // production worker.
  if (!import.meta.env.DEV) {
    window.addEventListener("load", () => {
      navigator.serviceWorker
        .register("/sw.js", { updateViaCache: "none" })
        .catch(() => {
          return navigator.serviceWorker.register("/sw.js");
        })
        .catch(() => undefined);
    });
  } else {
    // Remove workers installed by older preview builds. Merely stopping new
    // registration is not enough: an existing worker continues intercepting
    // requests until it is explicitly unregistered.
    void navigator.serviceWorker
      .getRegistrations()
      .then((registrations) => Promise.all(registrations.map((registration) => registration.unregister())))
      .then(() => ("caches" in window ? caches.keys() : []))
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith("erp-")).map((key) => caches.delete(key))))
      .catch(() => undefined);
  }

  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event?.data?.type === "SW_UPDATED") {
      // Do not reload every controlled tab. The existing production version
      // banner will offer one user-controlled refresh when the build changes.
      window.dispatchEvent(
        new CustomEvent("erp:service-worker-updated", {
          detail: { version: String(event.data.version || "unknown") },
        })
      );
    } else if (event?.data?.type === "TRIGGER_SYNC") {
      import("./lib/featureFlags").then(({ OFFLINE_MODE_ENABLED }) => {
        if (OFFLINE_MODE_ENABLED) {
          import("./lib/syncEngine").then(({ runSync }) => runSync()).catch(() => {});
        }
      });
    }
  });
}

installClientObservability();

createRoot(document.getElementById("root")!).render(
  <ObservabilityErrorBoundary>
    <App />
  </ObservabilityErrorBoundary>
);
removeRecoveryMarkersAfterStableLoad();
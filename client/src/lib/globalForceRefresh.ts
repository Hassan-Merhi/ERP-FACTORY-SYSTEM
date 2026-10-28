const SESSION_TOKEN_KEY = "erp:global-force-refresh-token";

// Each tab keeps its own last-applied token. Using localStorage would cause
// the first reloaded tab to suppress the update for other open tabs.
let memoryToken: string | null = null;

export function shouldApplyGlobalForceRefresh(token: string): boolean {
  let previous = memoryToken;
  try {
    const stored = sessionStorage.getItem(SESSION_TOKEN_KEY);
    if (stored !== null) previous = stored;
    sessionStorage.setItem(SESSION_TOKEN_KEY, token); // persist BEFORE reload
  } catch {
    // Use the in-memory baseline when sessionStorage is unavailable.
  }
  memoryToken = token;
  return previous !== null && previous !== token;
}

async function clearApplicationCaches(): Promise<void> {
  if (!("caches" in window)) return;
  const keys = await caches.keys();
  await Promise.all(keys.filter((name) => name.startsWith("erp-")).map((name) => caches.delete(name)));
}

async function askWorkerToClearCaches(): Promise<void> {
  const controller = navigator.serviceWorker?.controller;
  if (!controller || typeof MessageChannel === "undefined") return;

  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(resolve, 1200);
    channel.port1.onmessage = () => {
      window.clearTimeout(timeout);
      channel.port1.close();
      resolve();
    };
    try {
      controller.postMessage({ type: "CLEAR_APP_CACHES" }, [channel.port2]);
    } catch {
      window.clearTimeout(timeout);
      resolve();
    }
  });
}

let reloadStarted = false;

export async function applyGlobalForceRefresh(token: string): Promise<void> {
  if (reloadStarted) return;
  reloadStarted = true;

  // The registered worker normally uses network-first navigation, but stale
  // cached HTML/assets in an installed PWA must not survive a forced reload.
  try {
    if ("serviceWorker" in navigator) {
      await askWorkerToClearCaches();
    }
    await clearApplicationCaches();
  } catch {
    // A cache API failure must not suppress the requested page reload.
  }

  const url = new URL(window.location.href);
  url.searchParams.set("_force_refresh", token);
  window.location.replace(url.toString());
}

const SESSION_TOKEN_KEY = "erp:global-force-refresh-token";
const FORCE_REFRESH_NOTICE_ID = "erp-global-force-refresh-notice";
export const FORCE_REFRESH_COUNTDOWN_MS = 5_000;

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

export function secondsUntilForceRefresh(deadlineMs: number, nowMs: number): number {
  return Math.max(0, Math.ceil((deadlineMs - nowMs) / 1_000));
}

function showForceRefreshNotice(): (seconds: number) => void {
  // A fixed notice is visible on every route, including full-screen scanner
  // pages. It has no accept/cancel button: the command is already authorized.
  const notice = document.createElement("div");
  notice.id = FORCE_REFRESH_NOTICE_ID;
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  notice.setAttribute("data-testid", "global-force-refresh-notice");
  notice.style.cssText =
    "position:fixed;top:12px;left:12px;right:12px;z-index:2147483646;" +
    "box-sizing:border-box;max-width:560px;margin:0 auto;padding:16px 20px;" +
    "border-radius:12px;background:#14243d;color:white;text-align:center;" +
    "box-shadow:0 10px 32px rgba(0,0,0,.32);font:600 16px/1.5 system-ui,sans-serif;";

  const title = document.createElement("div");
  title.textContent = "System refresh in 5 seconds";
  const detail = document.createElement("div");
  detail.textContent = "The system will refresh automatically. Please save your work.";
  detail.style.cssText = "font-size:13px;font-weight:400;opacity:.9;margin-top:4px;";
  notice.append(title, detail);
  document.body.appendChild(notice);

  return (seconds: number) => {
    title.textContent = seconds > 0
      ? `System refresh in ${seconds} second${seconds === 1 ? "" : "s"}`
      : "Refreshing system…";
  };
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

  const updateNotice = showForceRefreshNotice();
  const deadline = Date.now() + FORCE_REFRESH_COUNTDOWN_MS;
  updateNotice(secondsUntilForceRefresh(deadline, Date.now()));

  // Clear only web app caches during the five-second notice. Never delete
  // IndexedDB offline scans or authentication/session cookies.
  const cacheCleanup = (async () => {
    try {
      if ("serviceWorker" in navigator) await askWorkerToClearCaches();
      await clearApplicationCaches();
    } catch {
      // Cache errors must never block an authorized refresh.
    }
  })();

  await new Promise<void>((resolve) => {
    const interval = window.setInterval(() => {
      const seconds = secondsUntilForceRefresh(deadline, Date.now());
      updateNotice(seconds);
      if (seconds === 0) {
        window.clearInterval(interval);
        resolve();
      }
    }, 200);
  });

  // Do not stall on unusual browser cache failures; the cache-busting URL and
  // network-first navigation also fetch the current application build.
  await Promise.race([cacheCleanup, new Promise<void>((resolve) => window.setTimeout(resolve, 200))]);
  const url = new URL(window.location.href);
  url.searchParams.set("_force_refresh", token);
  window.location.replace(url.toString());
}

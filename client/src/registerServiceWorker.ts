const UPDATE_CHECK_MIN_INTERVAL_MS = 60_000;
const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;

let activeRegistration: ServiceWorkerRegistration | undefined;
let lastUpdateCheckAt = 0;
let hadControllerAtStartup = false;

async function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  try {
    return await navigator.serviceWorker.register("/sw.js", { updateViaCache: "none" });
  } catch {
    try {
      // Older browsers may not understand updateViaCache. Keep the original
      // registration path as a compatibility fallback.
      return await navigator.serviceWorker.register("/sw.js");
    } catch {
      return undefined;
    }
  }
}

async function checkForServiceWorkerUpdate() {
  if (!activeRegistration) return;

  const now = Date.now();
  if (now - lastUpdateCheckAt < UPDATE_CHECK_MIN_INTERVAL_MS) return;
  lastUpdateCheckAt = now;

  await activeRegistration.update().catch(() => undefined);
}

function notifyUpdatedWorker() {
  // A newly activated worker must never discard unsaved forms, scanner state,
  // or pending voucher entries just because the user returned to the tab.
  // The app's UpdateBanner already offers a deliberate Refresh action.
  if (!hadControllerAtStartup) {
    hadControllerAtStartup = true;
    return;
  }
  window.dispatchEvent(new Event("erp:service-worker-updated"));
}

if ("serviceWorker" in navigator) {
  hadControllerAtStartup = !!navigator.serviceWorker.controller;

  navigator.serviceWorker.addEventListener?.("controllerchange", notifyUpdatedWorker);

  window.addEventListener("load", () => {
    void registerServiceWorker().then((registration) => {
      activeRegistration = registration;
      return checkForServiceWorkerUpdate();
    });
  });

  const requestVisibleUpdateCheck = () => {
    if (document.visibilityState !== "visible") return;
    void checkForServiceWorkerUpdate();
  };

  document.addEventListener("visibilitychange", requestVisibleUpdateCheck);
  window.addEventListener("focus", requestVisibleUpdateCheck);

  window.setInterval(() => {
    if (document.visibilityState === "visible") {
      void checkForServiceWorkerUpdate();
    }
  }, UPDATE_CHECK_INTERVAL_MS);
}

const CACHE_VERSION = "erp-v12";
const CACHE_PREFIX = "erp-";
// One-time campaign marker kept outside CACHE_PREFIX so normal ERP cache cleanup
// cannot erase it and accidentally trigger this migration again later.
const IOS_FORCE_UPDATE_CAMPAIGN = "ios-pwa-2026-09-30-v1";
const IOS_FORCE_UPDATE_MARKER_CACHE = `hmd-force-update-${IOS_FORCE_UPDATE_CAMPAIGN}`;
const IOS_FORCE_UPDATE_MARKER_URL = "/__pwa_force_update_applied__";
const APP_SHELL = ["/", "/manifest.json"];
const MAX_STATIC_CACHE_ENTRIES = 200;
const HASHED_ASSET_RE =
  /^\/assets\/[^/]+-[A-Za-z0-9_-]{6,}\.(?:js|css|woff2?|ttf|png|jpe?g|webp|svg|ico)$/i;
const LABEL_PREVIEW_RE = /^\/labels\/previews\/[^/]+-preview\.webp$/i;

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      cache.addAll(APP_SHELL.map((url) => new Request(url, { cache: "reload" })))
    )
  );
});

self.addEventListener("activate", (event) => {
  const navigationPreload = self.registration.navigationPreload?.enable?.() ?? Promise.resolve();
  event.waitUntil(
    Promise.all([deleteErpCachesExcept(CACHE_VERSION), navigationPreload.catch(() => {})])
      .then(() => self.clients.claim())
      .then(async () => {
        const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
        clients.forEach((client) => client.postMessage({ type: "SW_UPDATED", version: CACHE_VERSION }));
        await runOneTimeIosForceUpdate(clients);
      })
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "CLEAR_APP_CACHES") {
    event.waitUntil(
      deleteAllErpCaches().then(() => {
        event.ports?.[0]?.postMessage({ type: "APP_CACHES_CLEARED", version: CACHE_VERSION });
      })
    );
  }
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.method !== "GET" || request.headers.has("range")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith("/api/")) {
    event.respondWith(networkOnlyApi(request));
  } else if (request.mode === "navigate") {
    event.respondWith(navigationHandler(event));
  } else if (HASHED_ASSET_RE.test(url.pathname)) {
    event.respondWith(cacheFirstHashedAsset(request));
  } else if (isVersionedLabelAsset(url)) {
    event.respondWith(cacheFirstVersionedAsset(request));
  } else if (
    url.pathname.startsWith("/assets/") ||
    url.pathname.startsWith("/node_modules/.vite/") ||
    url.pathname.startsWith("/src/")
  ) {
    event.respondWith(networkFirstAsset(request));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});

function isVersionedLabelAsset(url) {
  if (LABEL_PREVIEW_RE.test(url.pathname)) return true;
  return url.pathname.startsWith("/labels/") && url.searchParams.has("t");
}

async function deleteErpCachesExcept(keepName) {
  const keys = await caches.keys();
  await Promise.all(
    keys.filter((key) => key.startsWith(CACHE_PREFIX) && key !== keepName).map((key) => caches.delete(key))
  );
}

function isIosWebAppRuntime() {
  const userAgent = self.navigator?.userAgent || "";
  return /iPad|iPhone|iPod/i.test(userAgent) || (/Macintosh/i.test(userAgent) && /Mobile/i.test(userAgent));
}

async function runOneTimeIosForceUpdate(windowClients) {
  if (!isIosWebAppRuntime()) return;

  const markerCache = await caches.open(IOS_FORCE_UPDATE_MARKER_CACHE);
  if (await markerCache.match(IOS_FORCE_UPDATE_MARKER_URL)) return;

  // Write the marker before navigating. If iOS re-fires lifecycle events while
  // replacing the page, the same campaign can never become a refresh loop.
  await markerCache.put(
    IOS_FORCE_UPDATE_MARKER_URL,
    new Response(IOS_FORCE_UPDATE_CAMPAIGN, {
      headers: { "Content-Type": "text/plain", "Cache-Control": "no-store" },
    })
  );

  await Promise.all(
    windowClients.map(async (client) => {
      if (typeof client.navigate !== "function") return;
      try {
        const url = new URL(client.url);
        if (url.origin !== self.location.origin) return;
        url.searchParams.set("_pwa_update", IOS_FORCE_UPDATE_CAMPAIGN);
        await client.navigate(url.toString());
      } catch {
        // The next launch still gets the new worker and network-first HTML.
      }
    })
  );
}

async function deleteAllErpCaches() {
  const keys = await caches.keys();
  await Promise.all(keys.filter((key) => key.startsWith(CACHE_PREFIX)).map((key) => caches.delete(key)));
}

async function putBounded(cache, request, response) {
  await cache.put(request, response);
  const keys = await cache.keys();
  const overflow = keys.length - MAX_STATIC_CACHE_ENTRIES;
  if (overflow <= 0) return;
  await Promise.all(keys.slice(0, overflow).map((key) => cache.delete(key)));
}

function rejectHtmlAssetResponse(response) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html")) return null;
  return new Response("Asset response was HTML", {
    status: 503,
    headers: { "Content-Type": "text/plain" },
  });
}

async function networkOnlyApi(request) {
  try {
    return await fetch(request.clone(), { cache: "no-store" });
  } catch {
    return new Response(JSON.stringify({ error: "Offline", offline: true }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function navigationHandler(event) {
  const request = event.request;
  try {
    const preloaded = await event.preloadResponse;
    const response = preloaded || (await fetch(request.clone(), { cache: "no-store" }));
    if (response.ok) {
      const contentType = response.headers.get("content-type") || "";
      if (contentType.includes("text/html")) {
        const cache = await caches.open(CACHE_VERSION);
        await cache.put("/", response.clone());
      }
      return response;
    }
    throw new Error("Network response not ok");
  } catch {
    const cached = await caches.match("/");
    if (cached) return cached;
    return new Response("Offline — please check your connection.", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

async function cacheFirstHashedAsset(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request.clone());
    const invalidResponse = rejectHtmlAssetResponse(response);
    if (invalidResponse) return invalidResponse;
    if (response.ok) await putBounded(cache, request, response.clone());
    return response;
  } catch {
    return new Response("Asset unavailable offline", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

async function cacheFirstVersionedAsset(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request.clone());
    const invalidResponse = rejectHtmlAssetResponse(response);
    if (invalidResponse) return invalidResponse;
    if (response.ok) await putBounded(cache, request, response.clone());
    return response;
  } catch {
    return new Response("Asset unavailable offline", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

async function networkFirstAsset(request) {
  const cache = await caches.open(CACHE_VERSION);
  try {
    const response = await fetch(request.clone(), { cache: "no-store" });
    const invalidResponse = rejectHtmlAssetResponse(response);
    if (invalidResponse) return invalidResponse;
    if (response.ok) await putBounded(cache, request, response.clone());
    return response;
  } catch {
    const cached = await cache.match(request);
    if (cached) return cached;
    return new Response("Asset unavailable offline", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

async function staleWhileRevalidate(request) {
  const cache = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request.clone())
    .then(async (response) => {
      if (response.ok) {
        const contentType = response.headers.get("content-type") || "";
        if (!contentType.includes("text/html")) {
          await putBounded(cache, request, response.clone());
        }
      }
      return response;
    })
    .catch(() => null);

  if (cached) return cached;
  const networkResponse = await fetchPromise;
  if (networkResponse) return networkResponse;
  return new Response("Asset unavailable", {
    status: 503,
    headers: { "Content-Type": "text/plain" },
  });
}

self.addEventListener("sync", (event) => {
  if (event.tag === "erp-sync") {
    event.waitUntil(
      self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
        clients.forEach((client) => client.postMessage({ type: "TRIGGER_SYNC" }));
      })
    );
  }
});

self.addEventListener("push", (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || "ERP Notification", {
        body: data.body || "",
        icon: "/favicon.png",
        tag: data.tag || "erp-notification",
      })
    );
  } catch {
    // Ignore malformed push payloads.
  }
});

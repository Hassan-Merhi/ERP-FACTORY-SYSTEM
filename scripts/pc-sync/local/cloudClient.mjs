// Full offline mode (Phase A3): the PC's connection to the cloud, signed in as
// the person using the PC. Only the cookie of that sign-in is kept, in memory;
// the desktop app may store it with the operating system's protected storage.

import { PcSyncAgentError } from "./syncAgent.mjs";

/**
 * @param {string} baseUrl e.g. https://www.hmdinternationalgroup.com
 * @param {{ fetch?: typeof fetch, cookie?: string, timeoutMs?: number }} [options]
 */
export function createCloudClient(baseUrl, { fetch: doFetch = fetch, cookie = "", timeoutMs = 60_000 } = {}) {
  const origin = new URL(baseUrl);
  if (origin.protocol !== "https:" && origin.hostname !== "127.0.0.1" && origin.hostname !== "localhost") {
    throw new PcSyncAgentError("PC_SYNC_CLOUD_URL_INSECURE");
  }
  let sessionCookie = cookie;

  async function call(method, path, { query, body, bytes, headers: extra } = {}) {
    if (!path.startsWith("/api/")) throw new PcSyncAgentError("PC_SYNC_CLOUD_PATH_INVALID");
    const url = new URL(path, origin);
    for (const [name, value] of Object.entries(query ?? {})) {
      if (value != null) url.searchParams.set(name, String(value));
    }
    if (url.origin !== origin.origin) throw new PcSyncAgentError("PC_SYNC_CLOUD_PATH_INVALID");
    const res = await doFetch(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        accept: "application/json",
        ...(body ? { "content-type": "application/json" } : {}),
        ...(bytes ? { "content-type": "application/octet-stream" } : {}),
        ...(extra ?? {}),
        ...(sessionCookie ? { cookie: sessionCookie } : {}),
      },
      body: bytes ?? (body ? JSON.stringify(body) : undefined),
    });
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    if (setCookies.length) sessionCookie = setCookies.map((c) => c.split(";")[0]).join("; ");
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  }

  return {
    get: (path, query) => call("GET", path, { query }),
    post: (path, body) => call("POST", path, { body: body ?? {} }),
    /** Sends raw bytes (a file) with the given headers. */
    postBytes: (path, bytes, headers) => call("POST", path, { bytes, headers }),
    /** Signs in; returns the user id. */
    async login(username, password) {
      const res = await call("POST", "/api/auth/login", { body: { username, password } });
      if (res.status !== 200) throw new PcSyncAgentError("PC_SYNC_LOGIN_REFUSED", { status: res.status });
      const me = await call("GET", "/api/auth/me");
      const userId = me.body?.id ?? me.body?.user?.id;
      if (me.status !== 200 || typeof userId !== "string") {
        throw new PcSyncAgentError("PC_SYNC_LOGIN_REFUSED", { status: me.status });
      }
      return userId;
    },
    cookie: () => sessionCookie,
  };
}

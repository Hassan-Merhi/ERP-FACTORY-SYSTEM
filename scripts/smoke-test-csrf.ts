/**
 * CSRF smoke test — drives a real browser-style session through the full
 * synchronizer-token flow against a running server (default http://localhost:5000)
 * and asserts the expected enforcement behaviour at every step.
 *
 * Covers:
 *   1. GET  /api/csrf-token            → expect 200 + token in body
 *   2. POST /api/foo without token     → expect 403 (CSRF_TOKEN_MISMATCH)
 *   3. POST /api/foo with wrong token  → expect 403 (CSRF_TOKEN_MISMATCH)
 *   4. POST /api/foo with right token  → expect non-403 (route may 401/404, that's fine)
 *   5. POST /api/foo cross-origin      → expect 403 (CSRF_ORIGIN_MISMATCH)
 *   6. POST /api/user-presence/leave   → expect non-403 (sendBeacon-exempt path)
 *
 * NOTE on cookies: the session cookie is `Secure` when NODE_ENV=production OR
 * REPL_ID is set (server/index.ts:124). Express only writes Set-Cookie on
 * secure connections, so plain `http://localhost:5000` from inside the Replit
 * environment will get NO Set-Cookie back — every request becomes a fresh
 * session and the CSRF middleware's "no token in session yet" passthrough
 * fires, causing steps 2–3 to wrongly return 200/401 instead of 403. The
 * script detects this and aborts with a clear instruction.
 *
 * USAGE:
 *   tsx scripts/smoke-test-csrf.ts                              # localhost (only works outside Replit)
 *   tsx scripts/smoke-test-csrf.ts --host=https://myapp.replit.dev   # full HTTPS flow
 */

const HOST = (process.argv.find((a) => a.startsWith("--host=")) || "--host=http://localhost:5000").split("=")[1];

// Real endpoint used to probe CSRF enforcement. Must (a) exist on the server
// (otherwise Vite's catch-all serves index.html with 200, defeating the test)
// and (b) accept POST. /api/customers does both — it returns 401 when the
// token is valid (auth required) and 403 when CSRF blocks first.
const PROBE_PATH = "/api/customers";

// Tiny manual cookie jar — captures Set-Cookie name=value pairs and replays
// them on subsequent requests. Good enough for a same-origin smoke test; we
// don't need full RFC 6265 path/domain/expiry semantics.
const cookies = new Map<string, string>();

function captureSetCookie(res: Response): void {
  // getSetCookie() is Node 20+; fallback to raw header split for safety.
  const raw: string[] =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : (res.headers.get("set-cookie") || "").split(/,(?=[^;]+=)/g).filter(Boolean);
  for (const c of raw) {
    const [pair] = c.split(";");
    const eq = pair.indexOf("=");
    if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
}

function cookieHeader(): string {
  return Array.from(cookies.entries()).map(([k, v]) => `${k}=${v}`).join("; ");
}

async function jarFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = HOST + path;
  const headers = new Headers(init.headers);
  const ck = cookieHeader();
  if (ck) headers.set("Cookie", ck);
  if (!headers.has("Origin")) headers.set("Origin", new URL(HOST).origin);
  const res = await fetch(url, { ...init, headers });
  captureSetCookie(res);
  return res;
}

let pass = 0;
let fail = 0;

function check(label: string, ok: boolean, extra?: string): void {
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}${extra ? "  " + extra : ""}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${extra ? "  " + extra : ""}`);
  }
}

async function run(): Promise<void> {
  console.log(`\nCSRF smoke test against ${HOST}\n`);

  // Step 1: fetch token
  const r1 = await jarFetch("/api/csrf-token");
  const body1: unknown = await r1.json().catch(() => ({}));
  const token = body1 !== null && typeof body1 === "object" && "csrfToken" in body1 && typeof body1.csrfToken === "string"
    ? body1.csrfToken
    : undefined;
  check("GET /api/csrf-token returns 200", r1.status === 200);
  check(
    "GET /api/csrf-token returns hex token",
    typeof token === "string" && /^[a-f0-9]{64}$/.test(token),
    token ? `(${token.slice(0, 12)}…)` : "",
  );
  if (!token) {
    console.log("\n  Cannot continue without a token from /api/csrf-token.");
    process.exit(1);
  }
  if (cookies.size === 0) {
    console.log(
      "\n  ✗ No session cookie was issued by the server.\n" +
      "    The session cookie is configured as Secure (NODE_ENV=production OR REPL_ID set),\n" +
      "    so Express will not write Set-Cookie on a plain-HTTP connection. CSRF\n" +
      "    enforcement requires session continuity between the GET-token call and\n" +
      "    the subsequent POSTs, so the test cannot proceed.\n\n" +
      "    Fix: rerun against the HTTPS dev URL —\n" +
      "      tsx scripts/smoke-test-csrf.ts --host=https://<your-replit-dev-domain>\n",
    );
    process.exit(1);
  }

  // Step 2: POST without token
  const r2 = await jarFetch(PROBE_PATH, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check(`POST ${PROBE_PATH} without X-CSRF-Token → 403`, r2.status === 403, `(got ${r2.status})`);

  // Step 3: POST with wrong token
  const r3 = await jarFetch(PROBE_PATH, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": "deadbeef" }, body: "{}" });
  check(`POST ${PROBE_PATH} with wrong X-CSRF-Token → 403`, r3.status === 403, `(got ${r3.status})`);

  // Step 4: POST with correct token
  const r4 = await jarFetch(PROBE_PATH, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": token }, body: "{}" });
  check(`POST ${PROBE_PATH} with correct X-CSRF-Token → not 403`, r4.status !== 403, `(got ${r4.status} — 401/404 are fine)`);

  // Step 5: cross-origin POST with correct token
  const r5 = await jarFetch(PROBE_PATH, { method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": token, "Origin": "https://evil.example.com" }, body: "{}" });
  check("Cross-origin POST → 403 (origin guard)", r5.status === 403, `(got ${r5.status})`);

  // Step 6: sendBeacon-exempt path with NO token
  const r6 = await jarFetch("/api/user-presence/leave", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  check("POST /api/user-presence/leave without token → not 403", r6.status !== 403, `(got ${r6.status} — 401/404 are fine)`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error("smoke test crashed:", e);
  process.exit(1);
});

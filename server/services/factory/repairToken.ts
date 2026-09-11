/**
 * Generic signed, expiring confirmation-token helper for admin repair flows
 * (raw-material FX resolution, raw-stock recalculation, and any future
 * "preview now / apply later" financial repair endpoint).
 *
 * A token is NOT just an opaque hash of a few fields — it's a base64url JSON
 * payload plus an HMAC signature (keyed by SESSION_SECRET, the same signing
 * key already used elsewhere in this codebase for session/security tokens).
 * This lets the payload carry an arbitrary, explicit set of bound fields
 * (companyId, source, row id, new value, old stored value, old confirmed
 * state, a version/timestamp column, the requesting user/session, and an
 * expiry) and lets the verifier recover those fields WITHOUT needing a
 * separate server-side store — the token itself is self-describing and
 * tamper-evident.
 *
 * Verification only proves the token was issued by this server for exactly
 * this payload and has not expired. It is the CALLER's job to also re-derive
 * the current state fresh from the database and compare it against the
 * embedded old-value/version fields — that's what catches a "stale" token
 * (issued against a row that has since changed).
 */
import crypto from "node:crypto";

// Never a real production secret — only ever used in non-production environments,
// and only when the caller hasn't supplied a real SESSION_SECRET at all (local dev
// without a .env, or a test run that hasn't injected its own test secret yet).
const DEV_FALLBACK_SIGNING_KEY = "dev-fallback-repair-token-key-not-for-production";

export class InvalidRepairTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid confirmation token: ${reason}`);
    this.name = "InvalidRepairTokenError";
  }
}

export class ExpiredRepairTokenError extends Error {
  constructor() {
    super("Confirmation token has expired — re-run the dry-run preview to get a fresh one.");
    this.name = "ExpiredRepairTokenError";
  }
}

/** Thrown instead of ever signing/verifying a repair token with a fallback key
 * in production. Routes must catch this and return a configuration error
 * WITHOUT performing any write — a repair token is meaningless security theater
 * if it's signed with a key every deployment shares. */
export class RepairTokenConfigurationError extends Error {
  constructor() {
    super(
      "SESSION_SECRET is not configured (or is still the development fallback) — repair confirmation tokens " +
        "cannot be safely issued or verified in production. Set a strong, unique SESSION_SECRET first."
    );
    this.name = "RepairTokenConfigurationError";
  }
}

/**
 * Resolves the signing key fresh on every call (never cached at module load)
 * so tests can inject their own SESSION_SECRET at any point and repair-token
 * behavior picks it up immediately. In production, a missing or dev-fallback
 * SESSION_SECRET is a hard failure — never silently signs with a shared,
 * guessable key. Outside production (dev/test with no secret configured at
 * all), the dev fallback is allowed so local development keeps working.
 */
function getSigningKey(): string {
  const configured = process.env.SESSION_SECRET;
  const isProduction = process.env.NODE_ENV === "production";
  if (!configured || configured === DEV_FALLBACK_SIGNING_KEY) {
    if (isProduction) throw new RepairTokenConfigurationError();
    return DEV_FALLBACK_SIGNING_KEY;
  }
  return configured;
}

function hmac(payload: string): string {
  return crypto.createHmac("sha256", getSigningKey()).update(payload).digest("hex");
}

/** Signs an arbitrary JSON-serializable payload. Caller must include an
 * `expiresAt` (epoch ms) field in `payload` for expiry to be enforced.
 * Throws RepairTokenConfigurationError in production without a real
 * SESSION_SECRET — callers must catch this and refuse the request, never
 * fall back to issuing a token anyway. */
export function signRepairToken(payload: object): string {
  const json = JSON.stringify(payload);
  const encoded = Buffer.from(json, "utf8").toString("base64url");
  const signature = hmac(encoded);
  return `${encoded}.${signature}`;
}

/** Verifies signature + expiry and returns the embedded payload. Throws
 * InvalidRepairTokenError (malformed/tampered) or ExpiredRepairTokenError. */
export function verifyRepairToken<T = Record<string, unknown>>(token: string): T {
  if (typeof token !== "string" || !token.includes(".")) {
    throw new InvalidRepairTokenError("malformed token");
  }
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) throw new InvalidRepairTokenError("malformed token");

  const expectedSignature = hmac(encoded);
  const sigBuf = Buffer.from(signature, "utf8");
  const expectedBuf = Buffer.from(expectedSignature, "utf8");
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    throw new InvalidRepairTokenError("signature mismatch");
  }

  let payload: T & { expiresAt?: number };
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new InvalidRepairTokenError("malformed payload");
  }

  if (typeof payload.expiresAt === "number" && Date.now() > payload.expiresAt) {
    throw new ExpiredRepairTokenError();
  }

  return payload;
}

/** Standard TTL for repair confirmation tokens: long enough for an admin to
 * review a dry-run preview, short enough that a leaked/stale token is not a
 * standing risk. */
export const REPAIR_TOKEN_TTL_MS = 15 * 60 * 1000;

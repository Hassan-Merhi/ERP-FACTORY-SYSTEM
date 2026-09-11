import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const CURSOR_VERSION = 1;
const TEST_SECRET = "erp-continuous-cursor-test-secret";

export class ContinuousCursorError extends Error {
  readonly code = "INVALID_CONTINUOUS_CURSOR";

  constructor(message = "invalid-continuous-cursor") {
    super(message);
    this.name = "ContinuousCursorError";
  }
}

function cursorSecret(): string {
  const configured = process.env.CONTINUOUS_CURSOR_SECRET || process.env.SESSION_SECRET;
  if (configured && configured.length >= 16) return configured;
  if (process.env.NODE_ENV === "test") return TEST_SECRET;
  throw new Error("continuous-cursor-secret-missing");
}

function signature(body: string): Buffer {
  return createHmac("sha256", cursorSecret()).update(body).digest();
}

/** Build a compact deterministic scope so a cursor cannot cross tenant/filter/query boundaries. */
export function continuousCursorScope(prefix: string, identity: unknown): string {
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("base64url").slice(0, 24);
  return `${prefix}:${digest}`;
}

export function encodeContinuousCursor<T>(scope: string, payload: T): string {
  const body = Buffer.from(JSON.stringify({ v: CURSOR_VERSION, scope, payload }), "utf8").toString("base64url");
  return `${body}.${signature(body).toString("base64url")}`;
}

export function decodeContinuousCursor<T>(scope: string, token: string): T {
  const [body, encodedSignature, ...extra] = token.split(".");
  if (!body || !encodedSignature || extra.length > 0) throw new ContinuousCursorError();

  let supplied: Buffer;
  try {
    supplied = Buffer.from(encodedSignature, "base64url");
  } catch {
    throw new ContinuousCursorError();
  }
  const expected = signature(body);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new ContinuousCursorError();
  }

  try {
    const envelope = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      v?: unknown;
      scope?: unknown;
      payload?: T;
    };
    if (envelope.v !== CURSOR_VERSION || envelope.scope !== scope || envelope.payload === undefined) {
      throw new ContinuousCursorError();
    }
    return envelope.payload;
  } catch (error) {
    if (error instanceof ContinuousCursorError) throw error;
    throw new ContinuousCursorError();
  }
}

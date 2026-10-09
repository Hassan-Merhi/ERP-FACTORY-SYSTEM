/**
 * Unguessable idempotency key for retail writes (sales, exchanges, stock operations,
 * intake). Uses Web Crypto only: randomUUID where available, otherwise 128 random
 * bits from getRandomValues, which every supported browser and WebView provides.
 */
export function makeRetailIdempotencyKey(prefix: string): string {
  let token: string;
  if (typeof crypto.randomUUID === "function") {
    token = crypto.randomUUID();
  } else {
    const bytes = crypto.getRandomValues(new Uint8Array(16));
    token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  return `${prefix}-${token}`.slice(0, 191);
}

/**
 * Shared state and helpers for the chatbotRoutes routes.
 *
 * Extracted verbatim from the former single-file chatbotRoutes.ts.
 */
import rateLimit from "express-rate-limit";
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";

// ── GitHub token encryption helpers ────────────────────────────────────────
// Key is derived from SESSION_SECRET so it survives restarts without a new env var.
// New ciphertext uses authenticated AES-256-GCM. Legacy CryptoJS/OpenSSL
// AES-256-CBC ciphertext remains decryptable so existing stored tokens do not break.
export const _tokenKey = () =>
  process.env.SESSION_SECRET ?? "erp-github-token-fallback-key";

const TOKEN_FORMAT_V2 = "v2";
const GCM_AUTH_TAG_LENGTH = 16;

function modernTokenKey(): Buffer {
  return createHash("sha256").update(_tokenKey(), "utf8").digest();
}

function deriveLegacyOpenSslKeyAndIv(
  passphrase: string,
  salt: Buffer,
): { key: Buffer; iv: Buffer } {
  const password = Buffer.from(passphrase, "utf8");
  let derived = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (derived.length < 48) {
    // Legacy compatibility only: CryptoJS passphrase AES used OpenSSL EVP_BytesToKey
    // with MD5. This path decrypts existing data only; new encryption uses AES-GCM.
    // nosemgrep: javascript.lang.security.audit.md5-used-as-password.md5-used-as-password
    previous = createHash("md5")
      .update(Buffer.concat([previous, password, salt]))
      .digest();
    derived = Buffer.concat([derived, previous]);
  }
  return { key: derived.subarray(0, 32), iv: derived.subarray(32, 48) };
}

export function encryptToken(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", modernTokenKey(), iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  const encrypted = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return [
    TOKEN_FORMAT_V2,
    iv.toString("base64"),
    authTag.toString("base64"),
    encrypted.toString("base64"),
  ].join(":");
}

function decryptModernToken(ciphertext: string): string {
  const [version, ivB64, tagB64, encryptedB64] = ciphertext.split(":");
  if (
    version !== TOKEN_FORMAT_V2 ||
    !ivB64 ||
    !tagB64 ||
    encryptedB64 === undefined
  )
    return "";
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const encrypted = Buffer.from(encryptedB64, "base64");
  if (iv.length !== 12 || authTag.length !== GCM_AUTH_TAG_LENGTH) return "";
  const decipher = createDecipheriv("aes-256-gcm", modernTokenKey(), iv, {
    authTagLength: GCM_AUTH_TAG_LENGTH,
  });
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString(
    "utf8",
  );
}

function decryptLegacyToken(ciphertext: string): string {
  const payload = Buffer.from(ciphertext, "base64");
  if (
    payload.length < 17 ||
    payload.subarray(0, 8).toString("ascii") !== "Salted__"
  )
    return "";
  const salt = payload.subarray(8, 16);
  const { key, iv } = deriveLegacyOpenSslKeyAndIv(_tokenKey(), salt);
  const decipher = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([
    decipher.update(payload.subarray(16)),
    decipher.final(),
  ]).toString("utf8");
}

export function decryptToken(ciphertext: string): string {
  try {
    return ciphertext.startsWith(`${TOKEN_FORMAT_V2}:`)
      ? decryptModernToken(ciphertext)
      : decryptLegacyToken(ciphertext);
  } catch {
    return "";
  }
}

export const chatMessageRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: import("express").Request) =>
    `${req.session?.userId ?? "anon"}_${req.session?.currentCompanyId ?? "0"}`,
  handler: (_req: unknown, res: import("express").Response) => {
    res
      .status(429)
      .json({
        message: "Too many messages. Please wait a moment before sending again.",
      });
  },
  skip: (req: import("express").Request) => !req.session?.userId,
});

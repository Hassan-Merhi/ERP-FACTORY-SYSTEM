/**
 * Shared state and helpers for the chatbotRoutes routes.
 *
 * Extracted verbatim from the former single-file chatbotRoutes.ts.
 */
import rateLimit from "express-rate-limit";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

// ── GitHub token encryption helpers ────────────────────────────────────────
// Key is derived from SESSION_SECRET so it survives restarts without a new env var.
// Keep the OpenSSL/CryptoJS salted AES-256-CBC wire format so existing stored
// ciphertext remains decryptable while removing the crypto-js runtime dependency.
export const _tokenKey = () => process.env.SESSION_SECRET ?? "erp-github-token-fallback-key";

function deriveOpenSslKeyAndIv(passphrase: string, salt: Buffer): { key: Buffer; iv: Buffer } {
  const password = Buffer.from(passphrase, "utf8");
  let derived = Buffer.alloc(0);
  let previous = Buffer.alloc(0);
  while (derived.length < 48) {
    previous = createHash("md5").update(Buffer.concat([previous, password, salt])).digest();
    derived = Buffer.concat([derived, previous]);
  }
  return { key: derived.subarray(0, 32), iv: derived.subarray(32, 48) };
}

export function encryptToken(plain: string): string {
  const salt = randomBytes(8);
  const { key, iv } = deriveOpenSslKeyAndIv(_tokenKey(), salt);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("Salted__", "ascii"), salt, encrypted]).toString("base64");
}

export function decryptToken(ciphertext: string): string {
  try {
    const payload = Buffer.from(ciphertext, "base64");
    if (payload.length < 17 || payload.subarray(0, 8).toString("ascii") !== "Salted__") return "";
    const salt = payload.subarray(8, 16);
    const { key, iv } = deriveOpenSslKeyAndIv(_tokenKey(), salt);
    const decipher = createDecipheriv("aes-256-cbc", key, iv);
    return Buffer.concat([decipher.update(payload.subarray(16)), decipher.final()]).toString("utf8");
  } catch {
    return "";
  }
}

export const chatMessageRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req: import("express").Request) => `${req.session?.userId ?? "anon"}_${req.session?.currentCompanyId ?? "0"}`,
  handler: (_req: unknown, res: import("express").Response) => {
    res.status(429).json({ message: "Too many messages. Please wait a moment before sending again." });
  },
  skip: (req: import("express").Request) => !req.session?.userId,
});

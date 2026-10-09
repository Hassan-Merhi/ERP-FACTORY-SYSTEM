import bcrypt from "bcryptjs";
import { createHash, timingSafeEqual } from "node:crypto";

const BCRYPT_SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

export function isLegacySHA256Hash(hash: string): boolean {
  return hash.length === 64 && /^[a-f0-9]+$/i.test(hash);
}

export function verifyLegacyPassword(password: string, hash: string): boolean {
  if (!isLegacySHA256Hash(hash)) return false;
  const actual = Buffer.from(createHash("sha256").update(password, "utf8").digest("hex"), "hex");
  const expected = Buffer.from(hash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<{ valid: boolean; needsMigration: boolean }> {
  if (isLegacySHA256Hash(hash)) {
    const isValid = verifyLegacyPassword(password, hash);
    return { valid: isValid, needsMigration: isValid };
  }
  const isValid = await bcrypt.compare(password, hash);
  return { valid: isValid, needsMigration: false };
}

/**
 * bcrypt-only verification for privileged confirmations (manager discount approvals).
 * Legacy SHA-256 hashes are refused rather than compared with a weak digest, so the
 * approval path never touches the legacy fallback. Affected managers reset their
 * password once and can approve again.
 */
export async function verifyPasswordBcryptOnly(password: string, hash: string): Promise<boolean> {
  if (isLegacySHA256Hash(hash)) return false;
  return bcrypt.compare(password, hash);
}

import bcrypt from "bcryptjs";

const BCRYPT_SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

export function isLegacySHA256Hash(hash: string): boolean {
  return hash.length === 64 && /^[a-f0-9]+$/i.test(hash);
}

export async function verifyPassword(
  password: string,
  hash: string
): Promise<{ valid: boolean; needsMigration: boolean }> {
  // Production has no legacy SHA-256 user credentials. Refuse obsolete hashes
  // instead of falling back to a fast, unsalted password comparison.
  if (isLegacySHA256Hash(hash)) return { valid: false, needsMigration: false };
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

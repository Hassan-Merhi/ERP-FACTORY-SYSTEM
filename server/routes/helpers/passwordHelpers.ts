import bcrypt from "bcryptjs";

const BCRYPT_SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
}

/**
 * Unsalted SHA-256 hashes from the pre-bcrypt era. They are never compared any
 * more (a fast digest is not a password hash): an account still holding one
 * cannot sign in or approve anything until an administrator resets its password.
 */
export function isLegacySHA256Hash(hash: string): boolean {
  return hash.length === 64 && /^[a-f0-9]+$/i.test(hash);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  if (isLegacySHA256Hash(hash)) return false;
  return bcrypt.compare(password, hash);
}

/** Kept for privileged-confirmation callers; identical to verifyPassword now that legacy hashes are refused. */
export const verifyPasswordBcryptOnly = verifyPassword;

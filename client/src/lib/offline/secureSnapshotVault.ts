/**
 * Phase 5: opt-in encrypted offline read snapshots.
 *
 * This is encryption for prepared business responses, NOT offline login.
 * A new tab still needs live server authentication before any snapshot read.
 * No passphrase or extractable AES key is persisted.
 */
import { offlineError } from "./offlineError";

const VERSION = "erp-offline-aes-gcm-v1" as const;
const KDF_ITERATIONS = 310_000;
const MAX_SECRET_LENGTH = 1024;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface VaultScope {
  companyId: number;
  userId: string;
  url: string;
  cachedAt: number;
  expiresAt: number;
}

export interface OfflineVaultKey {
  readonly key: CryptoKey;
  readonly salt: string;
}

interface SealedBody {
  format: typeof VERSION;
  nonce: string;
  ciphertext: string;
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.getRandomValues) {
    throw offlineError("OFFLINE_VAULT_CRYPTO_UNAVAILABLE");
  }
  return globalThis.crypto.subtle;
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

function base64ToBytes(value: string, expectedLength?: number): Uint8Array {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(value) || value.length % 4 !== 0) {
    throw offlineError("OFFLINE_VAULT_FORMAT_INVALID");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw offlineError("OFFLINE_VAULT_FORMAT_INVALID");
  }
  if (expectedLength !== undefined && binary.length !== expectedLength) {
    throw offlineError("OFFLINE_VAULT_FORMAT_INVALID");
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Own a real ArrayBuffer (not SharedArrayBuffer) for strict DOM WebCrypto types. */
function buffer(bytes: Uint8Array): ArrayBuffer {
  const result = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(result).set(bytes);
  return result;
}

function associatedData(scope: VaultScope): ArrayBuffer {
  if (
    !Number.isSafeInteger(scope.companyId) ||
    scope.companyId <= 0 ||
    !scope.userId.trim() ||
    !scope.url ||
    !Number.isSafeInteger(scope.cachedAt) ||
    !Number.isSafeInteger(scope.expiresAt) ||
    scope.expiresAt <= scope.cachedAt
  ) {
    throw offlineError("OFFLINE_VAULT_SCOPE_INVALID");
  }
  return buffer(
    textEncoder.encode(
      JSON.stringify([VERSION, scope.companyId, scope.userId, scope.url, scope.cachedAt, scope.expiresAt])
    )
  );
}

export async function deriveOfflineVaultKey(passphrase: string, previousSalt?: string): Promise<OfflineVaultKey> {
  if (
    typeof passphrase !== "string" ||
    passphrase.length < 12 ||
    passphrase.length > MAX_SECRET_LENGTH ||
    !passphrase.trim()
  ) {
    throw offlineError("OFFLINE_VAULT_PASSPHRASE_INVALID");
  }
  const crypto = subtle();
  const salt = previousSalt === undefined ? randomBytes(16) : base64ToBytes(previousSalt, 16);
  const secretBytes = textEncoder.encode(passphrase);
  try {
    const material = await crypto.importKey("raw", buffer(secretBytes), "PBKDF2", false, ["deriveKey"]);
    const key = await crypto.deriveKey(
      { name: "PBKDF2", salt: buffer(salt), iterations: KDF_ITERATIONS, hash: "SHA-256" },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
    return { key, salt: bytesToBase64(salt) };
  } finally {
    secretBytes.fill(0);
  }
}

export function isSealedOfflineVaultBody(body: string): boolean {
  try {
    const parsed: unknown = JSON.parse(body);
    return !!parsed && typeof parsed === "object" && (parsed as { format?: unknown }).format === VERSION;
  } catch {
    return false;
  }
}

export async function sealOfflineVaultBody(body: string, vault: OfflineVaultKey, scope: VaultScope): Promise<string> {
  const nonce = randomBytes(12); // Unique 96-bit nonce per AES-GCM message.
  const encrypted = await subtle().encrypt(
    { name: "AES-GCM", iv: buffer(nonce), additionalData: associatedData(scope), tagLength: 128 },
    vault.key,
    buffer(textEncoder.encode(body))
  );
  const envelope: SealedBody = {
    format: VERSION,
    nonce: bytesToBase64(nonce),
    ciphertext: bytesToBase64(new Uint8Array(encrypted)),
  };
  return JSON.stringify(envelope);
}

export async function openOfflineVaultBody(sealed: string, vault: OfflineVaultKey, scope: VaultScope): Promise<string> {
  let envelope: unknown;
  try {
    envelope = JSON.parse(sealed);
  } catch {
    throw offlineError("OFFLINE_VAULT_FORMAT_INVALID");
  }
  if (!envelope || typeof envelope !== "object" || (envelope as SealedBody).format !== VERSION) {
    throw offlineError("OFFLINE_VAULT_FORMAT_INVALID");
  }
  const { nonce, ciphertext } = envelope as SealedBody;
  const iv = base64ToBytes(nonce, 12);
  const data = base64ToBytes(ciphertext);
  if (data.length < 16) throw offlineError("OFFLINE_VAULT_FORMAT_INVALID");
  try {
    const plain = await subtle().decrypt(
      { name: "AES-GCM", iv: buffer(iv), additionalData: associatedData(scope), tagLength: 128 },
      vault.key,
      buffer(data)
    );
    return textDecoder.decode(plain);
  } catch {
    throw offlineError("OFFLINE_VAULT_UNLOCK_FAILED");
  }
}

/** A separate authenticated sentry verifies an unlock without disclosing a business response. */
export function vaultCheckScope(
  actor: { companyId: number; userId: string },
  preparedAt: number,
  expiresAt: number
): VaultScope {
  return { ...actor, url: "erp-internal://offline-vault-check", cachedAt: preparedAt, expiresAt };
}

export const OFFLINE_VAULT_SCHEME = VERSION;

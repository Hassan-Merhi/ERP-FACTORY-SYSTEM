// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  deriveOfflineVaultKey,
  isSealedOfflineVaultBody,
  openOfflineVaultBody,
  sealOfflineVaultBody,
} from "../../client/src/lib/offline/secureSnapshotVault";

const actor = {
  companyId: 7,
  userId: "operator-17",
  url: "/api/inventory",
  cachedAt: 1_740_000_000_000,
  expiresAt: 1_740_010_000_000,
};
const secret = "phase-five-test-passphrase";
const payload = JSON.stringify({ data: [{ sku: "PRIVATE-BATCH-777", quantity: 12 }] });

describe("Phase 5 AES-GCM offline snapshot vault", () => {
  it("round trips without persisting either plaintext or a password", async () => {
    const vault = await deriveOfflineVaultKey(secret);
    const sealed = await sealOfflineVaultBody(payload, vault, actor);
    expect(isSealedOfflineVaultBody(sealed)).toBe(true);
    expect(sealed).not.toContain("PRIVATE-BATCH-777");
    expect(sealed).not.toContain(secret);
    expect(await openOfflineVaultBody(sealed, vault, actor)).toBe(payload);
    expect(vault.key.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", vault.key)).rejects.toThrow();
  });

  it("uses unique salts and AES-GCM nonces", async () => {
    const firstKey = await deriveOfflineVaultKey(secret);
    const secondKey = await deriveOfflineVaultKey(secret);
    expect(firstKey.salt).not.toBe(secondKey.salt);
    const one = await sealOfflineVaultBody(payload, firstKey, actor);
    const two = await sealOfflineVaultBody(payload, firstKey, actor);
    expect(one).not.toBe(two);
  });

  it("rejects wrong keys, actor, company, URL, dates and tampered ciphertext", async () => {
    const vault = await deriveOfflineVaultKey(secret);
    const sealed = await sealOfflineVaultBody(payload, vault, actor);
    const wrong = await deriveOfflineVaultKey("another-good-passphrase", vault.salt);
    await expect(openOfflineVaultBody(sealed, wrong, actor)).rejects.toThrow("OFFLINE_VAULT_UNLOCK_FAILED");
    await expect(openOfflineVaultBody(sealed, vault, { ...actor, userId: "other" })).rejects.toThrow();
    await expect(openOfflineVaultBody(sealed, vault, { ...actor, companyId: 8 })).rejects.toThrow();
    await expect(openOfflineVaultBody(sealed, vault, { ...actor, url: "/api/locations" })).rejects.toThrow();
    await expect(openOfflineVaultBody(sealed, vault, { ...actor, expiresAt: actor.expiresAt + 1 })).rejects.toThrow();
    const parsed = JSON.parse(sealed) as { ciphertext: string };
    const changed = parsed.ciphertext[0] === "A" ? "B" : "A";
    parsed.ciphertext = changed + parsed.ciphertext.slice(1);
    await expect(openOfflineVaultBody(JSON.stringify(parsed), vault, actor)).rejects.toThrow();
  });

  it("rejects unencrypted, malformed and untrusted snapshot envelopes", async () => {
    const vault = await deriveOfflineVaultKey(secret);
    expect(isSealedOfflineVaultBody(payload)).toBe(false);
    await expect(openOfflineVaultBody(payload, vault, actor)).rejects.toThrow("OFFLINE_VAULT_FORMAT_INVALID");
    await expect(openOfflineVaultBody("{", vault, actor)).rejects.toThrow("OFFLINE_VAULT_FORMAT_INVALID");
    await expect(
      openOfflineVaultBody(
        JSON.stringify({ format: "erp-offline-aes-gcm-v1", nonce: "none", ciphertext: "..." }),
        vault,
        actor
      )
    ).rejects.toThrow("OFFLINE_VAULT_FORMAT_INVALID");
  });

  it("requires long passphrases and refuses invalid scope/salt", async () => {
    await expect(deriveOfflineVaultKey("short")).rejects.toThrow("OFFLINE_VAULT_PASSPHRASE_INVALID");
    await expect(deriveOfflineVaultKey(secret, "not-a-salt")).rejects.toThrow("OFFLINE_VAULT_FORMAT_INVALID");
    const vault = await deriveOfflineVaultKey(secret);
    await expect(sealOfflineVaultBody(payload, vault, { ...actor, companyId: 0 })).rejects.toThrow(
      "OFFLINE_VAULT_SCOPE_INVALID"
    );
  });
});

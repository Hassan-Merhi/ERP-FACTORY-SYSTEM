import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "../server/routes/chatbot/_helpers";

const previousSessionSecret = process.env.SESSION_SECRET;

describe("chatbot token encryption", () => {
  beforeEach(() => {
    process.env.SESSION_SECRET = "test-session-secret";
  });

  afterEach(() => {
    if (previousSessionSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSessionSecret;
  });

  it("uses authenticated v2 encryption for new tokens", () => {
    const ciphertext = encryptToken("github-token-value");
    expect(ciphertext.startsWith("v2:")).toBe(true);
    expect(decryptToken(ciphertext)).toBe("github-token-value");
  });

  it("rejects tampered authenticated ciphertext", () => {
    const parts = encryptToken("github-token-value").split(":");
    const encrypted = Buffer.from(parts[3], "base64");
    encrypted[0] ^= 1;
    parts[3] = encrypted.toString("base64");
    expect(decryptToken(parts.join(":"))).toBe("");
  });

  it("keeps decrypting legacy CryptoJS/OpenSSL passphrase ciphertext", () => {
    const legacyCiphertext = "U2FsdGVkX19YwGofltY6OjUuFIuuT5IMWqgsazF0DwsGqc5WqG1QLIhehffjT9Au";
    expect(decryptToken(legacyCiphertext)).toBe("legacy-token-value");
  });
});

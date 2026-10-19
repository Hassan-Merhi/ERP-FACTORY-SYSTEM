import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import {
  hashPassword,
  isLegacySHA256Hash,
  verifyPassword,
  verifyPasswordBcryptOnly,
} from "../server/routes/helpers/passwordHelpers";

describe("passwordHelpers", () => {
  it("recognizes only 64-character hexadecimal legacy hashes", () => {
    expect(isLegacySHA256Hash("a".repeat(64))).toBe(true);
    expect(isLegacySHA256Hash("A".repeat(64))).toBe(true);
    expect(isLegacySHA256Hash("g".repeat(64))).toBe(false);
    expect(isLegacySHA256Hash("a".repeat(63))).toBe(false);
  });

  it("refuses legacy SHA-256 password hashes rather than using weak verification", async () => {
    const legacyHash = "a".repeat(64);
    await expect(verifyPassword("legacy-secret", legacyHash)).resolves.toEqual({
      valid: false,
      needsMigration: false,
    });
    await expect(verifyPassword("legacy-secret", legacyHash.toUpperCase())).resolves.toEqual({
      valid: false,
      needsMigration: false,
    });
  });

  it("verifies bcrypt passwords without requesting migration", async () => {
    const hash = await bcrypt.hash("modern-secret", 4);
    await expect(verifyPassword("modern-secret", hash)).resolves.toEqual({
      valid: true,
      needsMigration: false,
    });
    await expect(verifyPassword("wrong", hash)).resolves.toEqual({
      valid: false,
      needsMigration: false,
    });
  });

  it("verifies bcrypt-only passwords and refuses a legacy hash outright", async () => {
    const hash = await bcrypt.hash("modern-secret", 4);
    await expect(verifyPasswordBcryptOnly("modern-secret", hash)).resolves.toBe(true);
    await expect(verifyPasswordBcryptOnly("wrong", hash)).resolves.toBe(false);
    // Privileged confirmations never fall back to the weak legacy comparison.
    await expect(verifyPasswordBcryptOnly("modern-secret", "a".repeat(64))).resolves.toBe(false);
  });

  it("creates a bcrypt hash that verifies", async () => {
    const hash = await hashPassword("new-secret");
    expect(hash.startsWith("$2")).toBe(true);
    await expect(bcrypt.compare("new-secret", hash)).resolves.toBe(true);
  });
});

import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  hashPassword,
  isLegacySHA256Hash,
  verifyLegacyPassword,
  verifyPassword,
} from "../server/routes/helpers/passwordHelpers";

describe("passwordHelpers", () => {
  it("recognizes only 64-character hexadecimal legacy hashes", () => {
    expect(isLegacySHA256Hash("a".repeat(64))).toBe(true);
    expect(isLegacySHA256Hash("A".repeat(64))).toBe(true);
    expect(isLegacySHA256Hash("g".repeat(64))).toBe(false);
    expect(isLegacySHA256Hash("a".repeat(63))).toBe(false);
  });

  it("verifies legacy SHA-256 passwords case-insensitively", () => {
    const hash = createHash("sha256").update("correct horse battery staple").digest("hex");
    expect(verifyLegacyPassword("correct horse battery staple", hash.toUpperCase())).toBe(true);
    expect(verifyLegacyPassword("wrong password", hash)).toBe(false);
    expect(verifyLegacyPassword("anything", "")).toBe(false);
  });

  it("marks a successful legacy login for bcrypt migration", async () => {
    const hash = createHash("sha256").update("legacy-secret").digest("hex");
    await expect(verifyPassword("legacy-secret", hash)).resolves.toEqual({
      valid: true,
      needsMigration: true,
    });
    await expect(verifyPassword("wrong", hash)).resolves.toEqual({
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

  it("creates a bcrypt hash that verifies", async () => {
    const hash = await hashPassword("new-secret");
    expect(hash.startsWith("$2")).toBe(true);
    await expect(bcrypt.compare("new-secret", hash)).resolves.toBe(true);
  });
});

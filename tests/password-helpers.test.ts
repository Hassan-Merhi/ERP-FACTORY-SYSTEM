import bcrypt from "bcryptjs";
import { createHash } from "node:crypto";
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

  it("refuses a legacy SHA-256 hash even for the matching password", async () => {
    const hash = createHash("sha256").update("legacy-secret").digest("hex");
    await expect(verifyPassword("legacy-secret", hash)).resolves.toBe(false);
    await expect(verifyPasswordBcryptOnly("legacy-secret", hash)).resolves.toBe(false);
  });

  it("verifies bcrypt passwords", async () => {
    const hash = await bcrypt.hash("modern-secret", 4);
    await expect(verifyPassword("modern-secret", hash)).resolves.toBe(true);
    await expect(verifyPassword("wrong", hash)).resolves.toBe(false);
    await expect(verifyPasswordBcryptOnly("modern-secret", hash)).resolves.toBe(true);
  });

  it("creates a bcrypt hash that verifies", async () => {
    const hash = await hashPassword("new-secret");
    expect(hash.startsWith("$2")).toBe(true);
    await expect(bcrypt.compare("new-secret", hash)).resolves.toBe(true);
  });
});

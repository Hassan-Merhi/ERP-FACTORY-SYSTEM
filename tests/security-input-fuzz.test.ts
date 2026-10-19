import path from "node:path";
import os from "node:os";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { toNodemailerAttachment } from "../server/helpers/exportAttachmentSource";
import {
  ProtectedAssetAccessError,
  sanitizeDownloadFileName,
  validateStorageKey,
} from "../server/services/security/protectedAssetAccessPolicy";
import { isLegacySHA256Hash, verifyPassword, verifyPasswordBcryptOnly } from "../server/routes/helpers/passwordHelpers";
import { buildRemainingLoadingPlan } from "../server/routes/factory/customer-orders/remainingLoadingPlan";

// Reproducible when CI reports a seed: FUZZ_SEED=<seed> FUZZ_RUNS=1000 npm run test:fuzz
const runCount = Number(process.env.FUZZ_RUNS ?? "250");
const numRuns = Number.isSafeInteger(runCount) && runCount > 0 ? Math.min(runCount, 20000) : 250;
const seedValue = process.env.FUZZ_SEED;
const seedOptions =
  seedValue !== undefined && Number.isSafeInteger(Number(seedValue)) ? { seed: Number(seedValue) } : {};
const params = { numRuns, ...seedOptions };

describe("security boundary property fuzzing", () => {
  it("never accepts an escaping or malformed storage key", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string({ maxLength: 550 }), fc.integer(), fc.boolean(), fc.constant(null)), (input) => {
        try {
          const key = validateStorageKey(input);
          expect(key).toBe(key.trim());
          expect(key.length).toBeGreaterThan(0);
          expect(key.length).toBeLessThanOrEqual(500);
          expect(key.startsWith("/")).toBe(false);
          expect(key.includes("\\")).toBe(false);
          expect(key.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")).toBe(
            true
          );
        } catch (error) {
          expect(error).toBeInstanceOf(ProtectedAssetAccessError);
          expect((error as ProtectedAssetAccessError).code).toBe("ASSET_STORAGE_KEY_INVALID");
        }
      }),
      params
    );
  });

  it("normalizes untrusted download filenames without path separators or control bytes", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 250 }), (value) => {
        try {
          const result = sanitizeDownloadFileName(value);
          expect(result).not.toBeNull();
          expect(result).not.toMatch(/[\\/]/);
          expect(result).not.toMatch(/[\u0000-\u001f\u007f]/);
          expect(result?.length).toBeGreaterThan(0);
          expect(result?.length).toBeLessThanOrEqual(180);
          expect(result).not.toBe(".");
          expect(result).not.toBe("..");
        } catch (error) {
          expect(error).toBeInstanceOf(ProtectedAssetAccessError);
          expect((error as ProtectedAssetAccessError).code).toBe("ASSET_FILE_NAME_INVALID");
        }
      }),
      params
    );
  });

  it("refuses generated attacker paths outside the managed export root", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 100 }), (suffix) => {
        // The randomized tail always ends in an unapproved extension. Never open these paths.
        const filePath = path.join(os.tmpdir(), "erp-untrusted-fuzz", suffix + ".txt");
        expect(() => toNodemailerAttachment({ filePath, sizeBytes: 1 }, "x", "text/plain")).toThrow("EXPORT_PATH_ERR");
      }),
      params
    );
  });

  it("refuses all legacy SHA-256 passwords rather than comparing weak hashes", async () => {
    const hex = fc
      .array(fc.constantFrom(..."0123456789abcdefABCDEF"), { minLength: 64, maxLength: 64 })
      .map((digits) => digits.join(""));
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 100 }), hex, async (password, legacyHash) => {
        expect(isLegacySHA256Hash(legacyHash)).toBe(true);
        await expect(verifyPassword(password, legacyHash)).resolves.toEqual({ valid: false, needsMigration: false });
        await expect(verifyPasswordBcryptOnly(password, legacyHash)).resolves.toBe(false);
      }),
      params
    );
  });

  it("conserves remaining quantities for randomized duplicated loading/import lines", () => {
    const sourceLine = fc.record({
      code: fc.constantFrom("HMD-A", "HMD-B", "HMD-C"),
      qty: fc.integer({ min: 0, max: 1000 }),
    });
    fc.assert(
      fc.property(
        fc.array(sourceLine, { minLength: 1, maxLength: 40 }),
        fc.record({
          a: fc.integer({ min: 0, max: 5000 }),
          b: fc.integer({ min: 0, max: 5000 }),
          c: fc.integer({ min: 0, max: 5000 }),
        }),
        (source, amounts) => {
          const loaded = new Map<string, number>([
            ["hmd-a", amounts.a],
            ["hmd-b", amounts.b],
            ["hmd-c", amounts.c],
          ]);
          const lines = source.map((line) => ({
            articleCode: line.code,
            productName: line.code,
            expectedQty: line.qty,
            proformaLineId: null,
          }));
          const result = buildRemainingLoadingPlan(lines, loaded);
          const totals = new Map<string, number>();
          for (const line of source) {
            const key = line.code.toLowerCase();
            totals.set(key, (totals.get(key) ?? 0) + line.qty);
          }
          const expected = [...totals.entries()].reduce(
            (sum, [key, qty]) => sum + Math.max(0, qty - (loaded.get(key) ?? 0)),
            0
          );
          expect(result.remainingBales).toBe(expected);
          expect(result.lines.every((line) => line.expectedQty > 0 && Number.isSafeInteger(line.expectedQty))).toBe(
            true
          );
          expect(new Set(result.lines.map((line) => line.articleCode.toLowerCase())).size).toBe(result.lines.length);
          expect(result.lines.reduce((sum, line) => sum + line.expectedQty, 0)).toBe(expected);
        }
      ),
      params
    );
  });
});

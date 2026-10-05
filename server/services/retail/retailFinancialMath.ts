import { createHash } from "node:crypto";

export * from "@shared/retailFinancialMath";

export function retailCheckoutFingerprint(input: unknown): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

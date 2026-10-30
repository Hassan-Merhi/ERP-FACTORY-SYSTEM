import { describe, expect, it } from "vitest";
import { visiblePhase9Status } from "@/lib/offline/phase9Status";

const op = { id: "e53cdbd1-7c4b-4b5c-9a60-b4f9de710b8c", companyId: 3, state: "acknowledged" as const };
const proof = { operationId: op.id, companyId: 3, state: "cloud-applied" as const, evidence: "verified-local-cloud-receipt" as const };

describe("Phase 9 browser-visible offline state", () => {
  it("never interprets queue acknowledgement or a stage ACK as cloud apply", () => {
    expect(visiblePhase9Status(op)).toBe("local-only");
    expect(visiblePhase9Status(op, { ...proof, state: "staged", evidence: "lan-staging-receipt" })).toBe("staged");
    expect(visiblePhase9Status(op, proof)).toBe("cloud-applied");
    expect(visiblePhase9Status({ ...op, state: "pending" }, proof)).toBe("local-only");
  });
  it("refuses malformed, wrong-tenant and mismatched proof", () => {
    expect(visiblePhase9Status(op, { ...proof, companyId: 999 })).toBe("local-only");
    expect(visiblePhase9Status(op, { ...proof, operationId: "other" })).toBe("local-only");
    expect(visiblePhase9Status(op, { ...proof, evidence: "lan-staging-receipt" })).toBe("local-only");
    expect(visiblePhase9Status(op, { ...proof, state: "staged" })).toBe("local-only");
    expect(visiblePhase9Status(op, { ...proof, state: "unknown" })).toBe("local-only");
    expect(visiblePhase9Status(op, null)).toBe("local-only");
  });
  it("keeps conflicts and blocked operations visible even with stale positive evidence", () => {
    expect(visiblePhase9Status({ ...op, state: "conflict" }, proof)).toBe("conflict");
    expect(visiblePhase9Status({ ...op, state: "needs_review" }, proof)).toBe("conflict");
    expect(visiblePhase9Status({ ...op, state: "rejected" }, proof)).toBe("blocked");
  });
});

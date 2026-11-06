import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
const root = process.cwd();

interface ReleaseGate {
  id: string;
  status: "blocked" | "verified";
  evidence: string | null;
  required: string;
}
interface Readiness {
  schemaVersion: number;
  rolloutMode: "shadow" | "active";
  releaseAuthorized: boolean;
  lastVerifiedHead: string | null;
  gates: ReleaseGate[];
}
const ready = JSON.parse(
  fs.readFileSync(path.join(root, "config/permissions-v2-release-readiness.json"), "utf8")
) as Readiness;
const expected = [
  "handler-review",
  "frontend-role-parity",
  "migration-staging",
  "data-integrity",
  "cross-company-rbac",
  "rollback-drill",
  "quality-ci",
  "training-monitoring",
  "owner-signoff",
];

export function isReleaseReady(document: Readiness): boolean {
  return (
    document.schemaVersion === 1 &&
    document.rolloutMode === "active" &&
    document.releaseAuthorized === true &&
    /^[a-f0-9]{40}$/.test(document.lastVerifiedHead ?? "") &&
    document.gates.length === expected.length &&
    new Set(document.gates.map((gate) => gate.id)).size === expected.length &&
    expected.every((id) =>
      document.gates.some(
        (gate) =>
          gate.id === id &&
          gate.status === "verified" &&
          typeof gate.evidence === "string" &&
          gate.evidence.trim().length > 10
      )
    )
  );
}

describe("Phase 8 signed release readiness prerequisites", () => {
  it("refuses production activation without complete evidence", () => {
    expect(isReleaseReady(ready)).toBe(false);
    expect(ready.releaseAuthorized).toBe(false);
    expect(ready.rolloutMode).toBe("shadow");
    expect(ready.gates.map((gate) => gate.id).sort()).toEqual(expected.slice().sort());
    expect(ready.gates.some((gate) => gate.status === "blocked")).toBe(true);
  });
  it("refuses a missing, duplicate or unaudited gate, regardless of release toggle", () => {
    const hypothetical: Readiness = {
      ...ready,
      rolloutMode: "active",
      releaseAuthorized: true,
      lastVerifiedHead: "a".repeat(40),
      gates: ready.gates.map((gate) => ({
        ...gate,
        status: "verified" as const,
        evidence: "Approved change and validated staging record",
      })),
    };
    expect(isReleaseReady(hypothetical)).toBe(true);
    expect(isReleaseReady({ ...hypothetical, gates: hypothetical.gates.slice(1) })).toBe(false);
    expect(
      isReleaseReady({ ...hypothetical, gates: [hypothetical.gates[0], ...hypothetical.gates.slice(0, -1)] })
    ).toBe(false);
    expect(isReleaseReady({ ...hypothetical, lastVerifiedHead: "not-a-commit" })).toBe(false);
    expect(isReleaseReady({ ...hypothetical, releaseAuthorized: false })).toBe(false);
    expect(
      isReleaseReady({
        ...hypothetical,
        gates: hypothetical.gates.map((gate, index) => (index === 0 ? { ...gate, evidence: null } : gate)),
      })
    ).toBe(false);
  });
  it("does not activate the V2 role in user assignment or change the DB policy mode", () => {
    const roleEditor = fs.readFileSync(path.join(root, "client/src/pages/settings/users/InlineRoleEditor.tsx"), "utf8");
    const store = fs.readFileSync(path.join(root, "server/services/security/accessControlV2Store.ts"), "utf8");
    expect(roleEditor).not.toMatch(/ROLE_OPTIONS\s*=\s*\[[^\]]*"Create Only"/);
    expect(store).toContain('version.mode !== "shadow"');
    expect(store).toContain('mode: "shadow"');
    expect(store).not.toContain("SET mode='active'");
  });
});

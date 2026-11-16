import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { routeIdentity } from "../scripts/verify-route-access-coverage.mjs";

const root = process.cwd();
const read = (file: string) => JSON.parse(fs.readFileSync(path.join(root, file), "utf8"));
const routes = read("config/route-manifest.json");
const review = read("config/route-access-review.json");

describe("Phase 2 route access review ledger", () => {
  it("exactly matches deterministic source extraction", () => {
    expect(() =>
      execFileSync(process.execPath, ["scripts/generate-route-access-review.mjs", "--check"], {
        cwd: root,
        stdio: "pipe",
      })
    ).not.toThrow();
  });

  it("strict certification succeeds only when all route rules are reviewed", () => {
    const certify = () =>
      execFileSync(process.execPath, ["scripts/generate-route-access-review.mjs", "--check", "--require-reviewed"], {
        cwd: root,
        stdio: "pipe",
      });
    const incomplete = review.entries.some((entry: { status: string }) => entry.status !== "reviewed");
    if (incomplete) expect(certify).toThrow();
    else expect(certify).not.toThrow();
  });

  it("tracks every registration, including repeated method/path handlers", () => {
    expect(review.routeCount).toBe(routes.routes.length);
    expect(review.entries.map((entry: { id: string }) => entry.id)).toEqual(
      routes.routes.map(routeIdentity)
    );
  });

  it("records authored operational permission evidence without granting new rights", () => {
    const sourced = review.entries.filter((entry: { policyEvidence?: unknown[] }) => entry.policyEvidence);
    expect(sourced.length).toBeGreaterThan(200);
    expect(
      sourced.some((entry: { policyEvidence: Array<{ permissionKey: string }> }) =>
        entry.policyEvidence.some((policy) => policy.permissionKey === "act_import_data")
      )
    ).toBe(true);
    expect(
      sourced.every(
        (entry: { status: string; policyEvidence: Array<{ status: string; source: string }> }) =>
          ["unreviewed", "reviewed"].includes(entry.status) &&
          entry.policyEvidence.every(
            (item) =>
              item.status === "source-evidence-only" &&
              item.source === "server/services/security/operationalPermissionRoutePolicy.ts"
          )
      )
    ).toBe(true);
  });

  it("promotes only independently verified service and public route decisions", () => {
    const reviewed = review.entries.filter((entry: { status: string }) => entry.status === "reviewed");
    const authoritative = read("config/route-access-reviewed.json");
    expect(reviewed.map((entry: { id: string }) => entry.id)).toEqual(
      authoritative.rules.map((rule: { id: string }) => rule.id)
    );
    expect(
      reviewed.every((entry: { verifiedRule: { evidence: string[] } }) => entry.verifiedRule.evidence.length > 0)
    ).toBe(true);
  });

  it("does not present unreviewed candidates as approved authorization", () => {
    const approved = read("config/route-access-reviewed.json");
    expect(review.entries.filter((entry: { status: string }) => entry.status === "unreviewed")).toHaveLength(
      routes.routes.length - approved.rules.length
    );
    for (const entry of review.entries) {
      expect(Array.isArray(entry.existingGuards)).toBe(true);
      expect(entry.existingGuards.length).toBeGreaterThan(0);
      expect(entry.companyScope).toBeUndefined();
      expect(entry.roles).toBeUndefined();
      expect(entry.permission).toBeUndefined();
      if (entry.candidate) expect(entry.candidate.status).toBe("candidate");
    }
  });

  it("does not silently omit dangerous mutation registrations", () => {
    const mutations = review.entries.filter((entry: { id: string }) =>
      /:\s*(POST|PUT|PATCH|DELETE)\s/.test(entry.id)
    );
    expect(mutations.length).toBeGreaterThan(0);
    expect(mutations.every((entry: { status: string }) => ["unreviewed", "reviewed"].includes(entry.status))).toBe(
      true
    );
    const approved = read("config/route-access-reviewed.json");
    const expectedReviewedMutations = approved.rules.filter((rule: { id: string }) =>
      /:\s*(POST|PUT|PATCH|DELETE)\s/.test(rule.id)
    ).length;
    expect(mutations.filter((entry: { status: string }) => entry.status === "reviewed")).toHaveLength(
      expectedReviewedMutations
    );
  });
});

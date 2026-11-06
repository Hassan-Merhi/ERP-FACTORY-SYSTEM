import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { isCreateOnlyWriteBlocked } from "../server/services/security/createOnlyWritePolicy";
import { evaluateAccessControl, ACCESS_CONTROL_ACTIONS, ACCESS_CONTROL_RESOURCES } from "../shared/accessControlV2";

const root = process.cwd();
const manifest = JSON.parse(fs.readFileSync(path.join(root, "config/route-manifest.json"), "utf8")) as {
  routes: string[];
};
const review = JSON.parse(fs.readFileSync(path.join(root, "config/access-control-v2-route-review.json"), "utf8")) as {
  routes: Record<string, { status: string; resource: string; action: string }>;
};

describe("Phase 7 deny-by-default inventory and data integrity release contract", () => {
  it("does not let any unreviewed business mutation through the outer Create Only guard", () => {
    const forbidden = manifest.routes
      .map((row) => /^([A-Z-]+) (\/\S+) \[/.exec(row))
      .filter((match): match is RegExpExecArray => match !== null)
      .filter((match) => !["GET", "HEAD", "OPTIONS"].includes(match[1]))
      .filter((match) => match[2].startsWith("/api/"))
      .filter((match) => isCreateOnlyWriteBlocked("Create Only", match[1], match[2]) === false);
    // Exactly one reviewed business mutation is currently allowed through
    // the outer guard; it must also carry an independent handler guard.
    const businessAllowed = forbidden.filter(
      (m) =>
        !m[2].startsWith("/api/auth/") && !m[2].startsWith("/api/user-presence") && !m[2].startsWith("/api/screen-feed")
    );
    expect(businessAllowed.map((match) => `${match[1]} ${match[2]}`)).toEqual(["POST /api/suppliers"]);
    const suppliers = fs.readFileSync(path.join(root, "server/routes/supplierRoutes.ts"), "utf8");
    expect(suppliers).toContain('resource: "erp.suppliers"');
    expect(suppliers).toContain('action: "create"');
    expect(suppliers).toContain("requireVerifiedBusinessAction");
  });

  it("never treats candidate routes as already verified", () => {
    for (const [signature, candidate] of Object.entries(review.routes)) {
      expect(candidate.status, signature).toBe("candidate");
      expect(ACCESS_CONTROL_RESOURCES, signature).toContain(candidate.resource);
      expect(ACCESS_CONTROL_ACTIONS, signature).toContain(candidate.action);
      expect(
        evaluateAccessControl({
          role: "Create Only",
          companyId: 7,
          isAssignedToCompany: true,
          resource: candidate.resource as never,
          action: candidate.action as never,
          routeVerified: false,
        }).allowed,
        signature
      ).toBe(false);
    }
  });

  it("keeps the new role unassignable until release certification", () => {
    const editor = fs.readFileSync(path.join(root, "client/src/pages/settings/users/InlineRoleEditor.tsx"), "utf8");
    expect(editor).not.toMatch(/ROLE_OPTIONS\s*=\s*\[[^\]]*"Create Only"/);
    const migration = fs.readFileSync(
      path.join(root, "migrations/20261024_001_permissions_control_center_shadow.sql"),
      "utf8"
    );
    expect(migration).not.toMatch(
      /\b(?:UPDATE|DELETE)\s+(?:FROM\s+)?(?:vouchers|voucher_entries|inventory|role_feature_permissions)\b/i
    );
    expect(migration).toContain("FORCE ROW LEVEL SECURITY");
    expect(migration).toContain("ACCESS_POLICY_AUDIT_APPEND_ONLY");
  });
});

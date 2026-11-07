import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CREATE_ONLY_VERIFIED_CREATE_SIGNATURES,
  isCreateOnlyWriteBlocked,
} from "../server/services/security/createOnlyWritePolicy";
import { refuseInactiveCreateOnlyAssignment } from "../server/services/security/createOnlyActivation";
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
    // Only handler-verified creates pass the outer guard, and each one must
    // carry the named per-route guard in its registered middleware chain.
    const businessAllowed = forbidden.filter(
      (m) =>
        !m[2].startsWith("/api/auth/") && !m[2].startsWith("/api/user-presence") && !m[2].startsWith("/api/screen-feed")
    );
    const verified = [...Object.values(CREATE_ONLY_VERIFIED_CREATE_SIGNATURES).flat()].sort();
    expect(businessAllowed.map((match) => `${match[1]} ${match[2]}`).sort()).toEqual(verified);
    for (const signature of verified) {
      const row = manifest.routes.find((entry) => entry.startsWith(`${signature} [`));
      expect(row, signature).toBeDefined();
      expect(row, signature).toContain("createOnlyVerifiedCreate");
      expect(signature.startsWith("POST "), signature).toBe(true);
    }
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
    // The server refuses new Create Only assignments until the operator switch
    // is set; the picker only mirrors that answer (see the activation suite).
    expect(refuseInactiveCreateOnlyAssignment({ requestedRole: "Create Only" }, {})?.code).toBe(
      "CREATE_ONLY_ASSIGNMENT_NOT_ACTIVATED"
    );
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

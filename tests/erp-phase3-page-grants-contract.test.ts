import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FEATURE_KEYS } from "../shared/schema/common";

const source = readFileSync(new URL("../server/routes/admin/userManagementRoutes.ts", import.meta.url), "utf8");
const putHandler = source.slice(
  source.indexOf('app.put("/api/erp-user-page-access/:userId"'),
  source.indexOf('app.get("/api/erp-user-hidden-costs/:userId"')
);

describe("ERP Phase 3 page-access assignment safety", () => {
  it("validates the target user's membership in the selected company before reading grants", () => {
    const getHandler = source.slice(
      source.indexOf('app.get("/api/erp-user-page-access/:userId"'),
      source.indexOf('app.put("/api/erp-user-page-access/:userId"')
    );
    expect(getHandler).toContain("userCompanyRoles.companyId");
    expect(getHandler).toContain("userCompanyRoles.userId");
    expect(getHandler).toContain('status(404)');
  });

  it("refuses unknown feature names and duplicate feature grants", () => {
    expect(FEATURE_KEYS).toContain("accounts");
    expect(FEATURE_KEYS).toContain("pos");
    expect(putHandler).toContain("parseErpPageGrantKeys(req.body?.pageKeys)");
    expect(putHandler).toContain("if (pageKeys === null)");
    expect(putHandler).toContain('status(400)');
  });

  it("locks the authorized company membership and replaces grants atomically", () => {
    expect(putHandler).toContain("db.transaction(async (tx)");
    expect(putHandler).toContain('for("update")');
    expect(putHandler).toContain("userCompanyRoles.companyId");
    expect(putHandler).toContain("userCompanyRoles.userId");
    expect(putHandler).toContain("tx.delete(erpUserPageAccess)");
    expect(putHandler).toContain("tx.insert(erpUserPageAccess)");
    expect(putHandler).not.toContain("storage.setErpUserPageAccess");
  });

  it("does not grant permissions if the target is not a company member", () => {
    expect(putHandler.indexOf("if (!membership) return false")).toBeLessThan(
      putHandler.indexOf("tx.delete(erpUserPageAccess)")
    );
    expect(putHandler).toContain('status(404)');
  });
});

describe("ERP hidden-cost preference route membership", () => {
  const getHandler = source.slice(
    source.indexOf('app.get("/api/erp-user-hidden-costs/:userId"'),
    source.indexOf('app.put("/api/erp-user-hidden-costs/:userId"')
  );
  const updateHandler = source.slice(
    source.indexOf('app.put("/api/erp-user-hidden-costs/:userId"'),
    source.indexOf('app.get("/api/my-erp-pages"')
  );

  it("does not reveal a nonmember's global ERP restrictions to a company Admin", () => {
    expect(getHandler).toContain("userCompanyRoles.companyId");
    expect(getHandler).toContain("userCompanyRoles.userId");
    expect(getHandler).toContain('status(404)');
  });

  it("validates legacy-compatible keys and locks membership before updating user preferences", () => {
    expect(updateHandler).toContain("parseErpHiddenCostFields(req.body?.hiddenCostFields)");
    expect(updateHandler).toContain("db.transaction(async (tx)");
    expect(updateHandler).toContain('for("update")');
    expect(updateHandler.indexOf("if (!membership) return false")).toBeLessThan(
      updateHandler.indexOf(".update(users)")
    );
    expect(updateHandler).toContain('status(404)');
    expect(updateHandler).toContain('status(400)');
  });
});

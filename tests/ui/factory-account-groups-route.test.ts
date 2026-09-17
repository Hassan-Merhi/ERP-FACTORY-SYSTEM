import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const accountsSource = fs.readFileSync(path.join(root, "client/src/pages/AccountsLegacy.tsx"), "utf8");
const factoryRoutesSource = fs.readFileSync(path.join(root, "client/src/components/FactoryRoutes.tsx"), "utf8");

describe("factory account groups routing", () => {
  it("uses the current app mode prefix from Accounts Overview", () => {
    expect(accountsSource).toContain('model.navigate(`${model.modePrefix}/account-groups`)');
  });

  it("registers the factory account-groups route for admins and developers", () => {
    expect(factoryRoutesSource).toContain('path="/factory/account-groups" component={AccountGroups}');
  });
});

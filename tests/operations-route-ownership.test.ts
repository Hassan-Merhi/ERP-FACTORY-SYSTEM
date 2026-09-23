import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (relativePath: string) => fs.readFileSync(path.join(root, relativePath), "utf8");

describe("Phase 7 operations route ownership", () => {
  it("keeps operational registration in focused application registrars", () => {
    const applicationRoutes = read("server/routes/applicationRoutes.ts");

    const expectedRegistrations = [
      "registerLocationRoutes(app);",
      "registerEmployeeRoutes(app);",
      "registerStockRoutes(app);",
      "registerContainerRoutes(app);",
      "registerImportRoutes(app);",
      "registerPosRoutes(app);",
      "registerBaleRoutes(app);",
      "registerPropertiesRentalRoutes(app);",
      "registerErpRentalRoutes(app);",
      "registerFactoryRentalRoutes(app);",
      "registerFactoryRoutes(app, requireAuth, db);",
      "registerGlobalTransactionRoutes(app, requireAuth);",
      "registerFiscalTransferRoutes(app);",
    ];

    for (const registration of expectedRegistrations) {
      expect(applicationRoutes).toContain(registration);
    }
  });

  it("keeps operations HTTP ownership out of the retired legacy registry", () => {
    expect(fs.existsSync(path.join(root, "server/routesLegacy.ts"))).toBe(false);
  });
});

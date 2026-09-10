/**
 * Barrel re-export — assembles `storage` from domain modules.
 * All existing callers use `import { storage } from "./storage"` unchanged.
 */
import * as auth from "./storage/auth";
import * as accounting from "./storage/accounting";
import * as inventory from "./storage/inventory";
import * as stockOps from "./storage/stock-ops";
import * as containers from "./storage/containers-store";
import * as suppliers from "./storage/suppliers";
import * as employees from "./storage/employees";
import * as pos from "./storage/pos";
import * as factory from "./storage/factory";
import * as companyDeletion from "./storage/company-deletion";

export const storage = {
  ...auth,
  ...accounting,
  ...inventory,
  ...stockOps,
  ...containers,
  ...suppliers,
  ...employees,
  ...pos,
  ...factory,
  // Keep this last so the dependency-aware implementation replaces the legacy
  // hand-maintained deleteCompany export without changing existing callers.
  ...companyDeletion,
};
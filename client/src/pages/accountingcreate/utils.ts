/**
 * Pure helpers and lookup tables for the AccountingCreate page.
 *
 * Extracted from AccountingCreate.tsx during the Phase 4 god-file split.
 */
import {
  insertLocationSchema,
  insertLedgerAccountSchema,
  insertEmployeeSchema,
  insertSupplierSchema,
  insertStockGroupSchema,
  insertStockItemSchema,
} from "@shared/schema";
import type { EntityType } from "./types";

export const entityConfig = {
  location: {
    label: "Location",
    endpoint: "/api/locations",
    schema: insertLocationSchema.omit({ companyId: true }),
  },
  ledger: {
    label: "Ledger Account",
    endpoint: "/api/ledger-accounts",
    schema: insertLedgerAccountSchema.omit({ companyId: true }),
  },
  employee: {
    label: "Employee",
    endpoint: "/api/employees",
    schema: insertEmployeeSchema.omit({ companyId: true }),
  },
  supplier: {
    label: "Supplier",
    endpoint: "/api/suppliers",
    schema: insertSupplierSchema,
  },
  stockGroup: {
    label: "Stock Group",
    endpoint: "/api/stock-groups",
    // Code is derived from the entered name on submit; it is not a second user input.
    schema: insertStockGroupSchema.omit({ companyId: true, code: true }),
  },
  stockItem: {
    label: "Stock Item",
    endpoint: "/api/stock-items",
    schema: insertStockItemSchema.omit({ companyId: true }),
  },
};

// Get default values for each entity type

export // Get default values for each entity type
const getDefaultValues = (entityType: EntityType) => {
  switch (entityType) {
    case "location":
      return { name: "", code: "", active: true };
    case "ledger":
      return {
        name: "",
        accountType: "",
        subType: "",
        parentId: undefined,
        openingBalance: "0",
        openingBalanceSide: "",
        active: true,
      };

    case "employee":
      return {
        firstName: "",
        lastName: "",
        phone: "",
        joinDate: "",
        department: "",
        employeeType: "Employee",
        openingBalance: "0",
        active: true,
      };

    case "supplier":
      return { legalName: "", phone: "", active: true };
    case "stockGroup":
      return { name: "", active: true };
    case "stockItem":
      return {
        name: "",
        uom: "",
        // New stock records have no opening stock. Quantities come from actual receipts.
        sellingPrice: "0",
        active: true,
      };
    default:
      return {};
  }
};

// Wrapper component to properly recreate form when entity changes

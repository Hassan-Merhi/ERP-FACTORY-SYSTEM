import { describe, expect, it } from "vitest";
import {
  initializePropertiesDestinations,
  updatePropertiesDefaultDestination,
  updatePropertiesContainerCharges,
  updatePropertiesContainerDestination,
  validatePropertiesImportSelections,
} from "../client/src/pages/poimport/propertiesDestinationSelections";
import {
  canNavigateProperties,
  findPropertiesNavigationEntry,
  getPropertiesParentRoute,
} from "../client/src/properties/config/propertiesNavigation";

const containers = [
  { containerNumber: "TEST-CONT-001", chargesTotal: 500 },
  { containerNumber: "TEST-CONT-002", chargesTotal: 250 },
  { containerNumber: "TEST-CONT-003", chargesTotal: 0 },
];

describe("Properties normal PO Import intercompany destinations", () => {
  it("applies one default to every container without any duplicate assignments", () => {
    const selections = initializePropertiesDestinations(containers.map((entry) => entry.containerNumber), "30");
    const validated = validatePropertiesImportSelections(containers, selections, new Set([30, 31]));
    expect(validated.map((entry) => entry.destinationCompanyId)).toEqual([30, 30, 30]);
    expect(validated.every((entry) => entry.chargesConfirmed === false)).toBe(true);
  });

  it("preserves individual overrides when the global default changes", () => {
    let selections = initializePropertiesDestinations(containers.map((entry) => entry.containerNumber), "30");
    selections = updatePropertiesContainerDestination(selections, "TEST-CONT-002", "31", "30");
    selections = updatePropertiesDefaultDestination(selections, "32");
    expect(
      validatePropertiesImportSelections(containers, selections, new Set([30, 31, 32]))
        .map((entry) => entry.destinationCompanyId)
    ).toEqual([32, 31, 32]);
    selections = updatePropertiesContainerDestination(selections, "TEST-CONT-002", null, "32");
    expect(
      validatePropertiesImportSelections(containers, selections, new Set([30, 31, 32]))
        .map((entry) => entry.destinationCompanyId)
    ).toEqual([32, 32, 32]);
  });

  it("refuses unknown company IDs, missing selections, and duplicate physical containers", () => {
    const original = initializePropertiesDestinations(containers.map((entry) => entry.containerNumber), "30");
    expect(() => validatePropertiesImportSelections(containers, original, new Set([31]))).toThrow(
      "authorized ERP destination"
    );
    expect(() => validatePropertiesImportSelections(containers, {}, new Set([30]))).toThrow("Review every container");
    expect(() =>
      validatePropertiesImportSelections(
        [{ containerNumber: "ABC", chargesTotal: 0 }, { containerNumber: "abc", chargesTotal: 0 }],
        initializePropertiesDestinations(["ABC", "abc"], "30"),
        new Set([30])
      )
    ).toThrow("Duplicate or missing");
  });

  it("requires evidence for confirmed nonzero charges but never fabricates it", () => {
    let selections = initializePropertiesDestinations(containers.map((entry) => entry.containerNumber), "30");
    selections = updatePropertiesContainerCharges(selections, "TEST-CONT-001", { chargesConfirmed: true });
    expect(() => validatePropertiesImportSelections(containers, selections, new Set([30]))).toThrow(
      "evidence reference"
    );
    selections = updatePropertiesContainerCharges(selections, "TEST-CONT-001", {
      chargeEvidenceReference: "FRT-INV-1",
    });
    const validated = validatePropertiesImportSelections(containers, selections, new Set([30]));
    expect(validated[0]).toMatchObject({ chargesConfirmed: true, chargeEvidenceReference: "FRT-INV-1" });
    expect(validated[1].chargesConfirmed).toBe(false);
  });

  it("keeps the import reachable only in Properties trading with Owner/Developer access", () => {
    const route = "/properties/po-import";
    expect(findPropertiesNavigationEntry(route)?.capability).toBe("trading");
    expect(getPropertiesParentRoute(route)).toBe("/properties/containers");
    expect(canNavigateProperties(route, null, { companyType: "properties", role: "Owner" })).toBe(true);
    expect(canNavigateProperties(route, null, { companyType: "properties", role: "Developer" })).toBe(true);
    expect(canNavigateProperties(route, null, { companyType: "properties", role: "View Only" })).toBe(false);
    expect(canNavigateProperties(route, null, { companyType: "erp", role: "Owner" })).toBe(false);
  });
});

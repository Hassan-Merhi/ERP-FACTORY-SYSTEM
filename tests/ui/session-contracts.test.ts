import {
  SessionContractError,
  authenticatedUserSchema,
  companyTypeSchema,
  parseAuthenticatedUser,
  parseSessionCompany,
  parseUserCompanies,
} from "@/contracts/sessionContracts";

describe("session API contracts", () => {
  it("accepts the supported company types", () => {
    for (const companyType of ["erp", "retail", "factory", "factory_v2", "properties", "supplier_partner"]) {
      expect(companyTypeSchema.parse(companyType)).toBe(companyType);
    }
  });

  it("normalizes an unknown company type to ERP for backward compatibility", () => {
    const [assignment] = parseUserCompanies([
      {
        companyId: "7",
        companyCode: "GC",
        companyName: "GC Lshi",
        companyActive: true,
        companyType: "legacy",
      },
    ]);

    expect(assignment.companyId).toBe(7);
    expect(assignment.companyType).toBe("erp");
  });

  it("normalizes typed company permissions without losing extra fields", () => {
    const [assignment] = parseUserCompanies([
      {
        companyId: "7",
        companyName: "GC Lshi",
        companyType: "erp",
        assignedLocationId: "11",
        posStation: "3",
        cashAccountId: "44",
        canSellNegativeStock: true,
        posViewOnly: false,
        daybookEditDays: "5",
        canAccessCustomers: true,
        canDeleteRecords: false,
        customSetting: "preserved",
      },
    ]);

    expect(assignment).toMatchObject({
      companyId: 7,
      assignedLocationId: 11,
      posStation: 3,
      cashAccountId: 44,
      canSellNegativeStock: true,
      posViewOnly: false,
      daybookEditDays: 5,
      canAccessCustomers: true,
      canDeleteRecords: false,
      customSetting: "preserved",
    });
  });

  it("rejects malformed company assignments with structured contract issues", () => {
    try {
      parseUserCompanies([{ companyId: "bad", companyName: "" }]);
      throw new Error("Expected contract parsing to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SessionContractError);
      expect(error).toMatchObject({ contract: "user-companies" });
      expect((error as SessionContractError).issues.length).toBeGreaterThan(0);
    }
  });

  it("parses the complete authenticated session and preserves additional server fields", () => {
    const user = parseAuthenticatedUser({
      id: 12,
      username: "hassan",
      role: "Admin",
      currentRole: "Owner",
      currentCompanyId: "7",
      currentLocationId: "11",
      currentPOSStation: "3",
      canSellNegativeStock: true,
      daybookEditDays: "5",
      customPermission: true,
    });

    expect(user).toMatchObject({
      id: 12,
      username: "hassan",
      role: "Admin",
      currentRole: "Owner",
      currentCompanyId: 7,
      currentLocationId: 11,
      currentPOSStation: 3,
      canSellNegativeStock: true,
      daybookEditDays: 5,
      customPermission: true,
    });
    expect(authenticatedUserSchema.safeParse(user).success).toBe(true);
  });

  it("keeps unauthenticated responses nullable", () => {
    expect(parseAuthenticatedUser(null)).toBeNull();
  });

  it("rejects authenticated-user responses without a username", () => {
    expect(() => parseAuthenticatedUser({ id: 1, role: "Admin" })).toThrow("Invalid authenticated-user response");
  });

  it("coerces valid session company identifiers and accepts null", () => {
    expect(parseSessionCompany({ companyId: "9" })).toEqual({ companyId: 9 });
    expect(parseSessionCompany({ companyId: null })).toEqual({ companyId: null });
  });
});

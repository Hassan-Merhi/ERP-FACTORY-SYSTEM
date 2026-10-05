import { afterEach, describe, expect, it } from "vitest";
import {
  approvalCoversLines,
  approvalCoversRequest,
  evaluateRetailDiscountPolicy,
  ExpiredRetailApprovalTokenError,
  InvalidRetailApprovalTokenError,
  isRetailManagerRole,
  RETAIL_APPROVAL_TOKEN_TTL_MS,
  RetailApprovalConfigurationError,
  retailApprovalFingerprint,
  signRetailApprovalToken,
  verifyRetailApprovalToken,
} from "./retailDiscountApproval";

const basePolicy = {
  discountLimitPercent: 10,
  requireManagerApproval: true,
  priceOverrideRequiresApproval: true,
  effectiveDiscountPercent: 0,
  hasPriceOverride: false,
  hasManualDiscount: false,
};

describe("retail discount approval policy", () => {
  it("exempts manager roles and lets everyone else discount within the limit", () => {
    for (const role of ["Admin", "Owner", "Manager", "Developer"]) {
      expect(isRetailManagerRole(role)).toBe(true);
      expect(evaluateRetailDiscountPolicy({ ...basePolicy, role, effectiveDiscountPercent: 90 })).toMatchObject({
        requiresApproval: false,
        isManager: true,
      });
    }
    expect(
      evaluateRetailDiscountPolicy({
        ...basePolicy,
        role: "POS",
        effectiveDiscountPercent: 10,
        hasManualDiscount: true,
      }).requiresApproval
    ).toBe(false);
    expect(
      evaluateRetailDiscountPolicy({
        ...basePolicy,
        role: "POS",
        effectiveDiscountPercent: 10.5,
        hasManualDiscount: true,
      })
    ).toMatchObject({ requiresApproval: true, reasons: ["discount_above_limit"] });
  });

  it("always asks for approval on manual price overrides unless configured otherwise", () => {
    expect(evaluateRetailDiscountPolicy({ ...basePolicy, role: "POS", hasPriceOverride: true }).reasons).toEqual([
      "price_override",
    ]);
    expect(
      evaluateRetailDiscountPolicy({
        ...basePolicy,
        role: "POS",
        hasPriceOverride: true,
        priceOverrideRequiresApproval: false,
      }).requiresApproval
    ).toBe(false);
  });

  it("can be switched off entirely for a company", () => {
    expect(
      evaluateRetailDiscountPolicy({
        ...basePolicy,
        role: "POS",
        requireManagerApproval: false,
        hasPriceOverride: true,
        effectiveDiscountPercent: 80,
        hasManualDiscount: true,
      }).requiresApproval
    ).toBe(false);
  });

  it("reports both reasons when a discount over the limit is combined with an override", () => {
    expect(
      evaluateRetailDiscountPolicy({
        ...basePolicy,
        role: "View Only",
        hasPriceOverride: true,
        hasManualDiscount: true,
        effectiveDiscountPercent: 25,
      }).reasons
    ).toEqual(["price_override", "discount_above_limit"]);
  });
});

describe("retail approval tokens", () => {
  const previousSecret = process.env.SESSION_SECRET;
  const previousNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (previousSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = previousSecret;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
  });

  const payload = {
    tokenId: "11111111-2222-3333-4444-555555555555",
    companyId: 7,
    cashierUserId: "cashier-1",
    managerUserId: "manager-1",
    managerName: "Sara Manager",
    maxDiscountPercent: 15,
    allowsPriceOverride: true,
    fingerprint: "cart-fingerprint-1",
    expiresAt: Date.now() + RETAIL_APPROVAL_TOKEN_TTL_MS,
  };

  it("round-trips a signed approval and binds it to company, cashier and limits", () => {
    process.env.SESSION_SECRET = "unit-test-secret";
    const token = signRetailApprovalToken(payload);
    const verified = verifyRetailApprovalToken(token);
    expect(verified).toMatchObject({
      scope: "retail_discount",
      companyId: 7,
      cashierUserId: "cashier-1",
      managerUserId: "manager-1",
      maxDiscountPercent: 15,
      allowsPriceOverride: true,
    });
  });

  it("rejects tampered payloads and expired tokens", () => {
    process.env.SESSION_SECRET = "unit-test-secret";
    const token = signRetailApprovalToken(payload);
    const [encoded, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...payload, maxDiscountPercent: 90, companyId: 7 }), "utf8").toString(
      "base64url"
    );
    expect(() => verifyRetailApprovalToken(`${forged}.${signature}`)).toThrow(InvalidRetailApprovalTokenError);
    expect(() => verifyRetailApprovalToken("not-a-token")).toThrow(InvalidRetailApprovalTokenError);
    expect(() => verifyRetailApprovalToken(`${encoded}.deadbeef`)).toThrow(InvalidRetailApprovalTokenError);

    const expired = signRetailApprovalToken({ ...payload, expiresAt: Date.now() - 1 });
    expect(() => verifyRetailApprovalToken(expired)).toThrow(ExpiredRetailApprovalTokenError);
  });

  it("fails closed in production without a real SESSION_SECRET", () => {
    delete process.env.SESSION_SECRET;
    process.env.NODE_ENV = "production";
    expect(() => signRetailApprovalToken(payload)).toThrow(RetailApprovalConfigurationError);
    expect(() => verifyRetailApprovalToken("abc.def")).toThrow(RetailApprovalConfigurationError);
  });

  it("only covers lines inside the approved percent and override permission", () => {
    expect(
      approvalCoversLines({ maxDiscountPercent: 15, allowsPriceOverride: false }, [
        { priceOverride: false, effectiveDiscountPercent: 15 },
        { priceOverride: false, effectiveDiscountPercent: 2 },
      ])
    ).toBe(true);
    expect(
      approvalCoversLines({ maxDiscountPercent: 15, allowsPriceOverride: false }, [
        { priceOverride: true, effectiveDiscountPercent: 5 },
      ])
    ).toBe(false);
    expect(
      approvalCoversLines({ maxDiscountPercent: 15, allowsPriceOverride: true }, [
        { priceOverride: false, effectiveDiscountPercent: 20 },
      ])
    ).toBe(false);
  });

  it("binds a cart-level request to the approved cashier, company and limits", () => {
    const payload = { companyId: 7, cashierUserId: "cashier-1", maxDiscountPercent: 15, allowsPriceOverride: false };
    expect(
      approvalCoversRequest(payload, {
        companyId: 7,
        cashierUserId: "cashier-1",
        effectiveDiscountPercent: 12,
        hasPriceOverride: false,
      })
    ).toBe(true);
    expect(
      approvalCoversRequest(payload, {
        companyId: 8,
        cashierUserId: "cashier-1",
        effectiveDiscountPercent: 12,
        hasPriceOverride: false,
      })
    ).toBe(false);
    expect(
      approvalCoversRequest(payload, {
        companyId: 7,
        cashierUserId: "cashier-2",
        effectiveDiscountPercent: 12,
        hasPriceOverride: false,
      })
    ).toBe(false);
    expect(
      approvalCoversRequest(payload, {
        companyId: 7,
        cashierUserId: "cashier-1",
        effectiveDiscountPercent: 30,
        hasPriceOverride: false,
      })
    ).toBe(false);
  });

  it("fingerprints the exact cart deterministically and ignores line order", () => {
    const first = retailApprovalFingerprint(
      [
        { variantId: 2, quantity: 1, priceOverride: 8.5, discountType: "none", discountValue: 0 },
        { variantId: 1, quantity: 2, discountType: "percent", discountValue: 10 },
      ],
      { type: "percent", value: 5 }
    );
    const reordered = retailApprovalFingerprint(
      [
        { variantId: 1, quantity: 2, discountType: "percent", discountValue: 10 },
        { variantId: 2, quantity: 1, priceOverride: 8.5, discountType: "none", discountValue: 0 },
      ],
      { type: "percent", value: 5 }
    );
    const changed = retailApprovalFingerprint(
      [
        { variantId: 1, quantity: 2, discountType: "percent", discountValue: 55 },
        { variantId: 2, quantity: 1, priceOverride: 8.5, discountType: "none", discountValue: 0 },
      ],
      { type: "percent", value: 5 }
    );
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });
});

/**
 * Retail Wave 2 manager approval for discounts and price overrides.
 *
 * The policy is role-based and company-configurable: manager roles are exempt, and
 * everyone else needs approval when a manual discount exceeds the configured limit
 * or when they key a manual price override. Approvals are issued as short-lived
 * HMAC-signed tokens (same pattern as the admin repair tokens) plus an audit row, so
 * checkout can verify who approved what without a server-side token store, and a
 * consumed token cannot be replayed for a different sale.
 */
import crypto from "node:crypto";

/** Roles that may approve their own discounts / overrides. */
export const RETAIL_MANAGER_ROLES = ["Admin", "Owner", "Manager", "Developer"] as const;

export type RetailDiscountPolicyReason = "price_override" | "discount_above_limit";

export interface RetailDiscountPolicyInput {
  role?: string | null;
  discountLimitPercent: number;
  requireManagerApproval: boolean;
  priceOverrideRequiresApproval: boolean;
  /** Effective manual discount percent of the affected list value. */
  effectiveDiscountPercent: number;
  hasPriceOverride: boolean;
  hasManualDiscount: boolean;
}

export interface RetailDiscountPolicyResult {
  requiresApproval: boolean;
  reasons: RetailDiscountPolicyReason[];
  discountLimitPercent: number;
  isManager: boolean;
}

export function isRetailManagerRole(role?: string | null): boolean {
  return RETAIL_MANAGER_ROLES.includes((role ?? "") as (typeof RETAIL_MANAGER_ROLES)[number]);
}

export function evaluateRetailDiscountPolicy(input: RetailDiscountPolicyInput): RetailDiscountPolicyResult {
  const discountLimitPercent = Math.min(Math.max(Number(input.discountLimitPercent) || 0, 0), 100);
  const isManager = isRetailManagerRole(input.role);
  const reasons: RetailDiscountPolicyReason[] = [];
  if (!isManager && input.requireManagerApproval) {
    if (input.hasPriceOverride && input.priceOverrideRequiresApproval) reasons.push("price_override");
    if (input.hasManualDiscount && input.effectiveDiscountPercent > discountLimitPercent + 1e-6) {
      reasons.push("discount_above_limit");
    }
  }
  return { requiresApproval: reasons.length > 0, reasons, discountLimitPercent, isManager };
}

// ── Signed approval tokens ────────────────────────────────────────────────────

export const RETAIL_APPROVAL_TOKEN_TTL_MS = 10 * 60 * 1000;
const DEV_FALLBACK_SIGNING_KEY = "dev-fallback-retail-approval-key-not-for-production";

export class InvalidRetailApprovalTokenError extends Error {
  constructor(reason: string) {
    super(`Invalid retail discount approval: ${reason}`);
    this.name = "InvalidRetailApprovalTokenError";
  }
}

export class ExpiredRetailApprovalTokenError extends Error {
  constructor() {
    super("Retail discount approval has expired — ask a manager to approve again.");
    this.name = "ExpiredRetailApprovalTokenError";
  }
}

export class RetailApprovalConfigurationError extends Error {
  constructor() {
    super(
      "SESSION_SECRET is not configured (or is still the development fallback) — retail discount " +
        "approvals cannot be safely issued or verified in production."
    );
    this.name = "RetailApprovalConfigurationError";
  }
}

function getSigningKey(): string {
  const configured = process.env.SESSION_SECRET;
  if (!configured || configured === DEV_FALLBACK_SIGNING_KEY) {
    if (process.env.NODE_ENV === "production") throw new RetailApprovalConfigurationError();
    return DEV_FALLBACK_SIGNING_KEY;
  }
  return configured;
}

function hmac(payload: string): string {
  return crypto.createHmac("sha256", getSigningKey()).update(payload).digest("hex");
}

export interface RetailApprovalTokenPayload {
  v: 1;
  scope: "retail_discount";
  tokenId: string;
  companyId: number;
  cashierUserId: string;
  managerUserId: string;
  managerName: string;
  maxDiscountPercent: number;
  allowsPriceOverride: boolean;
  /** Binds the approval to the exact cart the manager looked at. */
  fingerprint: string;
  issuedAt: number;
  expiresAt: number;
}

export interface RetailApprovalFingerprintLine {
  variantId: number;
  quantity: number;
  priceOverride?: number | null;
  discountType?: string | null;
  discountValue?: number | null;
}

function canonicalAmount(value: number | null | undefined): string {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed)) return "0";
  return parsed.toFixed(6);
}

/**
 * Deterministic fingerprint of a checkout request. The manager approves the cart they
 * see; checkout recomputes the same fingerprint, so a token cannot be replayed for a
 * different cart (different items, prices, discounts or quantities).
 */
export function retailApprovalFingerprint(
  lines: RetailApprovalFingerprintLine[],
  orderDiscount?: { type?: string | null; value?: number | null } | null
): string {
  const canonical = {
    lines: [...lines]
      .map((line) => ({
        variantId: Number(line.variantId),
        quantity: canonicalAmount(line.quantity),
        priceOverride:
          line.priceOverride === null || line.priceOverride === undefined ? null : canonicalAmount(line.priceOverride),
        discountType: line.discountType ?? "none",
        discountValue: canonicalAmount(line.discountValue),
      }))
      .sort((a, b) => a.variantId - b.variantId || a.quantity.localeCompare(b.quantity)),
    orderDiscount: {
      type: orderDiscount?.type ?? "none",
      value: canonicalAmount(orderDiscount?.value),
    },
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex").slice(0, 32);
}

export function signRetailApprovalToken(
  payload: Omit<RetailApprovalTokenPayload, "v" | "scope" | "issuedAt" | "expiresAt"> & { expiresAt?: number },
  now: number = Date.now()
): string {
  const full: RetailApprovalTokenPayload = {
    v: 1,
    scope: "retail_discount",
    ...payload,
    issuedAt: now,
    expiresAt: payload.expiresAt ?? now + RETAIL_APPROVAL_TOKEN_TTL_MS,
  };
  const encoded = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  return `${encoded}.${hmac(encoded)}`;
}

export function verifyRetailApprovalToken(token: string, now: number = Date.now()): RetailApprovalTokenPayload {
  if (typeof token !== "string" || !token.includes(".")) {
    throw new InvalidRetailApprovalTokenError("malformed token");
  }
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) throw new InvalidRetailApprovalTokenError("malformed token");
  const expected = Buffer.from(hmac(encoded), "utf8");
  const provided = Buffer.from(signature, "utf8");
  if (expected.length !== provided.length || !crypto.timingSafeEqual(expected, provided)) {
    throw new InvalidRetailApprovalTokenError("signature mismatch");
  }
  let payload: RetailApprovalTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as RetailApprovalTokenPayload;
  } catch {
    throw new InvalidRetailApprovalTokenError("malformed payload");
  }
  if (payload.scope !== "retail_discount" || payload.v !== 1) {
    throw new InvalidRetailApprovalTokenError("unexpected scope");
  }
  if (typeof payload.expiresAt !== "number" || now > payload.expiresAt) {
    throw new ExpiredRetailApprovalTokenError();
  }
  return payload;
}

export class RetailApprovalReuseError extends Error {
  constructor() {
    super("This manager approval has already been used for another sale — ask the manager to approve again.");
    this.name = "RetailApprovalReuseError";
  }
}

export interface RetailApprovalCheckLine {
  priceOverride: boolean;
  effectiveDiscountPercent: number;
}

/**
 * True when the token authorises every line in the checkout. The cashier must be the
 * one who requested approval, and the actual manual discount may not exceed what the
 * manager approved.
 */
export function approvalCoversLines(
  payload: Pick<RetailApprovalTokenPayload, "maxDiscountPercent" | "allowsPriceOverride">,
  lines: RetailApprovalCheckLine[]
): boolean {
  return lines.every((line) => {
    if (line.priceOverride && !payload.allowsPriceOverride) return false;
    return line.effectiveDiscountPercent <= payload.maxDiscountPercent + 1e-6;
  });
}

/** Cart-level guard used at checkout in addition to the fingerprint binding. */
export function approvalCoversRequest(
  payload: Pick<
    RetailApprovalTokenPayload,
    "maxDiscountPercent" | "allowsPriceOverride" | "cashierUserId" | "companyId"
  >,
  request: { companyId: number; cashierUserId: string; effectiveDiscountPercent: number; hasPriceOverride: boolean }
): boolean {
  if (payload.companyId !== request.companyId) return false;
  if (payload.cashierUserId !== request.cashierUserId) return false;
  if (request.hasPriceOverride && !payload.allowsPriceOverride) return false;
  return request.effectiveDiscountPercent <= payload.maxDiscountPercent + 1e-6;
}

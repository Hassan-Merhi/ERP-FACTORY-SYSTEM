// Extracted from ./companyAccessRoutes.ts to keep that module under the source-size cap.
import { storage } from "../../storage";
import { isSupportedZmwCompanyPair } from "@shared/companyRatePolicy";

export function disableSessionResponseCaching(res: { setHeader: (name: string, value: string) => void }) {
  res.setHeader("Cache-Control", "private, no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Vary", "Cookie");
}

class CompanyParentValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CompanyParentValidationError";
  }
}

function companyTypeRequiresParentDecision(rawCompanyType: unknown): boolean {
  const companyType =
    typeof rawCompanyType === "string" && rawCompanyType.trim().length > 0 ? rawCompanyType.trim() : "erp";
  return companyType !== "properties";
}

async function assertNoParentCycle(companyId: number, parentCompanyId: number): Promise<void> {
  let cursor: number | null = parentCompanyId;
  const visited = new Set<number>();

  for (let depth = 0; cursor !== null && depth < 100; depth += 1) {
    if (cursor === companyId) {
      throw new CompanyParentValidationError(
        "The selected parent company would create a circular company relationship."
      );
    }
    if (visited.has(cursor)) {
      throw new CompanyParentValidationError(
        "The selected parent company belongs to an existing circular company chain."
      );
    }
    visited.add(cursor);

    const current = await storage.getCompanyById(cursor);
    if (!current?.parentCompanyId) return;
    cursor = Number(current.parentCompanyId);
  }

  if (cursor !== null) {
    throw new CompanyParentValidationError("The selected parent company relationship is too deep to validate safely.");
  }
}

async function normalizeParentCompanyId(rawValue: unknown, companyId?: number): Promise<number | null | undefined> {
  if (rawValue === undefined) return undefined;
  if (rawValue === null || rawValue === "" || rawValue === "none") return null;

  const parentCompanyId =
    typeof rawValue === "number"
      ? rawValue
      : typeof rawValue === "string" && rawValue.trim().length > 0
        ? Number(rawValue)
        : NaN;

  if (!Number.isInteger(parentCompanyId) || parentCompanyId <= 0) {
    throw new CompanyParentValidationError("Parent company must be a valid company.");
  }
  if (companyId !== undefined && parentCompanyId === companyId) {
    throw new CompanyParentValidationError("A company cannot be its own parent company.");
  }

  const parentCompany = await storage.getCompanyById(parentCompanyId);
  if (!parentCompany) {
    throw new CompanyParentValidationError("The selected parent company does not exist.");
  }
  if (!parentCompany.active) {
    throw new CompanyParentValidationError("The selected parent company is inactive.");
  }
  if (parentCompany.companyType === "properties") {
    throw new CompanyParentValidationError("A Properties company cannot be used as an accounting parent company.");
  }

  if (companyId !== undefined) {
    await assertNoParentCycle(companyId, parentCompanyId);
  }

  return parentCompanyId;
}

export async function prepareCompanyPayload(
  body: unknown,
  companyId?: number,
  requireParentDecision = false
): Promise<Record<string, unknown>> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new CompanyParentValidationError("Company data must be an object.");
  }

  const payload = { ...(body as Record<string, unknown>) };
  const hasParentDecision = Object.prototype.hasOwnProperty.call(payload, "parentCompanyId");

  if (requireParentDecision && companyTypeRequiresParentDecision(payload.companyType) && !hasParentDecision) {
    throw new CompanyParentValidationError(
      "Choose a parent company or explicitly select Standalone / No Parent before creating this company."
    );
  }

  if (hasParentDecision) {
    payload.parentCompanyId = await normalizeParentCompanyId(payload.parentCompanyId, companyId);
  }

  // ZMW in this ERP uses a USD functional/accounting base. Validate the
  // resulting company configuration, including partial PATCH requests, before
  // saving it. Do not alter other companies or rewrite existing currency data.
  if (payload.baseCurrency !== undefined || payload.displayCurrency !== undefined) {
    const current = companyId === undefined ? null : await storage.getCompanyById(companyId);
    const base = payload.baseCurrency === undefined ? (current?.baseCurrency ?? "USD") : payload.baseCurrency;
    const display = payload.displayCurrency === undefined ? current?.displayCurrency : payload.displayCurrency;
    if (!isSupportedZmwCompanyPair(String(base ?? ""), display == null ? null : String(display))) {
      throw new CompanyParentValidationError(
        "ZMW display currency currently requires USD as the company's base currency."
      );
    }
  }
  return payload;
}

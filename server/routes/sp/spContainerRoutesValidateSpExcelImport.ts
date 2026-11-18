// Extracted from ./spContainerRoutes.ts to keep that module under the source-size cap.
import { db } from "../../db";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { ledgerAccounts, spContainers, stockItems } from "@shared/schema";
import { supplierService } from "../suppliers/supplierService";
import { FRESH_START_OTW_SOURCE_NAME, isGoldenCoastOtwSource } from "@shared/goldenCoastOtwSource";

// GC-LSHI partner-capital roles are authoritative; never rely on a browser-sent
// company name or a client flag to decide whether supplier-free posting is safe.
export async function isFreshStartOtwCompany(companyId: number): Promise<boolean> {
  const accounts = await db
    .select({
      subType: ledgerAccounts.subType,
    })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        isNull(ledgerAccounts.deletedAt),
        eq(ledgerAccounts.active, true),
        inArray(ledgerAccounts.subType, ["gc_partner_capital", "gc_owner_capital"])
      )
    );
  return isGoldenCoastOtwSource(accounts);
}

// Validate Supplier Payable Excel imports before any invoice or voucher is written.
// The same check is repeated inside the posting transaction after taking a
// company-scoped advisory lock, so concurrent imports cannot double post.
export async function validateSpExcelImport(
  companyId: number,
  body: Record<string, unknown>,
  tx: Pick<typeof db, "select"> = db,
  checkSupplier = true,
  freshStartOtw = false
): Promise<{ errors: string[]; warnings: string[] }> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const supplierId = Number(body.supplierId);
  const containerNumber = String(body.containerNumber ?? "").trim();
  const invoiceNumber = String(body.invoiceNumber ?? "").trim();
  const invoiceDate = String(body.invoiceDate ?? "");
  const invoiceTotal = Number(body.invoiceTotalUsd);
  const discountPct = Number(body.discountPct ?? 0);
  const lines = Array.isArray(body.lines) ? (body.lines as Array<Record<string, unknown>>) : null;

  if (freshStartOtw) {
    if (body.supplierId != null && body.supplierId !== "" && body.supplierId !== 0) {
      errors.push("Fresh Start FZE imports cannot be linked to a supplier account.");
    }
    if (String(body.supplierName ?? "") !== FRESH_START_OTW_SOURCE_NAME) {
      errors.push("Fresh Start FZE is the required internal container source.");
    }
  } else if (!Number.isSafeInteger(supplierId) || supplierId <= 0) {
    errors.push("Select a valid supplier.");
  }
  if (!containerNumber) errors.push("Container number is required.");
  if (!invoiceNumber) errors.push("Invoice / PO number is required.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(invoiceDate) || Number.isNaN(Date.parse(invoiceDate))) {
    errors.push("A valid invoice date is required.");
  }
  if (!Number.isFinite(invoiceTotal) || invoiceTotal <= 0) errors.push("Invoice total must be positive.");
  if (!Number.isFinite(discountPct) || discountPct < 0 || discountPct > 100) {
    errors.push("Discount must be between 0 and 100%.");
  }
  if (!Array.isArray(lines) || lines.length === 0 || lines.length > 10000) {
    errors.push("Excel must contain 1 to 10,000 valid item lines.");
  }

  if (!freshStartOtw && checkSupplier && Number.isSafeInteger(supplierId) && supplierId > 0) {
    const companySuppliers = await supplierService.list(companyId, "");
    const supplier = companySuppliers.find((s) => s.id === supplierId);
    if (!supplier) {
      errors.push("Supplier is not available in the selected Supplier Payable company.");
    } else if (supplier.legalName !== String(body.supplierName ?? "")) {
      errors.push("Supplier details changed. Select the supplier again.");
    }
  }

  let chargesTotal = 0;
  for (const field of ["freightEstimateUsd", "surchargeUsd", "fumigationUsd", "documentChargesUsd"]) {
    const amount = Number(body[field] ?? 0);
    if (!Number.isFinite(amount) || amount < 0) {
      errors.push(field + " must be a non-negative amount.");
    } else {
      chargesTotal += amount;
    }
  }

  let itemsTotal = 0;
  if (Array.isArray(lines) && lines.length > 0 && lines.length <= 10000) {
    for (const [index, line] of lines.entries()) {
      const qty = Number(line?.qty);
      const rate = Number(line?.unitRateUsd);
      if (
        !String(line?.articleCode ?? "").trim() ||
        !Number.isFinite(qty) ||
        qty <= 0 ||
        !Number.isFinite(rate) ||
        rate < 0
      ) {
        errors.push("Invalid code, quantity or rate on line " + (index + 1) + ".");
        if (errors.length > 20) break;
      } else {
        itemsTotal += qty * rate;
      }
    }
    const unmatched = lines.filter((line) => !line?.stockItemId).length;
    if (freshStartOtw && unmatched > 0) {
      errors.push(
        unmatched +
          " Excel item line(s) have no matching GC-LSHI stock item. Add or map stock items before importing into Golden Coast Phase 8."
      );
    } else if (unmatched > 0) {
      warnings.push(unmatched + " item line(s) have no matching stock item/alias; map them before offloading.");
    }
    if (freshStartOtw && lines.length > 100) {
      errors.push("Golden Coast Phase 8 supports up to 100 item lines in one container.");
    }
    if (freshStartOtw) {
      const linked = lines.map((line) => Number(line.stockItemId));
      if (new Set(linked).size !== linked.length) {
        errors.push(
          "Golden Coast Phase 8 requires each stock item only once in a container. Consolidate duplicate item rows."
        );
      }
    }
    const linkedIds = [
      ...new Set<number>(lines.filter((line) => line?.stockItemId != null).map((line) => Number(line.stockItemId))),
    ];
    if (linkedIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      errors.push("Invalid stock item link in the imported Excel lines.");
    } else if (linkedIds.length > 0) {
      const found = await tx
        .select({ id: stockItems.id })
        .from(stockItems)
        .where(and(eq(stockItems.companyId, companyId), inArray(stockItems.id, linkedIds)));
      if (found.length !== linkedIds.length) {
        errors.push("An imported stock item belongs to another company or no longer exists.");
      }
    }
  }

  if (errors.length === 0) {
    const expected = itemsTotal * (1 - discountPct / 100) + chargesTotal;
    // The Excel conversion stores a four-decimal discount percentage.
    const tolerance = 0.03 + itemsTotal * 0.0000006 + (Array.isArray(lines) ? lines.length * 0.005 : 0);
    if (Math.abs(invoiceTotal - expected) > tolerance) {
      errors.push("Invoice total does not reconcile with item lines, discount and charges.");
    }
  }

  if (containerNumber) {
    const duplicate = await tx
      .select({ id: spContainers.id })
      .from(spContainers)
      .where(
        and(
          eq(spContainers.companyId, companyId),
          sql`upper(trim(${spContainers.containerNumber})) = upper(${containerNumber})`,
          sql`${spContainers.status} <> 'cancelled'`
        )
      )
      .limit(1);
    if (duplicate.length) errors.push("This container is already imported for this company.");
  }
  return { errors, warnings };
}

// Extracted from ./po-import.ts: a stage of the purchase-order import handler.
import { db } from "../../db";
import { storage } from "../../storage";
import { purchaseOrders, type Container } from "@shared/schema";
import { eq, and, like } from "drizzle-orm";
import { supplierService } from "../suppliers/supplierService";
import { collectPreviewItemErrors, findPreviewContainer, type PoImportPreviewItem } from "./po-import-preview";
import { applyExplicitImportCurrency } from "./poImportCurrency";
import { convertZmwContainerPreview, splitNativeCharges } from "./poImportZambia";
import { validateFactoryDispatchPoImport } from "./factoryDispatchPoImportGuard";
import {
  inspectFactoryTripPoReceipt,
  reserveFactoryTripPoReceipt,
  canonicalFactoryTripPayloadFingerprint,
} from "./factoryDispatchPoImportReceipt";
import type { Request, Response } from "express";
import { allocatePoCharges } from "./poChargeAllocation";

type PoImportStepResult = Awaited<ReturnType<typeof poImportStep>>;

export async function poImportStep({ req, res }: { req: Request; res: Response }) {
  if (!req.session.currentCompanyId) {
    return { done: true as const, value: res.status(400).json({ message: "No company selected" }) };
  }

  const {
    fileHash,
    fileName,
    containerNumber,
    supplierId,
    importDate,
    preview,
    freightPaidBy,
    freightParentAccountId,
  } = req.body;

  const resolvedFreightPaidBy: string = freightPaidBy || "supplier";
  const resolvedFreightParentAccountId: number | null = freightParentAccountId ? Number(freightParentAccountId) : null;

  if (!fileHash || !containerNumber || !supplierId || !importDate || !preview) {
    return { done: true as const, value: res.status(400).json({ message: "Missing required fields" }) };
  }

  const currentCompanyId = req.session.currentCompanyId;
  const currentCompanyLink = await storage.getCompanyById(currentCompanyId);
  const parentCompanyId = currentCompanyLink?.parentCompanyId ?? null;
  const isSubsidiary = parentCompanyId !== null;
  const companyType = currentCompanyLink?.companyType ?? null;
  const isSpCompany = companyType === "supplier_partner";
  const configuredIntercompanyCreditAccount = !isSpCompany
    ? await storage.getConfiguredIntercompanyCreditAccount(currentCompanyId)
    : undefined;
  const configuredIntercompanyCreditAccountId = configuredIntercompanyCreditAccount?.id ?? null;

  // Validate parent freight account when freightPaidBy=parent
  if (resolvedFreightPaidBy === "parent" && !resolvedFreightParentAccountId) {
    return {
      done: true as const,
      value: res
        .status(400)
        .json({ message: "A parent freight account must be selected when freight is paid by parent company" }),
    };
  }

  // SERVER-SIDE VALIDATION - Mandatory before import
  const validationErrors: string[] = [];

  // Supplier master data may be inherited from the explicitly linked parent
  // company, but the import records remain owned by the active company.
  const visibleSuppliers = await supplierService.list(currentCompanyId, "", true);
  const supplier = visibleSuppliers.find((s) => s.id === supplierId);
  if (!supplier) {
    validationErrors.push("Selected supplier not found");
  }

  // Get all stock items for validation
  const allStockItems = await storage.getAllStockItems(req.session.currentCompanyId!);

  // Validate all items in the preview. The validation endpoint reports a
  // missing container as an error and stops; this one used to walk straight
  // into containerPreview.items and throw a TypeError mid-import, surfacing
  // as a 500 after partial work. Typing the payload made that visible.
  const parsedPreview = findPreviewContainer(preview, containerNumber);
  if (!parsedPreview) {
    return { done: true as const, value: res.status(400).json({ message: "Container data not found in preview" }) };
  }
  const containerPreview = parsedPreview.container;
  // Currency normalization follows successful structural validation, before any writes.
  // This endpoint writes these figures, so a payload that did not carry them
  // as readable numbers is refused rather than summed into NaN.
  for (const line of parsedPreview.linesWithUnreadableMoney) {
    validationErrors.push(`Row ${line}: quantity, rate and line total must all be numbers`);
  }
  for (const total of parsedPreview.unreadableTotals) {
    validationErrors.push(`Container total ${total} is missing or not a number`);
  }
  // A charge stated as something unreadable is still summed into the
  // chargesTotal and grandTotal the payload carries, so accepting it would
  // write a container whose totals do not match its own charge records.
  for (const charge of parsedPreview.unreadableCharges) {
    validationErrors.push(`Container charge ${charge} is not a number`);
  }
  validationErrors.push(
    ...(await collectPreviewItemErrors(containerPreview.items, req.session.currentCompanyId!, allStockItems))
  );
  // This guard is repeated on the import action itself. Never assume the
  // client called Validate, or trust previously-resolved stockItemId.
  const factoryTripCheck = await validateFactoryDispatchPoImport(
    currentCompanyId,
    containerPreview,
    supplier,
    allStockItems
  );
  validationErrors.push(...factoryTripCheck.errors);
  if (factoryTripCheck.identity) {
    const previous = await inspectFactoryTripPoReceipt(currentCompanyId, factoryTripCheck.identity);
    if (previous) {
      validationErrors.push(
        previous.status === "IMPORTED"
          ? "This Factory dispatch truck is already imported into ERP."
          : "An earlier Factory dispatch PO import needs reconciliation; automatic retry is blocked."
      );
    }
  }

  // The explicitly selected invoice currency is stamped on every line (and
  // checked against the sheet) before any Kwacha conversion or write.
  validationErrors.push(...applyExplicitImportCurrency(containerPreview.items, req.body.currency, currentCompanyLink));

  // Reject import if validation fails
  if (validationErrors.length > 0) {
    return {
      done: true as const,
      value: res.status(400).json({
        message: "Validation failed",
        errors: validationErrors,
      }),
    };
  }

  // Historical ZMW is converted once before container, subsidiary voucher,
  // parent credit or stock writes (409 for a mixed-currency container).
  // Original Kwacha money is preserved on each line and each PO.
  const zambiaNative = await convertZmwContainerPreview(containerPreview, {
    companyId: currentCompanyId,
    date: importDate,
    exchangeRate: req.body.exchangeRate,
  });

  // Check idempotency
  const existingImport = await storage.getImportLogByHash(fileHash);
  if (existingImport) {
    return { done: true as const, value: res.status(400).json({ message: "This file has already been imported" }) };
  }

  // A container number that already exists is only a hard block if it already has
  // real financial data attached (PO, charges, or a sale) or belongs to another
  // company, or has moved past OTW (offloaded/sold). A container manually typed in
  // on the tracking page ahead of the invoice (still OTW, no PO/charges/sale yet) is
  // a placeholder — merge the imported PO/line items into that existing record
  // instead of creating a duplicate or blocking.
  const existingContainerCheck = await storage.getContainerByNumber(containerNumber);
  // This includes empty OTW placeholders: a Factory trip has an immutable
  // globally unique container identity and must not attach to another
  // manually-created tracking placeholder.
  if (factoryTripCheck.identity && existingContainerCheck) {
    return {
      done: true as const,
      value: res.status(409).json({
        code: "FD_PO_CONTAINER_ALREADY_EXISTS",
        message:
          "This Factory dispatch trip's ERP container already exists. Inspect that container before posting another PO.",
      }),
    };
  }
  // Reserve before the first ERP purchase/container/voucher write. The
  // unique origin index prevents concurrent imports, renamed files, or
  // edited rates from creating another supplier liability for this truck.
  // A failed downstream legacy import leaves a PENDING_REVIEW receipt;
  // never auto-retry a possibly partially posted purchase.
  const factoryTripReceiptId = factoryTripCheck.identity
    ? await reserveFactoryTripPoReceipt(
        {
          companyId: currentCompanyId,
          supplierId,
          supplierCode: supplier!.code,
          identity: factoryTripCheck.identity,
          fileHash,
          fileName,
          amount: factoryTripCheck.supplierTotal!,
          userId: req.session.userId || String(req.session.username || "system"),
        },
        canonicalFactoryTripPayloadFingerprint(factoryTripCheck.identity, containerPreview, supplier!.code)
      )
    : null;
  let container: Container;
  if (existingContainerCheck) {
    const blockedMessage = {
      message: `Container "${containerNumber}" already exists in the system. Each container number can only be imported once.`,
    };
    if (existingContainerCheck.companyId !== req.session.currentCompanyId) {
      return { done: true as const, value: res.status(400).json(blockedMessage) };
    }
    if (existingContainerCheck.status !== "OTW") {
      return { done: true as const, value: res.status(400).json(blockedMessage) };
    }
    const [existingPOs, existingCharges, existingSale] = await Promise.all([
      storage.getPurchaseOrdersByContainer(existingContainerCheck.id),
      storage.getChargesByContainer(existingContainerCheck.id),
      storage.getContainerSaleByContainerId(existingContainerCheck.id, existingContainerCheck.companyId),
    ]);
    if (existingPOs.length > 0 || existingCharges.length > 0 || existingSale) {
      return { done: true as const, value: res.status(400).json(blockedMessage) };
    }
    // Merge into the existing placeholder container, preserving its tracking fields
    // (shopName, eta, transporter, etc.) that may have been filled in manually.
    container = await storage.updateContainer(existingContainerCheck.id, {
      supplierId,
      status: "OTW",
      importDate,
      itemsTotal: containerPreview.itemsTotal.toString(),
      chargesTotal: containerPreview.chargesTotal.toString(),
      grandTotal: containerPreview.grandTotal.toString(),
    });
  } else {
    container = await storage.createContainer({
      companyId: req.session.currentCompanyId!,
      containerNumber,
      supplierId,
      status: "OTW",
      importDate,
      itemsTotal: containerPreview.itemsTotal.toString(),
      chargesTotal: containerPreview.chargesTotal.toString(),
      grandTotal: containerPreview.grandTotal.toString(),
    });
  }

  // Group items by PO
  const poGroups = containerPreview.items.reduce<Record<string, PoImportPreviewItem[]>>((acc, item) => {
    if (!acc[item.poNumber]) {
      acc[item.poNumber] = [];
    }
    acc[item.poNumber].push(item);
    return acc;
  }, {});

  // Auto-generate a PO number if the Excel PO Number column was blank
  if (poGroups[""]) {
    const year = new Date().getFullYear();
    const prefix = `PO-${year}-`;
    const companyId = req.session.currentCompanyId!;
    const existingPoRows = await db
      .select({ poNumber: purchaseOrders.poNumber })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.companyId, companyId), like(purchaseOrders.poNumber, `${prefix}%`)));
    let maxSeq = 0;
    for (const { poNumber: pn } of existingPoRows) {
      const n = parseInt(pn.slice(prefix.length), 10);
      if (!isNaN(n) && n > maxSeq) maxSeq = n;
    }
    const generatedPoNumber = `${prefix}${String(maxSeq + 1).padStart(3, "0")}`;
    poGroups[generatedPoNumber] = poGroups[""];
    delete poGroups[""];
  }

  // Get fresh stock items data for barcode lookup during import
  const freshStockItems = await storage.getAllStockItems(req.session.currentCompanyId!);

  // Get or create "Purchases" ledger account for double-entry bookkeeping
  let purchasesAccount = await storage.getLedgerAccountByCode("PURCHASES", req.session.currentCompanyId!);
  if (!purchasesAccount) {
    // Create default Purchases account if it doesn't exist
    purchasesAccount = await storage.createLedgerAccount({
      companyId: req.session.currentCompanyId!,
      code: "PURCHASES",
      name: "Purchases",
      accountType: "Expense",
      openingBalance: "0",
      openingBalanceSide: "Dr",
      active: true,
    });
  }

  // Get or create "Import Charges" ledger account for container charges
  const importChargesAccount = await storage.getLedgerAccountByCode("IMPORT_CHARGES", req.session.currentCompanyId!);
  if (!importChargesAccount) {
    await storage.createLedgerAccount({
      companyId: req.session.currentCompanyId!,
      code: "IMPORT_CHARGES",
      name: "Import Charges",
      accountType: "Expense",
      openingBalance: "0",
      openingBalanceSide: "Dr",
      active: true,
    });
  }

  // Get charges for this container
  const charges = containerPreview.charges;

  // Container-level charges
  const containerFreight = charges.freight || 0;
  const containerSurcharge = charges.surcharge || 0;
  const containerFumigation = charges.fumigation || 0;
  const containerDocumentCharges = charges.documentCharges || 0;
  const containerDiscount = charges.discount || 0;

  return {
    done: false as const,
    fileHash,
    fileName,
    containerNumber,
    supplierId,
    importDate,
    resolvedFreightPaidBy,
    resolvedFreightParentAccountId,
    currentCompanyId,
    currentCompanyLink,
    parentCompanyId,
    isSubsidiary,
    companyType,
    isSpCompany,
    configuredIntercompanyCreditAccountId,
    supplier,
    containerPreview,
    factoryTripCheck,
    zambiaNative,
    factoryTripReceiptId,
    container,
    poGroups,
    freshStockItems,
    purchasesAccount,
    charges,
    containerFreight,
    containerSurcharge,
    containerFumigation,
    containerDocumentCharges,
    containerDiscount,
  };
}

export function poImportChargePlan({ s1 }: { s1: Extract<PoImportStepResult, { done: false }> }) {
  const {
    charges,
    containerFreight,
    containerSurcharge,
    containerFumigation,
    containerDocumentCharges,
    containerDiscount,
    poGroups,
    zambiaNative,
    resolvedFreightPaidBy,
  } = s1;
  const containerOtherCharges = charges.otherCharges || 0;
  const hasAnyCharges =
    containerFreight > 0 ||
    containerSurcharge > 0 ||
    containerFumigation > 0 ||
    containerDocumentCharges > 0 ||
    containerDiscount > 0 ||
    containerOtherCharges > 0;

  // Split each container charge across the POs by item value, exact to the cent.
  const poEntries = Object.entries(poGroups);
  // Native and base charge splits share the PO grouping, but never mix units.
  const nativeChargeSplits = splitNativeCharges(zambiaNative, poEntries, resolvedFreightPaidBy === "parent");
  const chargeSplits = allocatePoCharges(
    poEntries.map(([, items]) => items.map((item) => item.lineTotal)),
    {
      freight: containerFreight,
      surcharge: containerSurcharge,
      fumigation: containerFumigation,
      documentCharges: containerDocumentCharges,
      discount: containerDiscount,
      otherCharges: containerOtherCharges,
    },
    resolvedFreightPaidBy === "parent"
  );

  return { hasAnyCharges, poEntries, nativeChargeSplits, chargeSplits };
}

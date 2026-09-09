import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../../services/accounting/infrastructureVoucherIdentity";
/**
 * importRoutes: PoImport endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getClientDate } from "../../lib/dateUtils";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { storage } from "../../storage";
import { requireAuth } from "../../auth";
import { ledgerAccounts, purchaseOrders, voucherEntries, type Container } from "@shared/schema";
import { eq, and, isNull, like } from "drizzle-orm";
import {
  ParentCompanyPostingScopeError,
  runWithVerifiedParentCompanyScope,
} from "../../services/security/parentCompanyPostingScope";
import { resolvePoImportCreditTarget } from "../../services/accounting/poImportAccounting";
import { supplierService } from "../suppliers/supplierService";
import { collectPreviewItemErrors, findPreviewContainer, type PoImportPreviewItem } from "./po-import-preview";

export function registerPoImportRoutes(app: Express) {
  app.post("/api/po-import/validate", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
      }

      const { containerNumber, supplierId, preview, freightPaidBy, freightParentAccountId } = req.body;

      if (!containerNumber || !supplierId || !preview) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const errors: string[] = [];

      // Supplier master data may be inherited from the explicitly linked parent
      // company, but the import records remain owned by the active company.
      const visibleSuppliers = await supplierService.list(req.session.currentCompanyId, "", true);
      const supplier = visibleSuppliers.find((s) => s.id === supplierId);
      if (!supplier) {
        errors.push("Selected supplier not found");
      }

      // A container number that already exists is only a problem if it already has
      // real financial data attached (i.e. it was already imported/offloaded/sold before).
      // A container that was manually added on the tracking page (container number typed
      // in ahead of the invoice, still status OTW with no PO/charges/sale yet) is treated
      // as a placeholder — the import will attach its PO/line items to that existing
      // record instead of creating a duplicate. Must be in the same company to be eligible.
      const existingContainer = await storage.getContainerByNumber(containerNumber);
      if (existingContainer) {
        if (existingContainer.companyId !== req.session.currentCompanyId) {
          errors.push(`Container number "${containerNumber}" already exists — it cannot be imported again`);
        } else if (existingContainer.status !== "OTW") {
          errors.push(`Container number "${containerNumber}" already exists — it cannot be imported again`);
        } else {
          const [existingPOs, existingCharges, existingSale] = await Promise.all([
            storage.getPurchaseOrdersByContainer(existingContainer.id),
            storage.getChargesByContainer(existingContainer.id),
            storage.getContainerSaleByContainerId(existingContainer.id, existingContainer.companyId),
          ]);
          if (existingPOs.length > 0 || existingCharges.length > 0 || existingSale) {
            errors.push(`Container number "${containerNumber}" already exists — it cannot be imported again`);
          }
        }
      }

      // Get all stock items for validation
      const allStockItems = await storage.getAllStockItems(req.session.currentCompanyId!);

      // Validate all items in the preview
      const parsedPreview = findPreviewContainer(preview, containerNumber);
      if (!parsedPreview) {
        errors.push("Container data not found in preview");
      } else {
        const containerPreview = parsedPreview.container;
        errors.push(
          ...(await collectPreviewItemErrors(containerPreview.items, req.session.currentCompanyId!, allStockItems))
        );

        // Validate parent freight account when freight is present and paid by parent
        const containerFreight = containerPreview.charges?.freight || 0;
        if (freightPaidBy === "parent" && containerFreight > 0 && !freightParentAccountId) {
          errors.push("A parent company freight account must be selected when freight is paid by parent company");
        }
      }

      res.json({
        valid: errors.length === 0,
        errors,
      });
    } catch (error: unknown) {
      logger.error("PO Import validation error:", { error: error });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PO Import - Import data
  app.post("/api/po-import/import", requireAuth, async (req, res) => {
    try {
      if (!req.session.currentCompanyId) {
        return res.status(400).json({ message: "No company selected" });
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
      const resolvedFreightParentAccountId: number | null = freightParentAccountId
        ? Number(freightParentAccountId)
        : null;

      if (!fileHash || !containerNumber || !supplierId || !importDate || !preview) {
        return res.status(400).json({ message: "Missing required fields" });
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
        return res
          .status(400)
          .json({ message: "A parent freight account must be selected when freight is paid by parent company" });
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
        return res.status(400).json({ message: "Container data not found in preview" });
      }
      const containerPreview = parsedPreview.container;
      // This endpoint writes these figures, so a payload that did not carry them
      // as readable numbers is refused rather than summed into NaN.
      for (const line of parsedPreview.linesWithUnreadableMoney) {
        validationErrors.push(`Row ${line}: quantity, rate and line total must all be numbers`);
      }
      for (const total of parsedPreview.unreadableTotals) {
        validationErrors.push(`Container total ${total} is missing or not a number`);
      }
      validationErrors.push(
        ...(await collectPreviewItemErrors(containerPreview.items, req.session.currentCompanyId!, allStockItems))
      );

      // Reject import if validation fails
      if (validationErrors.length > 0) {
        return res.status(400).json({
          message: "Validation failed",
          errors: validationErrors,
        });
      }

      // Check idempotency
      const existingImport = await storage.getImportLogByHash(fileHash);
      if (existingImport) {
        return res.status(400).json({ message: "This file has already been imported" });
      }

      // A container number that already exists is only a hard block if it already has
      // real financial data attached (PO, charges, or a sale) or belongs to another
      // company, or has moved past OTW (offloaded/sold). A container manually typed in
      // on the tracking page ahead of the invoice (still OTW, no PO/charges/sale yet) is
      // a placeholder — merge the imported PO/line items into that existing record
      // instead of creating a duplicate or blocking.
      const existingContainerCheck = await storage.getContainerByNumber(containerNumber);
      let container: Container;
      if (existingContainerCheck) {
        const blockedMessage = {
          message: `Container "${containerNumber}" already exists in the system. Each container number can only be imported once.`,
        };
        if (existingContainerCheck.companyId !== req.session.currentCompanyId) {
          return res.status(400).json(blockedMessage);
        }
        if (existingContainerCheck.status !== "OTW") {
          return res.status(400).json(blockedMessage);
        }
        const [existingPOs, existingCharges, existingSale] = await Promise.all([
          storage.getPurchaseOrdersByContainer(existingContainerCheck.id),
          storage.getChargesByContainer(existingContainerCheck.id),
          storage.getContainerSaleByContainerId(existingContainerCheck.id, existingContainerCheck.companyId),
        ]);
        if (existingPOs.length > 0 || existingCharges.length > 0 || existingSale) {
          return res.status(400).json(blockedMessage);
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
      let importChargesAccount = await storage.getLedgerAccountByCode("IMPORT_CHARGES", req.session.currentCompanyId!);
      if (!importChargesAccount) {
        importChargesAccount = await storage.createLedgerAccount({
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
      const containerOtherCharges = charges.otherCharges || 0;
      const hasAnyCharges =
        containerFreight > 0 ||
        containerSurcharge > 0 ||
        containerFumigation > 0 ||
        containerDocumentCharges > 0 ||
        containerDiscount > 0 ||
        containerOtherCharges > 0;

      // Calculate total items value across all POs for pro-rating charges
      const totalAllItemsValue = Object.values(poGroups).reduce(
        (sum, items) => sum + items.reduce((s, item) => s + item.lineTotal, 0),
        0
      );

      // Track allocated charges for remainder reconciliation
      let allocatedFreight = 0,
        allocatedSurcharge = 0,
        allocatedFumigation = 0;
      let allocatedDocCharges = 0,
        allocatedDiscount = 0,
        allocatedOtherCharges = 0;
      const poEntries = Object.entries(poGroups);

      // Create POs and line items
      for (let poIndex = 0; poIndex < poEntries.length; poIndex++) {
        const [poNumber, items] = poEntries[poIndex];
        const isLastPO = poIndex === poEntries.length - 1;
        const poItems = items;
        const poItemsTotal = poItems.reduce((sum, item) => sum + item.lineTotal, 0);

        // Pro-rate charges based on this PO's items proportion of total
        const proportion = totalAllItemsValue > 0 ? poItemsTotal / totalAllItemsValue : 0;

        // For last PO, assign remainder to ensure totals match exactly
        let poFreight, poSurcharge, poFumigation, poDocumentCharges, poDiscount, poOtherCharges;
        if (isLastPO) {
          poFreight = Math.round((containerFreight - allocatedFreight) * 100) / 100;
          poSurcharge = Math.round((containerSurcharge - allocatedSurcharge) * 100) / 100;
          poFumigation = Math.round((containerFumigation - allocatedFumigation) * 100) / 100;
          poDocumentCharges = Math.round((containerDocumentCharges - allocatedDocCharges) * 100) / 100;
          poDiscount = Math.round((containerDiscount - allocatedDiscount) * 100) / 100;
          poOtherCharges = Math.round((containerOtherCharges - allocatedOtherCharges) * 100) / 100;
        } else {
          poFreight = Math.round(containerFreight * proportion * 100) / 100;
          poSurcharge = Math.round(containerSurcharge * proportion * 100) / 100;
          poFumigation = Math.round(containerFumigation * proportion * 100) / 100;
          poDocumentCharges = Math.round(containerDocumentCharges * proportion * 100) / 100;
          poDiscount = Math.round(containerDiscount * proportion * 100) / 100;
          poOtherCharges = Math.round(containerOtherCharges * proportion * 100) / 100;
          // Track allocated amounts
          allocatedFreight += poFreight;
          allocatedSurcharge += poSurcharge;
          allocatedFumigation += poFumigation;
          allocatedDocCharges += poDocumentCharges;
          allocatedDiscount += poDiscount;
          allocatedOtherCharges += poOtherCharges;
        }

        // Calculate grand total (items + all charges - discount)
        const poChargesTotal = poFreight + poSurcharge + poFumigation + poDocumentCharges - poDiscount + poOtherCharges;
        const poGrandTotal = poItemsTotal + poChargesTotal;

        // When freight is paid by parent, exclude freight from the subsidiary's supplier balance
        const poIntercoTotal =
          resolvedFreightPaidBy === "parent" && poFreight > 0
            ? poItemsTotal + poSurcharge + poFumigation + poDocumentCharges - poDiscount + poOtherCharges
            : poGrandTotal;

        // Create voucher for this PO
        // If subsidiary with parent credit account: entries created here at import time
        // Otherwise: entries created at container offload time per Tally conventions
        const voucher = await storage.createVoucher({
          companyId: currentCompanyId,
          postingSource: infrastructurePostingIdentity("po-import", `${currentCompanyId}:${poNumber}`, "purchase"),
          currency: "USD",
          voucherNumber: `PO-${poNumber}-${Date.now()}`,
          voucherType: "Purchase",
          voucherDate: importDate,
          description: `${containerNumber} ${supplier?.legalName || "Unknown"}`,
          totalAmount: (resolvedFreightPaidBy === "parent" ? poGrandTotal : poIntercoTotal).toString(),
          optional: false,
          sourceModule: "ERP",
        });

        // Parent-side accounting is deliberately separate from the local
        // posting. A Supplier Partner keeps its OTW/Clearing voucher in the
        // child company, then also posts the intercompany receivable and
        // supplier payable in the explicitly linked parent company.
        const createParentIntercompanyPosting = async () => {
          if (!parentCompanyId) return;

          const linkedParentCompanyId = parentCompanyId;
          const subsidiaryName = currentCompanyLink?.name || `Company ${currentCompanyId}`;

          // Find or create "[Subsidiary Name] Credit" account in parent
          // (Asset - receivable). The companyId argument is mandatory on every
          // lookup so a same-named account in another tenant cannot be used.
          const subsidiaryAccountName = `${subsidiaryName} Credit`;
          let subsidiaryReceivableAccount = await storage.getLedgerAccountByName(
            subsidiaryAccountName,
            linkedParentCompanyId
          );
          if (!subsidiaryReceivableAccount) {
            const parentAccountPrefix = subsidiaryName.substring(0, 3).toUpperCase() + "CRD";
            let code = parentAccountPrefix;
            let suffix = 1;
            while (await storage.getLedgerAccountByCode(code, linkedParentCompanyId)) {
              code = parentAccountPrefix + suffix;
              suffix++;
            }
            subsidiaryReceivableAccount = await storage.createLedgerAccount({
              companyId: linkedParentCompanyId,
              name: subsidiaryAccountName,
              code,
              accountType: "Asset",
              subType: "Current Asset",
            });
          }

          const hasParentFreight =
            resolvedFreightPaidBy === "parent" && resolvedFreightParentAccountId && poFreight > 0;
          if (hasParentFreight) {
            const freightAccount = await storage.getLedgerAccountById(resolvedFreightParentAccountId);
            if (!freightAccount || freightAccount.companyId !== linkedParentCompanyId || freightAccount.deletedAt) {
              throw new Error("The selected parent freight account does not belong to the linked parent company");
            }
          }

          // Parent voucher:
          //   DR Subsidiary Receivable (gross amount)
          //   CR Supplier (goods/non-freight amount)
          //   CR Parent Freight Account (freight, when parent-paid)
          const intercoParentTotal = hasParentFreight ? poGrandTotal : poIntercoTotal;
          const parentEntries = [
            {
              ledgerAccountId: subsidiaryReceivableAccount.id,
              debitAmount: intercoParentTotal.toFixed(2),
              creditAmount: "0",
              narration: `${subsidiaryName} PO ${poNumber} - Container ${containerNumber}`,
            },
            {
              supplierId,
              debitAmount: "0",
              creditAmount: poIntercoTotal.toFixed(2),
              narration: `${subsidiaryName} PO ${poNumber} - Container ${containerNumber}`,
            },
            ...(hasParentFreight
              ? [
                  {
                    ledgerAccountId: resolvedFreightParentAccountId!,
                    debitAmount: "0",
                    creditAmount: poFreight.toFixed(2),
                    narration: `Freight - ${subsidiaryName} PO ${poNumber} - Container ${containerNumber}`,
                  },
                ]
              : []),
          ];

          const postingSource = infrastructurePostingIdentity(
            "po-import",
            `${currentCompanyId}:${poNumber}`,
            "parent-intercompany"
          );

          // Use the child company and PO in the identity. The durable marker
          // is stored in the parent tenant, so PO-123 from two subsidiaries
          // must never collide. Entries are written in the same transaction as
          // the marker; replay clears and rebuilds them instead of appending.
          return db.transaction(async (tx) => {
            const { voucher: parentVoucher } = await insertInfrastructureVoucherTx(
              tx,
              {
                companyId: linkedParentCompanyId,
                voucherNumber: `IC-${currentCompanyId}-${poNumber}-${Date.now()}`,
                voucherType: "Journal",
                voucherDate: importDate,
                description: `${containerNumber} ${supplier?.legalName || "Unknown"}`,
                totalAmount: intercoParentTotal.toString(),
                optional: false,
                sourceModule: "ERP",
                currency: "USD",
              },
              postingSource,
              {
                childCompanyId: currentCompanyId,
                poNumber,
                containerNumber,
                supplierId,
                freightPaidBy: resolvedFreightPaidBy,
                freightParentAccountId: resolvedFreightParentAccountId,
                entries: parentEntries,
              }
            );

            await tx.insert(voucherEntries).values(
              parentEntries.map((entry) => ({
                voucherId: parentVoucher.id,
                ...entry,
              }))
            );

            return parentVoucher;
          });
        };

        if (isSpCompany) {
          const [otwAcct] = await db
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, currentCompanyId),
                eq(ledgerAccounts.subType, "sp_goods_otw"),
                isNull(ledgerAccounts.deletedAt)
              )
            );

          const [otwClrAcct] = await db
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, currentCompanyId),
                eq(ledgerAccounts.subType, "sp_otw_clearing"),
                isNull(ledgerAccounts.deletedAt)
              )
            );

          if (!otwAcct || !otwClrAcct) {
            return res.status(400).json({
              message: "SP accounts not configured. Please run SP Setup first at /sp/setup.",
            });
          }

          // DR Goods OTW (Asset increases — goods are on the way)
          await storage.createVoucherEntry({
            voucherId: voucher.id,
            ledgerAccountId: otwAcct.id,
            debitAmount: poGrandTotal.toFixed(2),
            creditAmount: "0",
            narration: `PO ${poNumber} - Container ${containerNumber}`,
          });

          // CR OTW Clearing (Liability — we owe for goods in transit)
          await storage.createVoucherEntry({
            voucherId: voucher.id,
            ledgerAccountId: otwClrAcct.id,
            supplierId: supplierId,
            debitAmount: "0",
            creditAmount: poGrandTotal.toFixed(2),
            narration: `PO ${poNumber} - Container ${containerNumber}`,
          });
        } else if (isSubsidiary) {
          // Get the subsidiary's company settings for parent credit account
          let parentCreditAccountId = configuredIntercompanyCreditAccountId;

          // Get the current company name for the parent company's receivable account
          const currentCompany = await storage.getCompanyById(currentCompanyId);
          const subsidiaryName = currentCompany?.name || `Company ${currentCompanyId}`;

          // Auto-create Parent Credit Account if it doesn't exist
          if (!parentCreditAccountId) {
            // Get parent company name for the account
            const parentCompany = await storage.getCompanyById(parentCompanyId);
            const parentName = parentCompany?.name || "Parent Company";
            const creditAccountName = `${parentName} Credit`;

            // Try to find or create the account (with retry for concurrent requests)
            for (let attempt = 0; attempt < 3 && !parentCreditAccountId; attempt++) {
              try {
                // Always fetch first - handles concurrent creation
                let existingAccount = await storage.getLedgerAccountByName(creditAccountName, currentCompanyId);

                if (!existingAccount && attempt < 2) {
                  // Auto-generate unique code
                  let code = parentName.substring(0, 3).toUpperCase() + "CRD";
                  let suffix = 1;
                  while (await storage.getLedgerAccountByCode(code, currentCompanyId)) {
                    code = parentName.substring(0, 3).toUpperCase() + "CRD" + suffix;
                    suffix++;
                  }
                  existingAccount = await storage.createLedgerAccount({
                    companyId: currentCompanyId,
                    name: creditAccountName,
                    code,
                    accountType: "Liability",
                    subType: "Current Liability",
                  });
                }

                if (existingAccount?.id) {
                  parentCreditAccountId = existingAccount.id;

                  // Save to company settings for future use
                  await storage.upsertCompanySettings({
                    companyId: currentCompanyId,
                    parentCreditAccountId: parentCreditAccountId,
                  });
                  logger.info(
                    `Auto-created Parent Credit Account: ${creditAccountName} (ID: ${parentCreditAccountId})`
                  );
                }
              } catch (err: unknown) {
                logger.info(`Parent Credit Account creation attempt ${attempt + 1} failed, will retry fetch:`, {
                  error: getErrorMessage(err),
                });
                // On any error, loop will retry with fetch-first approach
              }
            }
          }

          if (parentCreditAccountId) {
            // Find or create a Purchases account for the subsidiary
            let purchasesAccount = await storage.getLedgerAccountByName("Purchases", currentCompanyId);
            if (!purchasesAccount) {
              purchasesAccount = await storage.createLedgerAccount({
                companyId: currentCompanyId,
                name: "Purchases",
                code: "PURCHASES",
                accountType: "Expense",
                subType: "Direct Expense",
              });
            }

            // Create voucher entries in SUBSIDIARY: DR Purchases, CR Parent Credit Account
            // When freight is parent-paid, the full grossTotal (including freight) is credited
            // to the parent account — the parent will settle freight with the freight company.
            const subsidiaryVoucherAmount =
              resolvedFreightPaidBy === "parent" && poFreight > 0 ? poGrandTotal : poIntercoTotal;
            await storage.createVoucherEntry({
              voucherId: voucher.id,
              ledgerAccountId: purchasesAccount.id,
              debitAmount: subsidiaryVoucherAmount.toFixed(2),
              creditAmount: "0",
              narration: `PO ${poNumber} - Container ${containerNumber}`,
            });

            await storage.createVoucherEntry({
              voucherId: voucher.id,
              ledgerAccountId: parentCreditAccountId,
              debitAmount: "0",
              creditAmount: subsidiaryVoucherAmount.toFixed(2),
              narration: `PO ${poNumber} - Credit from ${subsidiaryName}`,
            });
          }
        } else {
          // === PARENT/STANDALONE COMPANY: Create local payable entry ===
          // A configured intercompany account takes precedence for ERP companies.
          // Without one, preserve the standard DR Purchases / CR Supplier behavior.

          // Find or create a Purchases account for the parent company
          let purchasesAccount = await storage.getLedgerAccountByName("Purchases", currentCompanyId);
          if (!purchasesAccount) {
            purchasesAccount = await storage.getLedgerAccountByCode("PURCHASES", currentCompanyId);
          }
          if (!purchasesAccount) {
            purchasesAccount = await storage.createLedgerAccount({
              companyId: currentCompanyId,
              name: "Purchases",
              code: "PURCHASES",
              accountType: "Expense",
              subType: "Direct Expense",
            });
          }

          // When freight is parent-paid, split the voucher:
          //   DR Purchases (intercoTotal)  CR Supplier (intercoTotal)   ← goods
          //   DR Purchases (freight)       CR FreightAccount (freight)  ← freight payable
          // Otherwise use grandTotal for both legs (supplier carries freight in their price).
          const hasParentFreight =
            resolvedFreightPaidBy === "parent" && resolvedFreightParentAccountId && poFreight > 0;
          const goodsAmount = hasParentFreight ? poIntercoTotal : poGrandTotal;

          // DR Purchases — goods portion
          await storage.createVoucherEntry({
            voucherId: voucher.id,
            ledgerAccountId: purchasesAccount.id,
            debitAmount: goodsAmount.toFixed(2),
            creditAmount: "0",
            narration: `PO ${poNumber} - Container ${containerNumber}`,
          });

          // CR configured intercompany account when explicitly selected for this
          // ERP company; otherwise preserve the direct supplier payable behavior.
          const creditTarget = resolvePoImportCreditTarget({
            companyType,
            configuredIntercompanyCreditAccountId,
            supplierId,
          });
          if (creditTarget.kind === "intercompany") {
            await storage.createVoucherEntry({
              voucherId: voucher.id,
              ledgerAccountId: creditTarget.ledgerAccountId,
              debitAmount: "0",
              creditAmount: goodsAmount.toFixed(2),
              narration: `PO ${poNumber} - Intercompany credit`,
            });
          } else if (creditTarget.supplierId) {
            await storage.createVoucherEntry({
              voucherId: voucher.id,
              supplierId: creditTarget.supplierId,
              debitAmount: "0",
              creditAmount: goodsAmount.toFixed(2),
              narration: `PO ${poNumber} - Container ${containerNumber}`,
            });
          }

          // When freight is parent-paid: add freight entries to this same purchase voucher
          if (hasParentFreight) {
            // DR Purchases — freight portion (same account as goods debit)
            await storage.createVoucherEntry({
              voucherId: voucher.id,
              ledgerAccountId: purchasesAccount.id,
              debitAmount: poFreight.toFixed(2),
              creditAmount: "0",
              narration: `Freight - PO ${poNumber} - Container ${containerNumber}`,
            });
            // CR FreightParentAccount — we owe money to the freight company
            await storage.createVoucherEntry({
              voucherId: voucher.id,
              ledgerAccountId: resolvedFreightParentAccountId!,
              debitAmount: "0",
              creditAmount: poFreight.toFixed(2),
              narration: `Freight - PO ${poNumber} - Container ${containerNumber}`,
            });
          }
        }

        if (isSubsidiary && parentCompanyId) {
          // Every write in there lands in the parent company, which this request is not pinned
          // to, so it runs under the scope that re-verifies the parent link and the caller's
          // membership before the database scope moves.
          await runWithVerifiedParentCompanyScope(parentCompanyId, createParentIntercompanyPosting);
        }

        const po = await storage.createPurchaseOrder(
          {
            companyId: currentCompanyId,
            poNumber,
            containerId: container.id,
            supplierId,
            voucherId: voucher.id,
            currency: poItems[0]?.currency,
            itemsTotal: poItemsTotal.toString(),
            freight: poFreight.toString(),
            surcharge: poSurcharge.toString(),
            fumigation: poFumigation.toString(),
            documentCharges: poDocumentCharges.toString(),
            discount: poDiscount.toString(),
            otherCharges: poOtherCharges.toString(),
            chargesEdited: hasAnyCharges,
            freightPaidBy: resolvedFreightPaidBy,
            freightParentAccountId: resolvedFreightPaidBy === "parent" ? resolvedFreightParentAccountId : null,
          },
          getClientDate(req)
        );

        for (const item of poItems) {
          // Re-lookup stock item by code/alias or name to get fresh ID (not stale preview data)
          let stockItemId = item.stockItemId;
          let stockItem = null;

          // Try code/alias first, then fall back to name
          if (item.barcode) {
            stockItem = await storage.getStockItemByCodeOrAlias(item.barcode, req.session.currentCompanyId!);
          }
          if (!stockItem && item.itemName) {
            stockItem = freshStockItems.find((si) => si.name === item.itemName);
          }

          if (stockItem) {
            stockItemId = stockItem.id;
          }

          if (!stockItemId) {
            return res.status(400).json({
              message: `Stock item not found: ${item.barcode || item.itemName}. Please ensure all items exist before importing.`,
            });
          }

          await storage.createPOLineItem({
            poId: po.id,
            stockItemId: stockItemId,
            itemName: item.itemName,
            quantity: item.quantity.toString(),
            rate: item.rate.toString(),
            lineTotal: item.lineTotal.toString(),
          });
        }
      }

      // Create container charges records (for display in Container Extra Charges section)
      // Note: Charges are now consolidated into the main PO voucher, no separate vouchers needed
      const chargeTypesForContainer = [
        { type: "Freight", amount: charges.freight, isNegative: false },
        { type: "Surcharge", amount: charges.surcharge, isNegative: false },
        { type: "Fumigation", amount: charges.fumigation, isNegative: false },
        { type: "Discount", amount: charges.discount, isNegative: true },
        { type: "Document Charges", amount: charges.documentCharges, isNegative: false },
        { type: "Other Charges", amount: charges.otherCharges, isNegative: false },
      ];

      for (const charge of chargeTypesForContainer) {
        const chargeAmount = charge.amount ?? 0;
        if (chargeAmount > 0) {
          const actualAmount = charge.isNegative ? -chargeAmount : chargeAmount;

          // Create container charge record (for display only - charges are in PO voucher)
          await storage.createContainerCharge({
            containerId: container.id,
            chargeType: charge.type,
            amount: actualAmount.toString(),
          });
        }
      }

      // Create import log
      await storage.createImportLog({
        fileName,
        fileHash,
        rowCount: containerPreview.items.length,
        containerId: container.id,
        status: "Success",
      });

      res.json({
        success: true,
        containerId: container.id,
        containerNumber: container.containerNumber,
        itemsCount: containerPreview.itemsCount,
        grandTotal: containerPreview.grandTotal,
      });
    } catch (error: unknown) {
      logger.error("PO Import error:", { error: error });
      if (error instanceof ParentCompanyPostingScopeError) {
        res.status(error.status).json({ code: error.code, message: error.message });
        return;
      }
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

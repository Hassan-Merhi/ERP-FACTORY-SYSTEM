// Extracted from ./po-import.ts: a stage of importing one purchase order.
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { storage } from "../../storage";
import { ledgerAccounts } from "@shared/schema";
import { eq, and, isNull } from "drizzle-orm";
import { resolvePoImportCreditTarget } from "../../services/accounting/poImportAccounting";
import type { poImportStep } from "./poImportStep";
import type { poImportPoStep } from "./poImportPoStep";
import type { Response } from "express";

type PoImportStepResult = Awaited<ReturnType<typeof poImportStep>>;

export async function poImportPoStep2({
  s1,
  res,
  p1,
}: {
  s1: Extract<PoImportStepResult, { done: false }>;
  res: Response;
  p1: ReturnType<typeof poImportPoStep>;
}) {
  const { localEntries, poGrandTotal, poNumber, poFreight, poIntercoTotal } = p1;
  const {
    isSpCompany,
    currentCompanyId,
    containerNumber,
    supplierId,
    isSubsidiary,
    configuredIntercompanyCreditAccountId,
    parentCompanyId,
    resolvedFreightPaidBy,
    resolvedFreightParentAccountId,
    companyType,
  } = s1;

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
      return {
        done: true as const,
        value: res.status(400).json({
          message: "SP accounts not configured. Please run SP Setup first at /sp/setup.",
        }),
      };
    }

    // DR Goods OTW (Asset increases — goods are on the way)
    localEntries.push({
      ledgerAccountId: otwAcct.id,
      debitAmount: poGrandTotal.toFixed(2),
      creditAmount: "0",
      narration: `PO ${poNumber} - Container ${containerNumber}`,
    });

    // CR OTW Clearing (Liability — we owe for goods in transit)
    localEntries.push({
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
            logger.info(`Auto-created Parent Credit Account: ${creditAccountName} (ID: ${parentCreditAccountId})`);
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
        resolvedFreightPaidBy === "parent" && poFreight.gt(0) ? poGrandTotal : poIntercoTotal;
      localEntries.push({
        ledgerAccountId: purchasesAccount.id,
        debitAmount: subsidiaryVoucherAmount.toFixed(2),
        creditAmount: "0",
        narration: `PO ${poNumber} - Container ${containerNumber}`,
      });

      localEntries.push({
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
    const hasParentFreight = resolvedFreightPaidBy === "parent" && resolvedFreightParentAccountId && poFreight.gt(0);
    const goodsAmount = hasParentFreight ? poIntercoTotal : poGrandTotal;

    // DR Purchases — goods portion
    localEntries.push({
      ledgerAccountId: purchasesAccount.id,
      debitAmount: goodsAmount.toFixed(2),
      creditAmount: "0",
      narration: `PO ${poNumber} - Container ${containerNumber}`,
    });

    // CR configured intercompany account when explicitly selected for this
    // ERP company; otherwise preserve the direct supplier payable behavior.
    const creditTarget = resolvePoImportCreditTarget({
      companyType: companyType,
      // This branch is only for a root/standalone company. A stale
      // parentCreditAccountId must never divert its supplier payable.
      hasExplicitParentLink: false,
      configuredIntercompanyCreditAccountId: configuredIntercompanyCreditAccountId,
      supplierId: supplierId,
    });
    if (creditTarget.kind === "intercompany") {
      localEntries.push({
        ledgerAccountId: creditTarget.ledgerAccountId,
        debitAmount: "0",
        creditAmount: goodsAmount.toFixed(2),
        narration: `PO ${poNumber} - Intercompany credit`,
      });
    } else if (creditTarget.supplierId) {
      localEntries.push({
        supplierId: creditTarget.supplierId,
        debitAmount: "0",
        creditAmount: goodsAmount.toFixed(2),
        narration: `PO ${poNumber} - Container ${containerNumber}`,
      });
    }

    // When freight is parent-paid: add freight entries to this same purchase voucher
    if (hasParentFreight) {
      // DR Purchases — freight portion (same account as goods debit)
      localEntries.push({
        ledgerAccountId: purchasesAccount.id,
        debitAmount: poFreight.toFixed(2),
        creditAmount: "0",
        narration: `Freight - PO ${poNumber} - Container ${containerNumber}`,
      });
      // CR FreightParentAccount — we owe money to the freight company
      localEntries.push({
        ledgerAccountId: resolvedFreightParentAccountId!,
        debitAmount: "0",
        creditAmount: poFreight.toFixed(2),
        narration: `Freight - PO ${poNumber} - Container ${containerNumber}`,
      });
    }
  }

  return { done: false as const };
}

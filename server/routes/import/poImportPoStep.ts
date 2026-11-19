// Extracted from ./po-import.ts: a stage of importing one purchase order.
import {
  infrastructurePostingIdentity,
  insertInfrastructureVoucherTx,
} from "../../services/accounting/infrastructureVoucherIdentity";
import { db } from "../../db";
import { storage } from "../../storage";
import { voucherEntries, type InsertVoucherEntry } from "@shared/schema";
import type { poImportStep, poImportChargePlan } from "./poImportStep";

type PoImportStepResult = Awaited<ReturnType<typeof poImportStep>>;

export function poImportPoStep({
  s2,
  poIndex,
  s1,
}: {
  s2: ReturnType<typeof poImportChargePlan>;
  poIndex: number;
  s1: Extract<PoImportStepResult, { done: false }>;
}) {
  const { poEntries, chargeSplits } = s2;
  const {
    parentCompanyId,
    currentCompanyLink,
    currentCompanyId,
    resolvedFreightPaidBy,
    resolvedFreightParentAccountId,
    containerNumber,
    supplierId,
    importDate,
    supplier,
  } = s1;
  const [poNumber, items] = poEntries[poIndex];
  const poItems = items;
  const {
    itemsTotal: poItemsTotal,
    freight: poFreight,
    surcharge: poSurcharge,
    fumigation: poFumigation,
    documentCharges: poDocumentCharges,
    discount: poDiscount,
    otherCharges: poOtherCharges,
    grandTotal: poGrandTotal,
    // When freight is paid by parent, exclude freight from the subsidiary's supplier balance
    intercoTotal: poIntercoTotal,
  } = chargeSplits[poIndex];

  // Create voucher for this PO
  // If subsidiary with parent credit account: entries created here at import time
  // Otherwise: entries created at container offload time per Tally conventions
  // The header and its entries are written together below, in one transaction.
  const localEntries: Omit<InsertVoucherEntry, "voucherId">[] = [];

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

    const hasParentFreight = resolvedFreightPaidBy === "parent" && resolvedFreightParentAccountId && poFreight.gt(0);
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
        supplierId: supplierId,
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
          totalAmount: intercoParentTotal.toFixed(2),
          optional: false,
          sourceModule: "ERP",
          currency: "USD",
        },
        postingSource,
        {
          childCompanyId: currentCompanyId,
          poNumber,
          containerNumber: containerNumber,
          supplierId: supplierId,
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

  return {
    poNumber,
    poItems,
    poItemsTotal,
    poFreight,
    poSurcharge,
    poFumigation,
    poDocumentCharges,
    poDiscount,
    poOtherCharges,
    poGrandTotal,
    poIntercoTotal,
    localEntries,
    createParentIntercompanyPosting,
  };
}

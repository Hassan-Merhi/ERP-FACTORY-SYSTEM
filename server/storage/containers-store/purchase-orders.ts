import {
  deleteInfrastructurePostingIdentityForVoucher,
  infrastructurePostingIdentity,
  insertInfrastructureVoucher,
} from "../../services/accounting/infrastructureVoucherIdentity";
import { resolvePoImportCreditTarget } from "../../services/accounting/poImportAccounting";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db } from "../../db";
import * as schema from "@shared/schema";
import type { PurchaseOrder, InsertPurchaseOrder } from "@shared/schema";
import { getConfiguredIntercompanyCreditAccount } from "../accounting/intercompany";

export async function createPurchaseOrder(
  po: InsertPurchaseOrder,
  voucherDateOverride?: string
): Promise<PurchaseOrder> {
  const [created] = await db.insert(schema.purchaseOrders).values(po).returning();

  if (po.voucherId) {
    return created;
  }

  const poItemsTotal = parseFloat(po.itemsTotal || "0");
  const poFreight = parseFloat(po.freight || "0");
  const poSurcharge = parseFloat(po.surcharge || "0");
  const poFumigation = parseFloat(po.fumigation || "0");
  const poDocumentCharges = parseFloat(po.documentCharges || "0");
  const poDiscount = parseFloat(po.discount || "0");
  const poOtherCharges = parseFloat(po.otherCharges || "0");
  const poChargesAmount = poFreight + poSurcharge + poFumigation + poDocumentCharges - poDiscount + poOtherCharges;
  const poTotal = poItemsTotal + poChargesAmount;

  if (poTotal > 0 && po.companyId) {
    let containerNum = "";
    let supplierDisplayName = "";
    if (po.containerId) {
      const [cont] = await db
        .select({ containerNumber: schema.containers.containerNumber })
        .from(schema.containers)
        .where(eq(schema.containers.id, po.containerId))
        .limit(1);
      containerNum = cont?.containerNumber || "";
    }
    if (po.supplierId) {
      const [sup] = await db
        .select({ legalName: schema.suppliers.legalName })
        .from(schema.suppliers)
        .where(eq(schema.suppliers.id, po.supplierId))
        .limit(1);
      supplierDisplayName = sup?.legalName || "";
    }
    const descBase =
      containerNum || supplierDisplayName ? [containerNum, supplierDisplayName].filter(Boolean).join(" ") : "";

    // Intercompany PO accounting is controlled only by the current company's
    // explicit companies.parent_company_id link. The legacy global
    // parentCompanyId setting must never turn an unrelated standalone company
    // into a subsidiary.
    const allCompanies = await db.select().from(schema.companies);
    const currentCompany = allCompanies.find((c) => c.id === po.companyId);
    const explicitParentCompanyId = currentCompany?.parentCompanyId ?? null;
    const parentCompany = explicitParentCompanyId ? allCompanies.find((c) => c.id === explicitParentCompanyId) : null;

    let purchasesAccount = await db
      .select()
      .from(schema.ledgerAccounts)
      .where(
        and(
          eq(schema.ledgerAccounts.companyId, po.companyId),
          eq(schema.ledgerAccounts.code, "PURCHASES"),
          isNull(schema.ledgerAccounts.deletedAt)
        )
      )
      .limit(1);

    if (!purchasesAccount.length) {
      const [newAccount] = await db
        .insert(schema.ledgerAccounts)
        .values({
          companyId: po.companyId,
          code: "PURCHASES",
          name: "Purchases",
          accountType: "Expense",
          openingBalance: "0",
          openingBalanceSide: "Dr",
        })
        .returning();
      purchasesAccount = [newAccount];
    }

    const voucherDate = voucherDateOverride || new Date().toISOString().split("T")[0];

    // supplier_partner companies own their supplier relationships directly —
    // they must NOT go through the intercompany branch; the supplier credit
    // must live inside the SP company so its ledger/stats show the balance.
    const isSupplierPartner = currentCompany?.companyType === "supplier_partner";
    const configuredIntercompanyCreditAccount = !isSupplierPartner
      ? await getConfiguredIntercompanyCreditAccount(po.companyId)
      : undefined;
    const configuredIntercompanyCreditAccountId = configuredIntercompanyCreditAccount?.id ?? null;
    if (parentCompany && po.companyId !== parentCompany.id && !isSupplierPartner) {
      const isParentFreight = po.freightPaidBy === "parent" && poFreight > 0;
      const poIntercoTotal = isParentFreight ? poTotal - poFreight : poTotal;
      const freightParentAcctId: number | null = isParentFreight ? (po.freightParentAccountId ?? null) : null;

      const parentCreditCode = parentCompany.name.toUpperCase().replace(/\s+/g, "_") + "_CREDIT";
      const parentCreditName = parentCompany.name + " Credit";

      let parentCreditAccount = configuredIntercompanyCreditAccount
        ? [configuredIntercompanyCreditAccount]
        : await db
            .select()
            .from(schema.ledgerAccounts)
            .where(
              and(
                eq(schema.ledgerAccounts.companyId, po.companyId),
                eq(schema.ledgerAccounts.code, parentCreditCode),
                isNull(schema.ledgerAccounts.deletedAt)
              )
            )
            .limit(1);

      if (!parentCreditAccount.length) {
        const [newAccount] = await db
          .insert(schema.ledgerAccounts)
          .values({
            companyId: po.companyId,
            code: parentCreditCode,
            name: parentCreditName,
            accountType: "Liability",
            subType: "Current Liability",
            openingBalance: "0",
            openingBalanceSide: "Cr",
          })
          .returning();
        parentCreditAccount = [newAccount];
      }

      const subsidiaryVoucherNumber = `PURCH-${created.poNumber}-${Date.now()}`;
      const { voucher: subsidiaryVoucher } = await insertInfrastructureVoucher(
        db,
        {
          companyId: po.companyId,
          voucherNumber: subsidiaryVoucherNumber,
          voucherType: "Purchase",
          voucherDate,
          description: descBase || `Purchase for PO ${created.poNumber} (${parentCompany.name} paid supplier)`,
          totalAmount: poTotal.toFixed(2),
          optional: false,
        },
        infrastructurePostingIdentity(
          "purchase-order",
          String(po.companyId) + ":" + String(created.poNumber),
          "purchase"
        ),
        po
      );

      await db.insert(schema.voucherEntries).values({
        voucherId: subsidiaryVoucher.id,
        ledgerAccountId: purchasesAccount[0].id,
        debitAmount: poIntercoTotal.toFixed(2),
        creditAmount: "0",
        narration: `PO ${created.poNumber} - Purchases`,
      });

      if (isParentFreight) {
        await db.insert(schema.voucherEntries).values({
          voucherId: subsidiaryVoucher.id,
          ledgerAccountId: purchasesAccount[0].id,
          debitAmount: poFreight.toFixed(2),
          creditAmount: "0",
          narration: `PO ${created.poNumber} - Freight (paid by ${parentCompany.name})`,
        });
      }

      await db.insert(schema.voucherEntries).values({
        voucherId: subsidiaryVoucher.id,
        ledgerAccountId: parentCreditAccount[0].id,
        debitAmount: "0",
        creditAmount: poTotal.toFixed(2),
        narration: `PO ${created.poNumber} - ${parentCompany.name} paid supplier`,
      });

      await db
        .update(schema.purchaseOrders)
        .set({ voucherId: subsidiaryVoucher.id })
        .where(eq(schema.purchaseOrders.id, created.id));

      const subsidiaryCode =
        currentCompany?.name?.toUpperCase().replace(/\s+/g, "_") + "_CREDIT" || "SUBSIDIARY_CREDIT";
      const subsidiaryName = (currentCompany?.name || "Subsidiary") + " Credit";

      let subsidiaryReceivableAccount = await db
        .select()
        .from(schema.ledgerAccounts)
        .where(
          and(
            eq(schema.ledgerAccounts.companyId, parentCompany.id),
            eq(schema.ledgerAccounts.code, subsidiaryCode),
            isNull(schema.ledgerAccounts.deletedAt)
          )
        )
        .limit(1);

      if (!subsidiaryReceivableAccount.length) {
        const [newAccount] = await db
          .insert(schema.ledgerAccounts)
          .values({
            companyId: parentCompany.id,
            code: subsidiaryCode,
            name: subsidiaryName,
            accountType: "Asset",
            subType: "Current Asset",
            openingBalance: "0",
            openingBalanceSide: "Dr",
          })
          .returning();
        subsidiaryReceivableAccount = [newAccount];
      }

      const parentVoucherNumber = `INTERCO-PARENT-${created.poNumber}-${Date.now()}`;
      const { voucher: parentVoucher } = await insertInfrastructureVoucher(
        db,
        {
          companyId: parentCompany.id,
          voucherNumber: parentVoucherNumber,
          voucherType: "Journal",
          voucherDate,
          description: descBase
            ? `${descBase} - ${currentCompany?.name || "Subsidiary"}`
            : `Inter-company PO ${created.poNumber} - ${currentCompany?.name || "Subsidiary"}`,
          totalAmount: poTotal.toFixed(2),
          optional: false,
        },
        infrastructurePostingIdentity(
          "purchase-order",
          String(po.companyId) + ":" + String(created.poNumber),
          "purchase"
        ),
        po
      );

      const intercoNarration = containerNum
        ? `${currentCompany?.name || "Subsidiary"} PO ${created.poNumber} - Container ${containerNum}`
        : `PO ${created.poNumber} - ${currentCompany?.name || "Subsidiary"} owes us`;

      await db.insert(schema.voucherEntries).values({
        voucherId: parentVoucher.id,
        ledgerAccountId: subsidiaryReceivableAccount[0].id,
        debitAmount: poTotal.toFixed(2),
        creditAmount: "0",
        narration: intercoNarration,
      });

      if (po.supplierId) {
        await db.insert(schema.voucherEntries).values({
          voucherId: parentVoucher.id,
          supplierId: po.supplierId,
          debitAmount: "0",
          creditAmount: poIntercoTotal.toFixed(2),
          narration: intercoNarration,
        });
      }

      if (isParentFreight && freightParentAcctId) {
        await db.insert(schema.voucherEntries).values({
          voucherId: parentVoucher.id,
          ledgerAccountId: freightParentAcctId,
          debitAmount: "0",
          creditAmount: poFreight.toFixed(2),
          narration: containerNum
            ? `Freight - ${currentCompany?.name || "Subsidiary"} PO ${created.poNumber} - Container ${containerNum}`
            : `Freight - PO ${created.poNumber}`,
        });
      }
    } else {
      const voucherNumber = `PURCH-${created.poNumber}-${Date.now()}`;
      const { voucher: purchaseVoucher } = await insertInfrastructureVoucher(
        db,
        {
          companyId: po.companyId,
          voucherNumber,
          voucherType: "Purchase",
          voucherDate,
          description: descBase || `Purchase for PO ${created.poNumber}`,
          totalAmount: poTotal.toFixed(2),
          optional: false,
        },
        infrastructurePostingIdentity(
          "purchase-order",
          String(po.companyId) + ":" + String(created.poNumber),
          "purchase"
        ),
        po
      );

      await db.insert(schema.voucherEntries).values({
        voucherId: purchaseVoucher.id,
        ledgerAccountId: purchasesAccount[0].id,
        debitAmount: poTotal.toFixed(2),
        creditAmount: "0",
        narration: `PO ${created.poNumber} - Purchases`,
      });

      const creditTarget = resolvePoImportCreditTarget({
        companyType: currentCompany?.companyType,
        hasExplicitParentLink: Boolean(parentCompany),
        configuredIntercompanyCreditAccountId,
        supplierId: po.supplierId,
      });
      if (creditTarget.kind === "intercompany") {
        await db.insert(schema.voucherEntries).values({
          voucherId: purchaseVoucher.id,
          ledgerAccountId: creditTarget.ledgerAccountId,
          debitAmount: "0",
          creditAmount: poTotal.toFixed(2),
          narration: `PO ${created.poNumber} - Intercompany credit`,
        });
      } else if (creditTarget.supplierId) {
        await db.insert(schema.voucherEntries).values({
          voucherId: purchaseVoucher.id,
          supplierId: creditTarget.supplierId,
          debitAmount: "0",
          creditAmount: poTotal.toFixed(2),
          narration: `PO ${created.poNumber} - Supplier`,
        });
      }

      await db
        .update(schema.purchaseOrders)
        .set({ voucherId: purchaseVoucher.id })
        .where(eq(schema.purchaseOrders.id, created.id));
    }
  }

  return created;
}

export async function updatePurchaseOrder(id: number, updates: Partial<InsertPurchaseOrder>): Promise<PurchaseOrder> {
  const [updated] = await db
    .update(schema.purchaseOrders)
    .set(updates)
    .where(eq(schema.purchaseOrders.id, id))
    .returning();
  return updated;
}

export async function deletePurchaseOrder(id: number): Promise<void> {
  const [po] = await db.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id)).limit(1);
  if (!po) throw new Error("Purchase order not found");

  const containerId = po.containerId;
  const poItemsTotal = parseFloat(po.itemsTotal || "0");
  const poFreight = parseFloat(po.freight || "0");
  const poSurcharge = parseFloat(po.surcharge || "0");
  const poFumigation = parseFloat(po.fumigation || "0");
  const poDocumentCharges = parseFloat(po.documentCharges || "0");
  const poDiscount = parseFloat(po.discount || "0");
  const poOtherCharges = parseFloat(po.otherCharges || "0");
  const poCharges = poFreight + poSurcharge + poFumigation + poDocumentCharges - poDiscount + poOtherCharges;

  const [container] = await db.select().from(schema.containers).where(eq(schema.containers.id, containerId)).limit(1);

  await db.delete(schema.poLineItems).where(eq(schema.poLineItems.poId, id));
  await db.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id));

  if (po.voucherId) {
    try {
      await deleteInfrastructurePostingIdentityForVoucher(db, po.voucherId);
      await db.delete(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, po.voucherId));
      await db.delete(schema.vouchers).where(eq(schema.vouchers.id, po.voucherId));
    } catch (_hardDeleteErr) {
      try {
        await db
          .update(schema.vouchers)
          .set({ deletedAt: new Date() })
          .where(and(eq(schema.vouchers.id, po.voucherId), isNull(schema.vouchers.deletedAt)));
      } catch (_softDeleteErr) {
        // Already gone or soft-deleted
      }
    }
  }

  const remainingPOs = await db
    .select()
    .from(schema.purchaseOrders)
    .where(eq(schema.purchaseOrders.containerId, containerId))
    .limit(1);

  if (remainingPOs.length === 0 && container) {
    const chargeVouchers = await db
      .select()
      .from(schema.vouchers)
      .where(
        and(
          eq(schema.vouchers.companyId, po.companyId),
          sql`${schema.vouchers.description} LIKE ${"% - Container " + container.containerNumber}`
        )
      );
    for (const chargeVoucher of chargeVouchers) {
      await db.delete(schema.voucherEntries).where(eq(schema.voucherEntries.voucherId, chargeVoucher.id));
      await db.delete(schema.vouchers).where(eq(schema.vouchers.id, chargeVoucher.id));
    }
    await db.delete(schema.containerCharges).where(eq(schema.containerCharges.containerId, containerId));
    await db.delete(schema.importLogs).where(eq(schema.importLogs.containerId, containerId));
    await db.delete(schema.containers).where(eq(schema.containers.id, containerId));
  } else if (container) {
    const newItemsTotal = Math.max(0, parseFloat(container.itemsTotal || "0") - poItemsTotal);
    const newChargesTotal = Math.max(0, parseFloat(container.chargesTotal || "0") - poCharges);
    const newGrandTotal = newItemsTotal + newChargesTotal;
    await db
      .update(schema.containers)
      .set({
        itemsTotal: newItemsTotal.toString(),
        chargesTotal: newChargesTotal.toString(),
        grandTotal: newGrandTotal.toString(),
      })
      .where(eq(schema.containers.id, containerId));
  }
}

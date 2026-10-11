import { postFactoryPartyLineVoucherTx, postFactoryVoucherTx } from "../../services/factory/factoryVoucherPosting";
import { retireVouchersTx, type VoucherRetirementActor } from "../../services/accounting/voucherRetirement";
import { resolvePoImportCreditTarget } from "../../services/accounting/poImportAccounting";
import { eq, and, isNull, sql } from "drizzle-orm";
import { db, type DbTransaction } from "../../db";
import * as schema from "@shared/schema";
import type { PurchaseOrder, InsertPurchaseOrder } from "@shared/schema";
import { getConfiguredIntercompanyCreditAccount } from "../accounting/intercompany";
import { MoneyDecimal, sumMoney, toMoney } from "../../lib/money";
import {
  removePurchaseOrderGitTx,
  syncPurchaseOrderGitTx,
} from "../../services/accounting/perpetualInventory/stockReceipts";

type PoChargeFields = Pick<
  PurchaseOrder,
  "freight" | "surcharge" | "fumigation" | "documentCharges" | "discount" | "otherCharges"
>;

/** A PO's charges net of its discount, exactly. */
const poChargesOf = (po: PoChargeFields) =>
  sumMoney([po.freight, po.surcharge, po.fumigation, po.documentCharges, po.otherCharges]).minus(toMoney(po.discount));

export async function createPurchaseOrder(
  po: InsertPurchaseOrder,
  voucherDateOverride?: string
): Promise<PurchaseOrder> {
  // The PO, its voucher(s), their lines and the PO's voucher link commit
  // together; they used to be separate autocommit writes.
  return db.transaction(async (tx) => {
    const [created] = await tx.insert(schema.purchaseOrders).values(po).returning();

    if (po.voucherId) {
      // Perpetual inventory (wave 8.2): the PO's cost moves to goods in transit.
      if (created.companyId) await syncPurchaseOrderGitTx(tx, created.companyId, created.id);
      return created;
    }

    // The voucher is built from the row as stored (numeric(20, 2) columns), so it
    // agrees with the PO to the cent whatever precision the input carried.
    const poFreight = toMoney(created.freight);
    const poTotal = toMoney(created.itemsTotal).plus(poChargesOf(created));

    if (poTotal.gt(0) && po.companyId) {
      let containerNum = "";
      let supplierDisplayName = "";
      if (po.containerId) {
        const [cont] = await tx
          .select({ containerNumber: schema.containers.containerNumber })
          .from(schema.containers)
          .where(eq(schema.containers.id, po.containerId))
          .limit(1);
        containerNum = cont?.containerNumber || "";
      }
      if (po.supplierId) {
        const [sup] = await tx
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
      const allCompanies = await tx.select().from(schema.companies);
      const currentCompany = allCompanies.find((c) => c.id === po.companyId);
      const explicitParentCompanyId = currentCompany?.parentCompanyId ?? null;
      const parentCompany = explicitParentCompanyId ? allCompanies.find((c) => c.id === explicitParentCompanyId) : null;

      let purchasesAccount = await tx
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
        const [newAccount] = await tx
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
        const isParentFreight = po.freightPaidBy === "parent" && poFreight.gt(0);
        const poIntercoTotal = isParentFreight ? poTotal.minus(poFreight) : poTotal;
        const freightParentAcctId: number | null = isParentFreight ? (po.freightParentAccountId ?? null) : null;

        const parentCreditCode = parentCompany.name.toUpperCase().replace(/\s+/g, "_") + "_CREDIT";
        const parentCreditName = parentCompany.name + " Credit";

        let parentCreditAccount = configuredIntercompanyCreditAccount
          ? [configuredIntercompanyCreditAccount]
          : await tx
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
          const [newAccount] = await tx
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

        // Phase 22 (C): through the engine, engine-numbered (the PURCH- number
        // carried a timestamp and is read nowhere), same posting identity.
        const { voucher: subsidiaryVoucher } = await postFactoryVoucherTx(tx, {
          companyId: po.companyId,
          voucherType: "Purchase",
          voucherDate,
          description: descBase || `Purchase for PO ${created.poNumber} (${parentCompany.name} paid supplier)`,
          sourceModule: "ERP",
          source: { sourceType: "purchase-order", sourceId: `${po.companyId}:${created.poNumber}`, phase: "purchase" },
          lines: [
            {
              ledgerAccountId: purchasesAccount[0].id,
              debit: poIntercoTotal.toFixed(2),
              narration: `PO ${created.poNumber} - Purchases`,
            },
            ...(isParentFreight
              ? [
                  {
                    ledgerAccountId: purchasesAccount[0].id,
                    debit: poFreight.toFixed(2),
                    narration: `PO ${created.poNumber} - Freight (paid by ${parentCompany.name})`,
                  },
                ]
              : []),
            {
              ledgerAccountId: parentCreditAccount[0].id,
              credit: poTotal.toFixed(2),
              narration: `PO ${created.poNumber} - ${parentCompany.name} paid supplier`,
            },
          ],
        });

        await tx
          .update(schema.purchaseOrders)
          .set({ voucherId: subsidiaryVoucher.id })
          .where(eq(schema.purchaseOrders.id, created.id));

        const subsidiaryCode =
          currentCompany?.name?.toUpperCase().replace(/\s+/g, "_") + "_CREDIT" || "SUBSIDIARY_CREDIT";
        const subsidiaryName = (currentCompany?.name || "Subsidiary") + " Credit";

        let subsidiaryReceivableAccount = await tx
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
          const [newAccount] = await tx
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

        const intercoNarration = containerNum
          ? `${currentCompany?.name || "Subsidiary"} PO ${created.poNumber} - Container ${containerNum}`
          : `PO ${created.poNumber} - ${currentCompany?.name || "Subsidiary"} owes us`;
        // INTERCO-PARENT-{po}- is read as identity (containerHelpers sync), so
        // the family number is kept with the PO id as its suffix (was Date.now()).
        // The parent's voucher credits the subsidiary's supplier (a party of the
        // other company); the engine refuses a target another company owns, so
        // it goes through the party-line writer (identity, Decimal, exact
        // balance) until the parent-supplier model (G17: due-to/due-from
        // accounts) is decided.
        await postFactoryPartyLineVoucherTx(tx, {
          companyId: parentCompany.id,
          voucherNumber: `INTERCO-PARENT-${created.poNumber}-${created.id}`,
          voucherDate,
          description: descBase
            ? `${descBase} - ${currentCompany?.name || "Subsidiary"}`
            : `Inter-company PO ${created.poNumber} - ${currentCompany?.name || "Subsidiary"}`,
          sourceModule: "ERP",
          source: { sourceType: "purchase-order", sourceId: `${po.companyId}:${created.poNumber}`, phase: "purchase" },
          lines: [
            {
              ledgerAccountId: subsidiaryReceivableAccount[0].id,
              debit: poTotal.toFixed(2),
              narration: intercoNarration,
            },
            ...(po.supplierId
              ? [{ supplierId: po.supplierId, credit: poIntercoTotal.toFixed(2), narration: intercoNarration }]
              : []),
            ...(isParentFreight && freightParentAcctId
              ? [
                  {
                    ledgerAccountId: freightParentAcctId,
                    credit: poFreight.toFixed(2),
                    narration: containerNum
                      ? `Freight - ${currentCompany?.name || "Subsidiary"} PO ${created.poNumber} - Container ${containerNum}`
                      : `Freight - PO ${created.poNumber}`,
                  },
                ]
              : []),
          ],
        });
      } else {
        const creditTarget = resolvePoImportCreditTarget({
          companyType: currentCompany?.companyType,
          hasExplicitParentLink: Boolean(parentCompany),
          configuredIntercompanyCreditAccountId,
          supplierId: po.supplierId,
        });
        const { voucher: purchaseVoucher } = await postFactoryVoucherTx(tx, {
          companyId: po.companyId,
          voucherType: "Purchase",
          voucherDate,
          description: descBase || `Purchase for PO ${created.poNumber}`,
          sourceModule: "ERP",
          source: { sourceType: "purchase-order", sourceId: `${po.companyId}:${created.poNumber}`, phase: "purchase" },
          lines: [
            {
              ledgerAccountId: purchasesAccount[0].id,
              debit: poTotal.toFixed(2),
              narration: `PO ${created.poNumber} - Purchases`,
            },
            ...(creditTarget.kind === "intercompany"
              ? [
                  {
                    ledgerAccountId: creditTarget.ledgerAccountId,
                    credit: poTotal.toFixed(2),
                    narration: `PO ${created.poNumber} - Intercompany credit`,
                  },
                ]
              : creditTarget.supplierId
                ? [
                    {
                      supplierId: creditTarget.supplierId,
                      credit: poTotal.toFixed(2),
                      narration: `PO ${created.poNumber} - Supplier`,
                    },
                  ]
                : []),
          ],
        });

        await tx
          .update(schema.purchaseOrders)
          .set({ voucherId: purchaseVoucher.id })
          .where(eq(schema.purchaseOrders.id, created.id));
      }
    }

    if (created.companyId) await syncPurchaseOrderGitTx(tx, created.companyId, created.id);
    return created;
  });
}

export async function updatePurchaseOrder(id: number, updates: Partial<InsertPurchaseOrder>): Promise<PurchaseOrder> {
  const [updated] = await db
    .update(schema.purchaseOrders)
    .set(updates)
    .where(eq(schema.purchaseOrders.id, id))
    .returning();
  return updated;
}

/**
 * Deletes a PO (and its container when it was the last PO) in one transaction.
 * Wave 16 (A): the PO voucher and the container's charge vouchers are retired
 * (soft delete with their lines, audited in this transaction, number and
 * posting identity released), not hard-deleted.
 */
export async function deletePurchaseOrder(
  id: number,
  actor?: VoucherRetirementActor | null,
  // Phase 21 (B): the caller's delete audit, written on this transaction.
  auditTx?: (tx: DbTransaction, po: schema.PurchaseOrder) => Promise<void>
): Promise<void> {
  await db.transaction(async (tx) => {
    const [po] = await tx.select().from(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id)).limit(1);
    if (!po) throw new Error("Purchase order not found");

    const containerId = po.containerId;
    const poItemsTotal = toMoney(po.itemsTotal);
    const poCharges = poChargesOf(po);

    const [container] = await tx.select().from(schema.containers).where(eq(schema.containers.id, containerId)).limit(1);

    // Perpetual inventory (wave 8.2): a deleted PO takes its goods-in-transit journal with it.
    if (po.companyId) await removePurchaseOrderGitTx(tx, po.companyId, id);
    await tx.delete(schema.poLineItems).where(eq(schema.poLineItems.poId, id));
    await tx.delete(schema.purchaseOrders).where(eq(schema.purchaseOrders.id, id));

    if (po.voucherId) {
      await retireVouchersTx(tx, {
        companyId: po.companyId,
        voucherIds: [po.voucherId],
        reason: "purchase-order-delete",
        actor,
      });
    }

    const remainingPOs = await tx
      .select()
      .from(schema.purchaseOrders)
      .where(eq(schema.purchaseOrders.containerId, containerId))
      .limit(1);

    if (remainingPOs.length === 0 && container) {
      const chargeVouchers = await tx
        .select({ id: schema.vouchers.id })
        .from(schema.vouchers)
        .where(
          and(
            eq(schema.vouchers.companyId, po.companyId),
            sql`${schema.vouchers.description} LIKE ${"% - Container " + container.containerNumber}`
          )
        );
      await retireVouchersTx(tx, {
        companyId: po.companyId,
        voucherIds: chargeVouchers.map((voucher) => voucher.id),
        reason: "container-charge-voucher-removed-with-po",
        actor,
      });
      await tx.delete(schema.containerCharges).where(eq(schema.containerCharges.containerId, containerId));
      await tx.delete(schema.importLogs).where(eq(schema.importLogs.containerId, containerId));
      await tx.delete(schema.containers).where(eq(schema.containers.id, containerId));
    } else if (container) {
      const newItemsTotal = MoneyDecimal.max(0, toMoney(container.itemsTotal).minus(poItemsTotal));
      const newChargesTotal = MoneyDecimal.max(0, toMoney(container.chargesTotal).minus(poCharges));
      const newGrandTotal = newItemsTotal.plus(newChargesTotal);
      await tx
        .update(schema.containers)
        .set({
          itemsTotal: newItemsTotal.toFixed(2),
          chargesTotal: newChargesTotal.toFixed(2),
          grandTotal: newGrandTotal.toFixed(2),
        })
        .where(eq(schema.containers.id, containerId));
    }
    if (auditTx) await auditTx(tx, po);
  });
}

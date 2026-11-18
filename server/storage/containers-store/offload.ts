import { postFactoryVoucherTx } from "../../services/factory/factoryVoucherPosting";
import { createDatabaseStockMovementAdapter } from "../../services/inventory/databaseStockMovementAdapter";
import { postStockMovementTx } from "../../services/inventory/stockMovementIntegrityService";
import { eq, and, isNull } from "drizzle-orm";
import { inventoryMoney, inventoryQuantity, inventoryUnitCost, toInventoryDecimal } from "../../lib/inventoryMath";
import { db } from "../../db";
import * as schema from "@shared/schema";
import type { ContainerOffload } from "@shared/schema";
import { offloadStep } from "./offloadStep";
import { offloadStep2 } from "./offloadStep2";

const canonicalStockMovementAdapter = createDatabaseStockMovementAdapter();

export async function offloadContainer(
  containerId: number,
  locationId: number,
  duties: string,
  dutiesAccountId: number | null | undefined,
  officeCharges: string,
  officeChargesAccountId: number | null | undefined,
  officeChargesCashAccountId: number | null | undefined,
  transferCharges: string,
  transportFees: string,
  transportAccountId: number | null | undefined,
  additionalCharges: Array<{ description: string; amount: number; ledgerAccountId: number }> = [],
  offloadDate?: string,
  inventoryCostCorrections: Array<{ stockItemId: number; correctRate: number }> = []
): Promise<ContainerOffload> {
  const off1 = await offloadStep({
    containerId,
    additionalCharges,
    duties,
    officeCharges,
    transferCharges,
    transportFees,
  });
  const { container, totalCharges, totalBales, additionalCostPerBale, offloadItemsToStore } = off1;

  const offload = await db.transaction(async (tx) => {
    const off2 = await offloadStep2({
      off1,
      inventoryCostCorrections,
      tx,
      locationId,
      offloadDate,
      duties,
      containerId,
      dutiesAccountId,
    });
    const { location, voucherDate, findOrCreateExpenseAccount, importChargesParentId } = off2;

    if (officeChargesAccountId && officeChargesCashAccountId && toInventoryDecimal(officeCharges).isPositive()) {
      const [officeChargesAccount] = await tx
        .select({ accountType: schema.ledgerAccounts.accountType, name: schema.ledgerAccounts.name })
        .from(schema.ledgerAccounts)
        .where(and(eq(schema.ledgerAccounts.id, officeChargesAccountId), isNull(schema.ledgerAccounts.deletedAt)))
        .limit(1);
      const invalidTypes = [
        "Expense",
        "Direct Expense",
        "Indirect Expense",
        "Income",
        "Liability",
        "Current Liability",
        "Profit",
        "Government Taxes",
        "COGS",
      ];
      if (!officeChargesAccount || invalidTypes.includes(officeChargesAccount.accountType)) {
        throw new Error(
          `Office charges account "${officeChargesAccount?.name || `ID ${officeChargesAccountId}`}" has type "${officeChargesAccount?.accountType ?? "deleted/not found"}" which is invalid. It must be an Asset-type account.`
        );
      }
      const amount = inventoryMoney(officeCharges);
      await postFactoryVoucherTx(tx, {
        companyId: location.companyId,
        voucherNumber: `OFFICE-${container.containerNumber}-${containerId}`,
        voucherType: "Payment",
        voucherDate,
        description: `Office charges for container ${container.containerNumber}`,
        sourceModule: "ERP",
        source: {
          sourceType: "container-offload",
          sourceId: String(location.companyId) + ":" + String(containerId),
          phase: "office",
        },
        lines: [
          {
            ledgerAccountId: officeChargesAccountId,
            debit: amount,
            narration: `Office charges for container ${container.containerNumber}`,
          },
          {
            ledgerAccountId: officeChargesCashAccountId,
            credit: amount,
            narration: `Office charges for container ${container.containerNumber}`,
          },
        ],
      });
    }

    if (toInventoryDecimal(transportFees).isPositive()) {
      const transportExpenseAccountId = await findOrCreateExpenseAccount(
        "TRANSPORT",
        "Transport Charges",
        importChargesParentId
      );
      const expenseTypes = ["Expense", "Direct Expense", "Indirect Expense"];
      const getTransportPayableAccount = async () => {
        let accounts = await tx
          .select()
          .from(schema.ledgerAccounts)
          .where(
            and(
              eq(schema.ledgerAccounts.companyId, location.companyId),
              eq(schema.ledgerAccounts.code, "TRANSPORT_PAYABLE"),
              isNull(schema.ledgerAccounts.deletedAt)
            )
          )
          .limit(1);
        if (!accounts.length) {
          const [newAccount] = await tx
            .insert(schema.ledgerAccounts)
            .values({
              companyId: location.companyId,
              code: "TRANSPORT_PAYABLE",
              name: "Transport Fees Payable",
              accountType: "Liability",
              subType: "Current Liability",
              openingBalance: "0",
              openingBalanceSide: "Cr",
            })
            .returning();
          accounts = [newAccount];
        }
        return accounts[0].id;
      };

      let creditAccountId = transportAccountId;
      if (transportAccountId) {
        const [selectedAccount] = await tx
          .select()
          .from(schema.ledgerAccounts)
          .where(and(eq(schema.ledgerAccounts.id, transportAccountId), isNull(schema.ledgerAccounts.deletedAt)))
          .limit(1);
        if (!selectedAccount || expenseTypes.includes(selectedAccount.accountType)) {
          creditAccountId = await getTransportPayableAccount();
        }
      } else {
        creditAccountId = await getTransportPayableAccount();
      }
      if (!creditAccountId) creditAccountId = await getTransportPayableAccount();

      const amount = inventoryMoney(transportFees);
      await postFactoryVoucherTx(tx, {
        companyId: location.companyId,
        voucherNumber: `TRANS-${container.containerNumber}-${containerId}`,
        voucherType: "Payment",
        voucherDate,
        description: `Transport fees for container ${container.containerNumber}`,
        sourceModule: "ERP",
        source: {
          sourceType: "container-offload",
          sourceId: String(location.companyId) + ":" + String(containerId),
          phase: "transport",
        },
        lines: [
          {
            ledgerAccountId: transportExpenseAccountId,
            debit: amount,
            narration: `Transport fees for container ${container.containerNumber}`,
          },
          {
            ledgerAccountId: creditAccountId,
            credit: amount,
            narration: `Transport fees for container ${container.containerNumber}`,
          },
        ],
      });
    }

    if (toInventoryDecimal(transferCharges).isPositive()) {
      const transferExpenseAccountId = await findOrCreateExpenseAccount(
        "TRANSFER_CHARGES",
        "Transfer Charges",
        importChargesParentId
      );
      let transferPayableAccounts = await tx
        .select()
        .from(schema.ledgerAccounts)
        .where(
          and(
            eq(schema.ledgerAccounts.companyId, location.companyId),
            eq(schema.ledgerAccounts.code, "TRANSFER_PAYABLE"),
            isNull(schema.ledgerAccounts.deletedAt)
          )
        )
        .limit(1);
      if (!transferPayableAccounts.length) {
        const [newAccount] = await tx
          .insert(schema.ledgerAccounts)
          .values({
            companyId: location.companyId,
            code: "TRANSFER_PAYABLE",
            name: "Transfer Charges Payable",
            accountType: "Liability",
            subType: "Current Liability",
            openingBalance: "0",
            openingBalanceSide: "Cr",
          })
          .returning();
        transferPayableAccounts = [newAccount];
      }
      const amount = inventoryMoney(transferCharges);
      await postFactoryVoucherTx(tx, {
        companyId: location.companyId,
        voucherNumber: `XFER-${container.containerNumber}-${containerId}`,
        voucherType: "Payment",
        voucherDate,
        description: `Transfer charges for container ${container.containerNumber}`,
        sourceModule: "ERP",
        source: {
          sourceType: "container-offload",
          sourceId: String(location.companyId) + ":" + String(containerId),
          phase: "transfer",
        },
        lines: [
          {
            ledgerAccountId: transferExpenseAccountId,
            debit: amount,
            narration: `Transfer charges for container ${container.containerNumber}`,
          },
          {
            ledgerAccountId: transferPayableAccounts[0].id,
            credit: amount,
            narration: `Transfer charges for container ${container.containerNumber}`,
          },
        ],
      });
    }

    for (const [chargeIndex, charge] of additionalCharges.entries()) {
      if (!toInventoryDecimal(charge.amount).isPositive()) continue;
      const [creditAccount] = await tx
        .select({ accountType: schema.ledgerAccounts.accountType, name: schema.ledgerAccounts.name })
        .from(schema.ledgerAccounts)
        .where(and(eq(schema.ledgerAccounts.id, charge.ledgerAccountId), isNull(schema.ledgerAccounts.deletedAt)))
        .limit(1);
      if (!creditAccount) {
        throw new Error(
          `Additional charge "${charge.description}" references a deleted or non-existent ledger account (ID: ${charge.ledgerAccountId}).`
        );
      }
      if (["Direct Expense", "Indirect Expense"].includes(creditAccount.accountType)) {
        throw new Error(
          `Additional charge "${charge.description}" cannot credit the "${creditAccount.name}" account (type: ${creditAccount.accountType}).`
        );
      }
      const expenseAccountId = await findOrCreateExpenseAccount(
        "ADDITIONAL_CHARGES",
        "Additional Container Charges",
        importChargesParentId
      );
      const amount = inventoryMoney(charge.amount);
      await postFactoryVoucherTx(tx, {
        companyId: location.companyId,
        voucherNumber: `CHG-${container.containerNumber}-${containerId}-${chargeIndex}`,
        voucherType: "Payment",
        voucherDate,
        description: `${charge.description} for container ${container.containerNumber}`,
        sourceModule: "ERP",
        source: {
          sourceType: "container-offload",
          sourceId: String(location.companyId) + ":" + String(containerId) + ":" + String(chargeIndex),
          phase: "additional",
        },
        lines: [
          {
            ledgerAccountId: expenseAccountId,
            debit: amount,
            narration: `${charge.description} for container ${container.containerNumber}`,
          },
          {
            ledgerAccountId: charge.ledgerAccountId,
            credit: amount,
            narration: `${charge.description} for container ${container.containerNumber}`,
          },
        ],
      });
    }

    const [offloadRecord] = await tx
      .insert(schema.containerOffloads)
      .values({
        containerId,
        locationId,
        duties: inventoryMoney(duties),
        officeCharges: inventoryMoney(officeCharges),
        transferCharges: inventoryMoney(transferCharges),
        transportFees: inventoryMoney(transportFees),
        totalCharges: inventoryMoney(totalCharges),
        totalBales: inventoryQuantity(totalBales),
        additionalCostPerBale: inventoryUnitCost(additionalCostPerBale),
        offloadedAt: offloadDate ? new Date(offloadDate) : new Date(),
      })
      .returning();

    for (const item of offloadItemsToStore) {
      await tx.insert(schema.containerOffloadItems).values({
        offloadId: offloadRecord.id,
        stockItemId: item.stockItemId,
        quantity: inventoryQuantity(item.quantity),
        rate: inventoryUnitCost(item.rate),
        totalValue: inventoryMoney(item.totalValue),
      });

      if (!item.quantity.isZero()) {
        await postStockMovementTx(
          tx,
          {
            companyId: location.companyId,
            stockItemId: item.stockItemId,
            kind: "receipt",
            quantity: inventoryQuantity(item.quantity.abs()),
            unitCost: inventoryUnitCost(item.rate.abs()),
            toLocationId: locationId,
            occurredAt: offloadRecord.offloadedAt.toISOString(),
            source: {
              sourceType: "legacy-container-offload",
              sourceId: String(offloadRecord.id),
              idempotencyKey: `legacy-container-offload:${offloadRecord.id}:${item.stockItemId}`,
            },
            allowNegativeStock: true,
          },
          canonicalStockMovementAdapter
        );
      }
    }

    return offloadRecord;
  });

  return offload;
}

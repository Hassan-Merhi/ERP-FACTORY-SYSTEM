import type { DbTransaction } from "../../../db";
import { postFactoryVoucherTx } from "../../factory/factoryVoucherPosting";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "@shared/schema";

import { findOrCreateImportChargeAccounts } from "./charge-accounts";
import { isPerpetualInventoryActive } from "../../accounting/perpetualInventory/cutover";
import { ContainerOffloadLifecycleError, ContainerOffloadLifecycleInput, amount } from "./types";

export async function postChargeVouchers(
  tx: DbTransaction,
  container: typeof schema.containers.$inferSelect,
  companyId: number,
  input: ContainerOffloadLifecycleInput
): Promise<void> {
  const accounts = await findOrCreateImportChargeAccounts(tx, companyId);
  const voucherDate = input.offloadDate;
  // Phase 29 (I4): under perpetual inventory a landed charge entered with no
  // paying account is still journalled, as an accrued charge (Dr the charge /
  // Cr a charges payable), so the offload's STOCK-IN journal capitalises it by
  // crediting the charge's own account. Before, such a charge (duties with no
  // account, office charges with no accounts) had no voucher: its cost was in
  // the stock sub-ledger and STOCK-IN put it against Purchases. Before the
  // cut-over nothing changes (periodic books; no STOCK-IN exists then).
  const accrueUnpaid = await isPerpetualInventoryActive(tx, companyId, voucherDate);

  if (input.dutiesAccountId && amount(input.duties).greaterThan(0)) {
    const expenseId = await accounts.expense("DUTIES", "Duties");
    await postFactoryVoucherTx(tx, {
      companyId,
      voucherNumber: `DUTY-${container.containerNumber}-${container.id}`,
      voucherType: "Payment",
      voucherDate,
      description: `Duties for container ${container.containerNumber}`,
      sourceModule: "ERP",
      source: { sourceType: "container-offload-charge", sourceId: `${companyId}:${container.id}`, phase: "duties" },
      lines: [
        {
          ledgerAccountId: expenseId,
          debit: input.duties,
          narration: `Duties for container ${container.containerNumber}`,
        },
        {
          ledgerAccountId: input.dutiesAccountId,
          credit: input.duties,
          narration: `Duties for container ${container.containerNumber}`,
        },
      ],
    });
  }

  if (accrueUnpaid && !input.dutiesAccountId && amount(input.duties).greaterThan(0)) {
    const expenseId = await accounts.expense("DUTIES", "Duties");
    const payableId = await accounts.payable("DUTIES_PAYABLE", "Duties Payable");
    await postFactoryVoucherTx(tx, {
      companyId,
      voucherNumber: `DUTY-${container.containerNumber}-${container.id}`,
      voucherType: "Journal",
      voucherDate,
      description: `Duties for container ${container.containerNumber} (accrued)`,
      sourceModule: "ERP",
      source: { sourceType: "container-offload-charge", sourceId: `${companyId}:${container.id}`, phase: "duties" },
      lines: [
        {
          ledgerAccountId: expenseId,
          debit: input.duties,
          narration: `Duties for container ${container.containerNumber}`,
        },
        {
          ledgerAccountId: payableId,
          credit: input.duties,
          narration: `Duties payable for container ${container.containerNumber}`,
        },
      ],
    });
  }

  if (
    accrueUnpaid &&
    !(input.officeChargesAccountId && input.officeChargesCashAccountId) &&
    amount(input.officeCharges).greaterThan(0)
  ) {
    const expenseId = await accounts.expense("OFFICE_CHARGES", "Office Charges");
    const payableId = await accounts.payable("OFFICE_CHARGES_PAYABLE", "Office Charges Payable");
    await postFactoryVoucherTx(tx, {
      companyId,
      voucherNumber: `OFFICE-${container.containerNumber}-${container.id}`,
      voucherType: "Journal",
      voucherDate,
      description: `Office charges for container ${container.containerNumber} (accrued)`,
      sourceModule: "ERP",
      source: { sourceType: "container-offload-charge", sourceId: `${companyId}:${container.id}`, phase: "office" },
      lines: [
        {
          ledgerAccountId: expenseId,
          debit: input.officeCharges,
          narration: `Office charges for container ${container.containerNumber}`,
        },
        {
          ledgerAccountId: payableId,
          credit: input.officeCharges,
          narration: `Office charges payable for container ${container.containerNumber}`,
        },
      ],
    });
  }

  if (input.officeChargesAccountId && input.officeChargesCashAccountId && amount(input.officeCharges).greaterThan(0)) {
    const [officeAccount] = await tx
      .select({ accountType: schema.ledgerAccounts.accountType, name: schema.ledgerAccounts.name })
      .from(schema.ledgerAccounts)
      .where(
        and(
          eq(schema.ledgerAccounts.id, input.officeChargesAccountId),
          eq(schema.ledgerAccounts.companyId, companyId),
          isNull(schema.ledgerAccounts.deletedAt)
        )
      )
      .limit(1);
    const invalidTypes = new Set([
      "Expense",
      "Direct Expense",
      "Indirect Expense",
      "Income",
      "Liability",
      "Current Liability",
      "Profit",
      "Government Taxes",
      "COGS",
    ]);
    if (!officeAccount || invalidTypes.has(officeAccount.accountType)) {
      throw new ContainerOffloadLifecycleError(
        `Office charges account "${officeAccount?.name ?? `ID ${input.officeChargesAccountId}`}" must be an Asset-type account.`,
        400,
        "CONTAINER_OFFLOAD_OFFICE_ACCOUNT_INVALID"
      );
    }
    await postFactoryVoucherTx(tx, {
      companyId,
      voucherNumber: `OFFICE-${container.containerNumber}-${container.id}`,
      voucherType: "Payment",
      voucherDate,
      description: `Office charges for container ${container.containerNumber}`,
      sourceModule: "ERP",
      source: { sourceType: "container-offload-charge", sourceId: `${companyId}:${container.id}`, phase: "office" },
      lines: [
        {
          ledgerAccountId: input.officeChargesAccountId,
          debit: input.officeCharges,
          narration: `Office charges for container ${container.containerNumber}`,
        },
        {
          ledgerAccountId: input.officeChargesCashAccountId,
          credit: input.officeCharges,
          narration: `Office charges for container ${container.containerNumber}`,
        },
      ],
    });
  }

  if (amount(input.transportFees).greaterThan(0)) {
    const expenseId = await accounts.expense("TRANSPORT", "Transport Charges");
    let creditAccountId = input.transportAccountId ?? null;
    if (creditAccountId) {
      const [selected] = await tx
        .select({ accountType: schema.ledgerAccounts.accountType })
        .from(schema.ledgerAccounts)
        .where(
          and(
            eq(schema.ledgerAccounts.id, creditAccountId),
            eq(schema.ledgerAccounts.companyId, companyId),
            isNull(schema.ledgerAccounts.deletedAt)
          )
        )
        .limit(1);
      if (!selected || ["Expense", "Direct Expense", "Indirect Expense"].includes(selected.accountType)) {
        creditAccountId = await accounts.payable("TRANSPORT_PAYABLE", "Transport Fees Payable");
      }
    } else {
      creditAccountId = await accounts.payable("TRANSPORT_PAYABLE", "Transport Fees Payable");
    }
    await postFactoryVoucherTx(tx, {
      companyId,
      voucherNumber: `TRANS-${container.containerNumber}-${container.id}`,
      voucherType: "Payment",
      voucherDate,
      description: `Transport fees for container ${container.containerNumber}`,
      sourceModule: "ERP",
      source: { sourceType: "container-offload-charge", sourceId: `${companyId}:${container.id}`, phase: "transport" },
      lines: [
        {
          ledgerAccountId: expenseId,
          debit: input.transportFees,
          narration: `Transport fees for container ${container.containerNumber}`,
        },
        {
          ledgerAccountId: creditAccountId,
          credit: input.transportFees,
          narration: `Transport fees for container ${container.containerNumber}`,
        },
      ],
    });
  }

  if (amount(input.transferCharges).greaterThan(0)) {
    const expenseId = await accounts.expense("TRANSFER_CHARGES", "Transfer Charges");
    const payableId = await accounts.payable("TRANSFER_PAYABLE", "Transfer Charges Payable");
    await postFactoryVoucherTx(tx, {
      companyId,
      voucherNumber: `XFER-${container.containerNumber}-${container.id}`,
      voucherType: "Payment",
      voucherDate,
      description: `Transfer charges for container ${container.containerNumber}`,
      sourceModule: "ERP",
      source: { sourceType: "container-offload-charge", sourceId: `${companyId}:${container.id}`, phase: "transfer" },
      lines: [
        {
          ledgerAccountId: expenseId,
          debit: input.transferCharges,
          narration: `Transfer charges for container ${container.containerNumber}`,
        },
        {
          ledgerAccountId: payableId,
          credit: input.transferCharges,
          narration: `Transfer charges for container ${container.containerNumber}`,
        },
      ],
    });
  }

  for (const [chargeIndex, charge] of (input.additionalCharges ?? []).entries()) {
    const chargeAmount = amount(charge.amount);
    if (chargeAmount.lessThanOrEqualTo(0)) continue;
    const [creditAccount] = await tx
      .select({ accountType: schema.ledgerAccounts.accountType, name: schema.ledgerAccounts.name })
      .from(schema.ledgerAccounts)
      .where(
        and(
          eq(schema.ledgerAccounts.id, charge.ledgerAccountId),
          eq(schema.ledgerAccounts.companyId, companyId),
          isNull(schema.ledgerAccounts.deletedAt)
        )
      )
      .limit(1);
    if (!creditAccount) {
      throw new ContainerOffloadLifecycleError(
        `Additional charge "${charge.description}" references an unavailable ledger account.`,
        400,
        "CONTAINER_OFFLOAD_ADDITIONAL_ACCOUNT_INVALID"
      );
    }
    if (["Direct Expense", "Indirect Expense"].includes(creditAccount.accountType)) {
      throw new ContainerOffloadLifecycleError(
        `Additional charge "${charge.description}" cannot credit the "${creditAccount.name}" expense account.`,
        400,
        "CONTAINER_OFFLOAD_ADDITIONAL_ACCOUNT_TYPE_INVALID"
      );
    }
    const expenseId = await accounts.expense("ADDITIONAL_CHARGES", "Additional Container Charges");
    // Phase 22 (C): cents of the exact amount (was the float's toFixed).
    const amountText = chargeAmount.toFixed(2);
    await postFactoryVoucherTx(tx, {
      companyId,
      voucherNumber: `CHG-${container.containerNumber}-${container.id}-${chargeIndex}`,
      voucherType: "Payment",
      voucherDate,
      description: `${charge.description} for container ${container.containerNumber}`,
      sourceModule: "ERP",
      source: {
        sourceType: "container-offload-charge",
        sourceId: `${companyId}:${container.id}:${chargeIndex}`,
        phase: "additional",
      },
      lines: [
        {
          ledgerAccountId: expenseId,
          debit: amountText,
          narration: `${charge.description} for container ${container.containerNumber}`,
        },
        {
          ledgerAccountId: charge.ledgerAccountId,
          credit: amountText,
          narration: `${charge.description} for container ${container.containerNumber}`,
        },
      ],
    });
  }
}

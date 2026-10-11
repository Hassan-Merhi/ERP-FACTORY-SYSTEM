import type { DbTransaction } from "../../../db";
import type Decimal from "decimal.js";
import { sumMoney } from "../../../lib/money";
import { postFactoryPartyLineVoucherTx, postFactoryVoucherTx } from "../../factory/factoryVoucherPosting";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "@shared/schema";

import { ContainerOffloadLifecycleError, ContainerOffloadLifecycleInput, amount } from "./types";

async function getSpAccount(tx: DbTransaction, companyId: number, subType: string) {
  const [account] = await tx
    .select()
    .from(schema.ledgerAccounts)
    .where(
      and(
        eq(schema.ledgerAccounts.companyId, companyId),
        eq(schema.ledgerAccounts.subType, subType),
        isNull(schema.ledgerAccounts.deletedAt)
      )
    )
    .limit(1);
  return account;
}

export async function postSupplierPartnerJournals(
  tx: DbTransaction,
  container: typeof schema.containers.$inferSelect,
  purchaseOrders: Array<typeof schema.purchaseOrders.$inferSelect>,
  input: ContainerOffloadLifecycleInput
): Promise<void> {
  const [company] = await tx
    .select({ companyType: schema.companies.companyType, parentCompanyId: schema.companies.parentCompanyId })
    .from(schema.companies)
    .where(eq(schema.companies.id, container.companyId))
    .limit(1);
  if (company?.companyType !== "supplier_partner") return;

  // Phase 22 (C): exact Decimal amounts (were float sums) and every journal
  // through the engine with its offload posting identity; the SP-* family
  // numbers are read as identity (offload reverse, voucher lists), so they keep
  // their prefix with the container id as the suffix (was Date.now()).
  const validAgentLines = (input.agentChargeLines ?? [])
    .map((line) => ({ ...line, amount: amount(line.amountUsd).toDecimalPlaces(2) }))
    .filter((line) => line.amount.greaterThan(0));
  const totalAgentAmount = sumMoney(validAgentLines.map((line) => line.amount));
  const totalOtw = amount(container.grandTotal).toDecimalPlaces(2);

  const otw = await getSpAccount(tx, container.companyId, "sp_goods_otw");
  const otwClearing = await getSpAccount(tx, container.companyId, "sp_otw_clearing");
  const stock = await getSpAccount(tx, container.companyId, "sp_stock");
  const costClearing = await getSpAccount(tx, container.companyId, "sp_cost_clearing");
  if (!otw || !otwClearing || !stock || !costClearing) {
    throw new ContainerOffloadLifecycleError(
      "SP OTW, Stock, or Cost Clearing accounts are not configured. Run SP Setup first.",
      400,
      "CONTAINER_OFFLOAD_SP_ACCOUNTS_MISSING"
    );
  }

  let parentIntercompany: typeof schema.ledgerAccounts.$inferSelect | undefined;
  let spIntercompany: typeof schema.ledgerAccounts.$inferSelect | undefined;
  let prepaidExpenses: typeof schema.ledgerAccounts.$inferSelect | undefined;
  const parentCompanyId = Number(company.parentCompanyId ?? 1);
  if (validAgentLines.length > 0) {
    parentIntercompany = await getSpAccount(tx, parentCompanyId, "hadi_sp_intercompany");
    spIntercompany = await getSpAccount(tx, container.companyId, "sp_hadi_intercompany");
    prepaidExpenses = await getSpAccount(tx, container.companyId, "sp_prepaid_expenses");
    if (!parentIntercompany || !spIntercompany || !prepaidExpenses) {
      throw new ContainerOffloadLifecycleError(
        "SP parent-agent intercompany accounts are not configured.",
        400,
        "CONTAINER_OFFLOAD_SP_AGENT_ACCOUNTS_MISSING"
      );
    }
  }

  if (totalOtw.greaterThan(0)) {
    const poTotals = purchaseOrders
      .map((po) => ({
        supplierId: po.supplierId,
        value: amount(po.itemsTotal)
          .plus(amount(po.freight))
          .plus(amount(po.otherCharges))
          .plus(amount(po.surcharge))
          .plus(amount(po.fumigation))
          .plus(amount(po.documentCharges))
          .minus(amount(po.discount))
          .toDecimalPlaces(2),
      }))
      .filter((row) => row.value.greaterThan(0));

    // The OTW clearing lines carry the clearing account AND the purchase
    // supplier (party detail read by the SP OTW reports). The engine takes one
    // target per line (customer + linked ledger is its only pair), so this one
    // journal goes through the party-line writer (identity, Decimal, a
    // deterministic number) until the control-account model (C9) decides how a
    // party rides on a control-account line.
    type ReversalLine = { supplierId: number | null; debit: Decimal };
    const reversalLines: ReversalLine[] = [];
    if (poTotals.length === 0) {
      reversalLines.push({ supplierId: null, debit: totalOtw });
    } else {
      const calculatedTotal = sumMoney(poTotals.map((row) => row.value));
      for (let index = 0; index < poTotals.length; index += 1) {
        const row = poTotals[index];
        const debit = index === poTotals.length - 1 ? row.value.plus(totalOtw.minus(calculatedTotal)) : row.value;
        if (debit.lessThanOrEqualTo(0)) {
          throw new ContainerOffloadLifecycleError(
            "SP purchase-order totals do not reconcile to the container OTW value.",
            409,
            "CONTAINER_OFFLOAD_SP_OTW_MISMATCH"
          );
        }
        reversalLines.push({ supplierId: row.supplierId ?? null, debit });
      }
    }
    await postFactoryPartyLineVoucherTx(tx, {
      companyId: container.companyId,
      voucherNumber: (generation) => `SP-OTW-REV-ERP-${container.id}-${generation}`,
      voucherDate: input.offloadDate,
      description: `Goods OTW Reversal — ERP container #${container.id}`,
      sourceModule: "SP",
      source: {
        sourceType: "sp-container-offload",
        sourceId: `${container.companyId}:${container.id}`,
        phase: "otw-reversal",
      },
      lines: [
        ...reversalLines.map((line) => ({
          ledgerAccountId: otwClearing.id,
          supplierId: line.supplierId,
          debit: line.debit,
          narration: `OTW Clearing reversal — ERP container #${container.id}`,
        })),
        { ledgerAccountId: otw.id, credit: totalOtw, narration: `Goods OTW reversal — ERP container #${container.id}` },
      ],
    });

    await postFactoryVoucherTx(tx, {
      companyId: container.companyId,
      voucherNumber: (generation) => `SP-STOCK-ERP-${container.id}-${generation}`,
      voucherDate: input.offloadDate,
      description: `Stock cost recognition — ERP container #${container.id}`,
      sourceModule: "SP",
      source: {
        sourceType: "sp-container-offload",
        sourceId: `${container.companyId}:${container.id}`,
        phase: "stock-recognition",
      },
      lines: [
        { ledgerAccountId: stock.id, debit: totalOtw, narration: `Stock on floor — ERP container #${container.id}` },
        {
          ledgerAccountId: costClearing.id,
          credit: totalOtw,
          narration: `Base goods cost payable — ERP container #${container.id}`,
        },
      ],
    });
  }

  if (validAgentLines.length > 0 && parentIntercompany && spIntercompany && prepaidExpenses) {
    await postFactoryVoucherTx(tx, {
      companyId: container.companyId,
      voucherNumber: (generation) => `SP-AGENT-SETTLE-${container.id}-${generation}`,
      voucherDate: input.offloadDate,
      description: `Agent charge settlement via parent company — container #${container.id}`,
      sourceModule: "SP",
      source: {
        sourceType: "sp-container-offload",
        sourceId: `${container.companyId}:${container.id}`,
        phase: "agent-settlement",
      },
      lines: [
        {
          ledgerAccountId: spIntercompany.id,
          debit: totalAgentAmount,
          narration: `Agent charges via parent company — ERP container #${container.id}`,
        },
        {
          ledgerAccountId: prepaidExpenses.id,
          credit: totalAgentAmount,
          narration: `Prepaid expenses used for agent charges — ERP container #${container.id}`,
        },
      ],
    });

    await postFactoryVoucherTx(tx, {
      companyId: parentCompanyId,
      voucherNumber: (generation) => `SP-AGENT-ERP-${container.id}-${generation}`,
      voucherDate: input.offloadDate,
      description: `Agent charges for ERP offload — container #${container.id}`,
      sourceModule: "SP",
      source: {
        sourceType: "sp-container-offload",
        sourceId: `${container.companyId}:${container.id}`,
        phase: "parent-agent",
      },
      lines: [
        {
          ledgerAccountId: parentIntercompany.id,
          debit: totalAgentAmount,
          narration: `ERP container offload agent charges — container #${container.id}`,
        },
        ...validAgentLines.map((line) => ({
          ledgerAccountId: line.parentAgentAccountId,
          credit: line.amount,
          narration: `Agent credit for ERP container #${container.id}${line.description ? ` — ${line.description}` : ""}`,
        })),
      ],
    });
  }
}

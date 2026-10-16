import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { sql, eq, and, isNull } from "drizzle-orm";
import Decimal from "decimal.js";
import {
  ledgerAccounts,
  locations,
  bankAccounts,
  spContainers,
  spContainerLines,
  spOffloads,
  spOffloadCharges,
  spStockMovements,
} from "@shared/schema";
import { adjustSpInventoryAtomic, respondToSpInventoryIntegrityError } from "../../services/sp/spInventoryIntegrity";
import { SP_RELEASE_CURRENCY, SP_RELEASE_EXCHANGE_RATE } from "../../services/sp/spReleasePolicy";
import { requireSpCompany, getSpAccount } from "./spHelpers";
import { sumMoney, toMoney } from "../../lib/money";
import { postFactoryVoucherTx, type FactoryVoucherLine } from "../../services/factory/factoryVoucherPosting";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";
import { resultRows, firstRow } from "../../lib/queryResult";
import { SP_CONTAINER_INVOICE_CHARGE_TYPE, spContainerInvoiceChargeLines } from "@shared/spContainerInvoiceCharges";

type SpOffloadChargeLine = {
  amountUsd?: unknown;
  chargeType: string;
  description?: string;
  prepaidChargeId?: string;
  parentAgentAccountId?: string;
  creditLedgerAccountId?: string;
  creditBankAccountId?: string;
};

class SpOffloadRouteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string
  ) {
    super(message);
    this.name = "SpOffloadRouteError";
  }
}

const CONTAINER_ALREADY_OFFLOADED_MESSAGE = "Container is already offloaded";

// ── Parent Company Agents + Offload ──────────────────────────────────────────

export function registerSpOffloadRoutes(app: Express) {
  app.get("/api/sp/parent-agents", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const parentRows = await db.execute(sql`SELECT parent_company_id FROM companies WHERE id = ${companyId} LIMIT 1`);
      const parentRow =
        firstRow(parentRows) ?? (parentRows as unknown as { [key: string]: Record<string, unknown> | undefined })[0];
      const parentId = parentRow?.parent_company_id ?? 1;

      const agents = await db.execute(sql`
        SELECT aa.id, aa.account_name, aa.account_id,
               la.id AS ledger_account_id, la.name AS ledger_name, la.account_type
        FROM agent_accounts aa
        JOIN ledger_accounts la ON la.id = CAST(REPLACE(aa.account_id, 'ledger-', '') AS integer)
        WHERE aa.company_id = ${parentId}
          AND la.deleted_at IS NULL
        ORDER BY aa.account_name
      `);

      res.json(resultRows(agents));
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Offload ───────────────────────────────────────────────────────────────

  app.post("/api/sp/offload", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const { containerId, offloadDate, chargeLines, locationId } = req.body;

      if (!containerId || !offloadDate) {
        return res.status(400).json({ message: "containerId and offloadDate are required" });
      }

      if (!locationId) {
        return res.status(400).json({ message: "locationId is required" });
      }
      const [offloadLocation] = await db
        .select()
        .from(locations)
        .where(
          and(eq(locations.id, parseInt(locationId)), eq(locations.companyId, companyId), isNull(locations.deletedAt))
        );
      if (!offloadLocation) {
        return res.status(400).json({ message: "Invalid location for this company" });
      }

      const parsedContainerId = Number(containerId);
      if (!Number.isInteger(parsedContainerId) || parsedContainerId <= 0) {
        return res.status(400).json({ message: "Invalid containerId" });
      }

      // Fetch SP accounts
      const otwAcct = await getSpAccount(companyId, "sp_goods_otw");
      const otwClrAcct = await getSpAccount(companyId, "sp_otw_clearing");
      const prepaidAcct = await getSpAccount(companyId, "sp_prepaid");
      const stockAcct = await getSpAccount(companyId, "sp_stock");
      const costClrAcct = await getSpAccount(companyId, "sp_cost_clearing");

      if (!otwAcct || !otwClrAcct || !stockAcct || !costClrAcct) {
        return res.status(400).json({ message: "SP accounts not configured. Run setup first." });
      }

      // Charges the user adds in the offload dialog (prepaid, cash, payables, agents…).
      // The supplier-invoice charges stated on the container itself are added below,
      // once the container row is locked, so they cannot be forgotten or re-typed.
      const requestedCharges: SpOffloadChargeLine[] = Array.isArray(chargeLines) ? chargeLines : [];

      const result = await db.transaction(async (tx) => {
        // Serialize every lifecycle mutation on the container row. The pre-transaction
        // status check used here previously allowed two simultaneous requests to both
        // observe "open" and double-post vouchers, stock and prepaid usage.
        const [container] = await tx
          .select()
          .from(spContainers)
          .where(and(eq(spContainers.id, parsedContainerId), eq(spContainers.companyId, companyId)))
          .limit(1)
          .for("update");

        if (!container) {
          throw new SpOffloadRouteError("Container not found", 404, "SP_OFFLOAD_NOT_FOUND");
        }
        if (container.status !== "open") {
          throw new SpOffloadRouteError("Container is already offloaded", 409, "SP_OFFLOAD_ALREADY_DONE");
        }

        // Read the posting inputs only after the lifecycle lock is held, so an edit
        // that commits first is included and an edit that arrives later must wait.
        const containerLines = await tx
          .select()
          .from(spContainerLines)
          .where(and(eq(spContainerLines.containerId, container.id), eq(spContainerLines.companyId, companyId)));

        if (containerLines.length === 0) {
          throw new SpOffloadRouteError("Container has no lines", 400, "SP_OFFLOAD_EMPTY");
        }

        // Freight, surcharge, fumigation and document charges stated on the container
        // invoice (PO Import Excel or typed in) are landed cost of this offload,
        // credited to SP Cost Clearing like the base goods cost: base + invoice
        // charges = the invoice total that Goods OTW was posted for.
        const containerInvoiceCharges: SpOffloadChargeLine[] = spContainerInvoiceChargeLines(container).map((line) => ({
          chargeType: line.chargeType,
          description: line.description,
          amountUsd: line.amountUsd,
        }));
        const charges: SpOffloadChargeLine[] = [...containerInvoiceCharges, ...requestedCharges];

        // Phase 22 (C): exact Decimal amounts (were parseFloat sums) and every
        // journal through the engine with this offload's posting identity. The
        // SP-OTW-REV- / SP-STOCK- / SP-AGENT- family numbers are read as identity
        // (voucher lists, reconciliation), so they keep their prefix with the
        // container id and posting generation as the suffix (was Date.now()).
        const discountFactor = new Decimal(1).minus(toMoney(container.discountPct).div(100));
        const totalQty = sumMoney(containerLines.map((l) => l.qty));
        const totalBaseCost = sumMoney(
          containerLines.map((l) => toMoney(l.qty).times(toMoney(l.unitRateUsd)).times(discountFactor))
        );
        const chargeAmount = (charge: SpOffloadChargeLine) => toMoney(String(charge.amountUsd ?? "0"));
        const totalLandedCost = sumMoney(charges.map(chargeAmount));
        const landedPerUnit = totalQty.greaterThan(0) ? totalLandedCost.div(totalQty) : new Decimal(0);
        const totalFinalCost = totalBaseCost.plus(totalLandedCost);
        const invoiceTotal = toMoney(container.invoiceTotalUsd).toDecimalPlaces(2);
        const spSource = (phase: string) => ({
          sourceType: "sp-offload",
          sourceId: `${companyId}:${container.id}`,
          phase,
        });

        const { voucher: voucherA } = await postFactoryVoucherTx(tx, {
          companyId,
          voucherNumber: (generation) => `SP-OTW-REV-${container.id}-${generation}`,
          voucherDate: offloadDate,
          description: `Goods OTW Reversal — ${container.supplierName} inv ${container.invoiceNumber}`,
          currency: SP_RELEASE_CURRENCY,
          fxRateToUsd: SP_RELEASE_EXCHANGE_RATE,
          sourceModule: "SP",
          source: spSource("otw-reversal"),
          lines: [
            {
              ledgerAccountId: otwClrAcct.id,
              debit: invoiceTotal,
              narration: `OTW Clearing reversal — container #${container.id}`,
            },
            {
              ledgerAccountId: otwAcct.id,
              credit: invoiceTotal,
              narration: `Goods OTW reversal — container #${container.id}`,
            },
          ],
        });

        // The stock voucher: Cr base supplier cost and each charge (cents); Dr
        // stock for exactly their sum.
        const stockCredits: FactoryVoucherLine[] = [
          {
            ledgerAccountId: costClrAcct.id,
            credit: totalBaseCost.toDecimalPlaces(2),
            narration: `Base supplier item cost — container #${container.id}`,
          },
        ];
        for (const charge of charges) {
          const chargeAmt = chargeAmount(charge).toDecimalPlaces(2);
          if (chargeAmt.lessThanOrEqualTo(0)) continue;

          if (charge.chargeType === "prepaid_used" && charge.prepaidChargeId) {
            // Scope the lock itself, not just the pre-handler guard. This keeps the
            // transactional ownership boundary correct even if the route is reused.
            const prepaidRows = await tx.execute(
              sql`SELECT amount_paid_usd, amount_used_usd FROM sp_prepaid_charges WHERE id = ${parseInt(charge.prepaidChargeId)} AND company_id = ${companyId} FOR UPDATE`
            );
            const prepaidRow =
              firstRow(prepaidRows) ??
              (prepaidRows as unknown as { [key: string]: Record<string, unknown> | undefined })[0];
            if (!prepaidRow) throw new Error(`Prepaid charge #${charge.prepaidChargeId} not found for this company`);
            const alreadyUsed = toMoney(String(prepaidRow.amount_used_usd ?? "0"));
            const totalPaid = toMoney(String(prepaidRow.amount_paid_usd ?? "0"));
            const remaining = totalPaid.minus(alreadyUsed);
            if (chargeAmt.greaterThan(remaining.plus("0.0001"))) {
              throw new Error(
                `Prepaid charge #${charge.prepaidChargeId} has only ${remaining.toFixed(4)} remaining (paid ${totalPaid}, used ${alreadyUsed}), cannot use ${chargeAmt}`
              );
            }
            if (prepaidAcct) {
              stockCredits.push({
                ledgerAccountId: prepaidAcct.id,
                credit: chargeAmt,
                narration: `Prepaid used — ${charge.description || "charge"} for container #${container.id}`,
              });
            }
            await tx.execute(
              sql`UPDATE sp_prepaid_charges SET amount_used_usd = amount_used_usd + ${chargeAmt.toFixed(2)} WHERE id = ${parseInt(charge.prepaidChargeId)} AND company_id = ${companyId}`
            );
          } else if (charge.chargeType === "paid_now" && charge.creditBankAccountId) {
            const [bankRow] = await tx
              .select()
              .from(bankAccounts)
              .where(
                and(eq(bankAccounts.id, parseInt(charge.creditBankAccountId)), eq(bankAccounts.companyId, companyId))
              );
            if (!bankRow) throw new Error(`Bank account #${charge.creditBankAccountId} not found for this company`);
            stockCredits.push({
              bankAccountId: parseInt(charge.creditBankAccountId),
              credit: chargeAmt,
              narration: `Cash paid at offload — ${charge.description || "charge"}`,
            });
          } else if (charge.chargeType === "unpaid_payable" && charge.creditLedgerAccountId) {
            const [ledgerRow] = await tx
              .select()
              .from(ledgerAccounts)
              .where(
                and(
                  eq(ledgerAccounts.id, parseInt(charge.creditLedgerAccountId)),
                  eq(ledgerAccounts.companyId, companyId),
                  isNull(ledgerAccounts.deletedAt)
                )
              );
            if (!ledgerRow)
              throw new Error(`Ledger account #${charge.creditLedgerAccountId} not found for this company`);
            stockCredits.push({
              ledgerAccountId: parseInt(charge.creditLedgerAccountId),
              credit: chargeAmt,
              narration: `Payable — ${charge.description || "charge"}`,
            });
          } else if (charge.chargeType === "other" && charge.creditLedgerAccountId) {
            const [otherRow] = await tx
              .select()
              .from(ledgerAccounts)
              .where(
                and(
                  eq(ledgerAccounts.id, parseInt(charge.creditLedgerAccountId)),
                  eq(ledgerAccounts.companyId, companyId),
                  isNull(ledgerAccounts.deletedAt)
                )
              );
            if (!otherRow)
              throw new Error(`Ledger account #${charge.creditLedgerAccountId} not found for this company`);
            stockCredits.push({
              ledgerAccountId: parseInt(charge.creditLedgerAccountId),
              credit: chargeAmt,
              narration: `Other charge — ${charge.description || "charge"}`,
            });
          } else if (charge.chargeType === "parent_agent") {
            const prepaidExpAcct = await getSpAccount(companyId, "sp_prepaid_expenses");
            if (!prepaidExpAcct)
              throw new Error("Prepaid Expenses account (SP-PREEXP) not found. Run SP setup or contact admin.");
            stockCredits.push({
              ledgerAccountId: prepaidExpAcct.id,
              credit: chargeAmt,
              narration: `Agent charge via HADI L'SHI — ${charge.description || ""}`,
            });
          } else if (charge.chargeType === SP_CONTAINER_INVOICE_CHARGE_TYPE) {
            stockCredits.push({
              ledgerAccountId: costClrAcct.id,
              credit: chargeAmt,
              narration: `${charge.description || "Container invoice charge"} — container #${container.id}`,
            });
          } else {
            stockCredits.push({
              ledgerAccountId: costClrAcct.id,
              credit: chargeAmt,
              narration: `Supplier freight/other — ${charge.description || "charge"}`,
            });
          }
        }
        const stockDebit = sumMoney(stockCredits.map((line) => line.credit ?? 0));
        const { voucher: voucherB } = await postFactoryVoucherTx(tx, {
          companyId,
          voucherNumber: (generation) => `SP-STOCK-${container.id}-${generation}`,
          voucherDate: offloadDate,
          description: `Stock offload — ${container.supplierName} inv ${container.invoiceNumber}`,
          currency: SP_RELEASE_CURRENCY,
          fxRateToUsd: SP_RELEASE_EXCHANGE_RATE,
          sourceModule: "SP",
          source: spSource("stock"),
          lines: [
            {
              ledgerAccountId: stockAcct.id,
              debit: stockDebit,
              narration: `Stock received — ${totalQty} units from container #${container.id}`,
            },
            ...stockCredits.filter((line) => toMoney(line.credit ?? 0).greaterThan(0)),
          ],
        });

        const [offload] = await tx
          .insert(spOffloads)
          .values({
            companyId,
            containerId: container.id,
            offloadDate,
            totalQty: totalQty.toFixed(),
            totalBaseCostUsd: totalBaseCost.toFixed(),
            totalLandedCostUsd: totalLandedCost.toFixed(),
            totalFinalCostUsd: totalFinalCost.toFixed(),
            voucherIdReversal: voucherA.id,
            voucherIdStock: voucherB.id,
          })
          .returning();

        const postedCharges = charges.filter((c) => chargeAmount(c).greaterThan(0));
        if (postedCharges.length > 0) {
          await tx.insert(spOffloadCharges).values(
            postedCharges.map((c) => ({
              offloadId: offload.id,
              companyId,
              chargeType: c.chargeType,
              description: c.description || null,
              amountUsd: chargeAmount(c).toFixed(),
              prepaidChargeId: c.prepaidChargeId ? parseInt(c.prepaidChargeId) : null,
              creditLedgerAccountId:
                c.chargeType === "parent_agent" && c.parentAgentAccountId
                  ? parseInt(c.parentAgentAccountId)
                  : c.creditLedgerAccountId
                    ? parseInt(c.creditLedgerAccountId)
                    : null,
              creditBankAccountId: c.creditBankAccountId ? parseInt(c.creditBankAccountId) : null,
            }))
          );
        }

        const agentCharges = postedCharges.filter((c) => c.chargeType === "parent_agent" && c.parentAgentAccountId);
        if (agentCharges.length > 0) {
          const [hadiSpInterco] = await tx
            .select()
            .from(ledgerAccounts)
            .where(
              and(
                eq(ledgerAccounts.companyId, 1),
                eq(ledgerAccounts.subType, "hadi_sp_intercompany"),
                isNull(ledgerAccounts.deletedAt)
              )
            );
          if (!hadiSpInterco)
            throw new Error(
              "HADI L'SHI intercompany account not found (SP-IC). Run startup migrations or contact admin."
            );
          const agentLines: FactoryVoucherLine[] = agentCharges.map((ac) => ({
            ledgerAccountId: parseInt(ac.parentAgentAccountId ?? ""),
            debit: chargeAmount(ac).toDecimalPlaces(2),
            narration: `Agent charge for SP container #${container.id}${ac.description ? ` — ${ac.description}` : ""}`,
          }));
          const totalAgentAmt = sumMoney(agentLines.map((line) => line.debit ?? 0));
          await postFactoryVoucherTx(tx, {
            companyId: 1,
            voucherNumber: (generation) => `SP-AGENT-${container.id}-${generation}`,
            voucherDate: offloadDate,
            description: `Agent charges for SP offload — ${container.supplierName} inv ${container.invoiceNumber}`,
            currency: SP_RELEASE_CURRENCY,
            fxRateToUsd: SP_RELEASE_EXCHANGE_RATE,
            sourceModule: "SP",
            source: spSource("parent-agent"),
            lines: [
              ...agentLines,
              {
                ledgerAccountId: hadiSpInterco.id,
                credit: totalAgentAmt,
                narration: `SP offload agent charges total — container #${container.id}`,
              },
            ],
          });
        }

        for (const line of containerLines) {
          const qty = toMoney(line.qty);
          const baseUnitCost = toMoney(line.unitRateUsd).times(discountFactor);
          const finalUnitCost = baseUnitCost.plus(landedPerUnit);
          const [movement] = await tx
            .insert(spStockMovements)
            .values({
              companyId,
              containerId: container.id,
              offloadId: offload.id,
              containerLineId: line.id,
              articleCode: line.articleCode,
              description: line.description || null,
              stockItemId: line.stockItemId || null,
              locationId: offloadLocation.id,
              qtyIn: qty.toFixed(),
              qtyRemaining: qty.toFixed(),
              baseUnitCostUsd: baseUnitCost.toFixed(),
              landedUnitCostUsd: landedPerUnit.toFixed(),
              finalUnitCostUsd: finalUnitCost.toFixed(),
            })
            .returning();
          await adjustSpInventoryAtomic(tx, {
            companyId,
            locationId: offloadLocation.id,
            stockItemId: line.stockItemId,
            deltaQty: qty.toNumber(),
            incomingRate: finalUnitCost.toNumber(),
            context: `SP offload container #${container.id} line #${line.id}`,
            sourceVoucherType: "SP_OFFLOAD",
            sourceVoucherId: offload.id,
          });
          if (!movement) throw new Error(`SP offload container #${container.id} failed to create its stock movement`);
        }

        const [closedContainer] = await tx
          .update(spContainers)
          .set({ status: "offloaded" })
          .where(
            and(
              eq(spContainers.id, container.id),
              eq(spContainers.companyId, companyId),
              eq(spContainers.status, "open")
            )
          )
          .returning({ id: spContainers.id });
        if (!closedContainer) {
          throw new SpOffloadRouteError(CONTAINER_ALREADY_OFFLOADED_MESSAGE, 409, "SP_OFFLOAD_STATE_CONFLICT");
        }
        return offload;
      });

      res.json(result);
    } catch (error: unknown) {
      if (error instanceof SpOffloadRouteError) {
        return res.status(error.status).json({ code: error.code, message: error.message });
      }
      if (respondToSpInventoryIntegrityError(res, error)) return;
      if (error instanceof PostingValidationError) {
        return res.status(400).json({ code: error.code, message: error.message });
      }
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

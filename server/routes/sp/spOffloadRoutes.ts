import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { sql, eq, and, isNull } from "drizzle-orm";
import {
  ledgerAccounts,
  vouchers,
  voucherEntries,
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
import { requireSpCompany, getSpAccount, parseNum } from "./spHelpers";
import { resultRows, firstRow } from "../../lib/queryResult";

type SpOffloadChargeLine = {
  amountUsd?: unknown;
  chargeType: string;
  description?: string;
  prepaidChargeId?: string;
  parentAgentAccountId?: string;
  creditLedgerAccountId?: string;
  creditBankAccountId?: string;
};

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

      const [container] = await db
        .select()
        .from(spContainers)
        .where(and(eq(spContainers.id, parseInt(containerId)), eq(spContainers.companyId, companyId)));

      if (!container) return res.status(404).json({ message: "Container not found" });
      if (container.status !== "open") return res.status(400).json({ message: "Container is already offloaded" });

      const containerLines = await db
        .select()
        .from(spContainerLines)
        .where(eq(spContainerLines.containerId, container.id));

      if (containerLines.length === 0) {
        return res.status(400).json({ message: "Container has no lines" });
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

      // Discount rate
      const discountPct = parseNum(container.discountPct);
      const discountFactor = 1 - discountPct / 100;

      // Per-line base costs
      const totalQty = containerLines.reduce((s, l) => s + parseNum(l.qty), 0);
      const totalBaseCost = containerLines.reduce(
        (s, l) => s + parseNum(l.qty) * parseNum(l.unitRateUsd) * discountFactor,
        0
      );

      // Landed charges
      const charges: SpOffloadChargeLine[] = chargeLines || [];
      const totalLandedCost = charges.reduce((s: number, c) => s + parseNum(c.amountUsd), 0);
      const landedPerUnit = totalQty > 0 ? totalLandedCost / totalQty : 0;
      const totalFinalCost = totalBaseCost + totalLandedCost;
      const invoiceTotal = parseNum(container.invoiceTotalUsd);

      const result = await db.transaction(async (tx) => {
        // ── Voucher A: Reverse Goods OTW ──────────────────────────────────────
        const [voucherA] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherType: "Journal",
            voucherNumber: `SP-OTW-REV-${container.id}-${Date.now()}`,
            voucherDate: offloadDate,
            description: `Goods OTW Reversal — ${container.supplierName} inv ${container.invoiceNumber}`,
            totalAmount: String(invoiceTotal),
            currency: SP_RELEASE_CURRENCY,
            exchangeRate: SP_RELEASE_EXCHANGE_RATE,
            sourceModule: "SP",
          })
          .returning();

        // Dr Goods OTW Clearing (Liability side reduces)
        await tx.insert(voucherEntries).values({
          voucherId: voucherA.id,
          ledgerAccountId: otwClrAcct.id,
          debitAmount: String(invoiceTotal),
          creditAmount: "0",
          narration: `OTW Clearing reversal — container #${container.id}`,
        });
        // Cr Goods OTW (Asset disappears)
        await tx.insert(voucherEntries).values({
          voucherId: voucherA.id,
          ledgerAccountId: otwAcct.id,
          debitAmount: "0",
          creditAmount: String(invoiceTotal),
          narration: `Goods OTW reversal — container #${container.id}`,
        });

        // ── Voucher B: Create Stock ───────────────────────────────────────────
        const [voucherB] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherType: "Journal",
            voucherNumber: `SP-STOCK-${container.id}-${Date.now()}`,
            voucherDate: offloadDate,
            description: `Stock offload — ${container.supplierName} inv ${container.invoiceNumber}`,
            totalAmount: String(totalFinalCost),
            currency: SP_RELEASE_CURRENCY,
            exchangeRate: SP_RELEASE_EXCHANGE_RATE,
            sourceModule: "SP",
          })
          .returning();

        // Dr Stock on Floor (full final cost)
        await tx.insert(voucherEntries).values({
          voucherId: voucherB.id,
          ledgerAccountId: stockAcct.id,
          debitAmount: String(totalFinalCost),
          creditAmount: "0",
          narration: `Stock received — ${totalQty} units from container #${container.id}`,
        });

        // Cr base item cost → Stock Cost Payable Clearing
        await tx.insert(voucherEntries).values({
          voucherId: voucherB.id,
          ledgerAccountId: costClrAcct.id,
          debitAmount: "0",
          creditAmount: String(totalBaseCost),
          narration: `Base supplier item cost — container #${container.id}`,
        });

        // Cr each landed charge line
        for (const charge of charges) {
          const chargeAmt = parseNum(charge.amountUsd);
          if (chargeAmt <= 0) continue;

          if (charge.chargeType === "prepaid_used" && charge.prepaidChargeId) {
            // Validate: cannot use more than remaining prepaid balance
            const prepaidRows = await tx.execute(
              sql`SELECT amount_paid_usd, amount_used_usd FROM sp_prepaid_charges WHERE id = ${parseInt(charge.prepaidChargeId)} FOR UPDATE`
            );
            const prepaidRow =
              firstRow(prepaidRows) ??
              (prepaidRows as unknown as { [key: string]: Record<string, unknown> | undefined })[0];
            if (!prepaidRow) throw new Error(`Prepaid charge #${charge.prepaidChargeId} not found`);
            const alreadyUsed = parseNum(prepaidRow.amount_used_usd);
            const totalPaid = parseNum(prepaidRow.amount_paid_usd);
            const remaining = totalPaid - alreadyUsed;
            if (chargeAmt > remaining + 0.0001) {
              throw new Error(
                `Prepaid charge #${charge.prepaidChargeId} has only ${remaining.toFixed(4)} remaining (paid ${totalPaid}, used ${alreadyUsed}), cannot use ${chargeAmt}`
              );
            }

            // Cr Prepaid Charges (asset reduces)
            if (prepaidAcct) {
              await tx.insert(voucherEntries).values({
                voucherId: voucherB.id,
                ledgerAccountId: prepaidAcct.id,
                debitAmount: "0",
                creditAmount: String(chargeAmt),
                narration: `Prepaid used — ${charge.description || "charge"} for container #${container.id}`,
              });
            }
            // Accumulate used amount (add, not overwrite)
            await tx.execute(
              sql`UPDATE sp_prepaid_charges SET amount_used_usd = amount_used_usd + ${chargeAmt} WHERE id = ${parseInt(charge.prepaidChargeId)}`
            );
          } else if (charge.chargeType === "paid_now" && charge.creditBankAccountId) {
            // Validate bank account belongs to company inside the same transaction.
            const [bankRow] = await tx
              .select()
              .from(bankAccounts)
              .where(
                and(eq(bankAccounts.id, parseInt(charge.creditBankAccountId)), eq(bankAccounts.companyId, companyId))
              );
            if (!bankRow) throw new Error(`Bank account #${charge.creditBankAccountId} not found for this company`);

            await tx.insert(voucherEntries).values({
              voucherId: voucherB.id,
              bankAccountId: parseInt(charge.creditBankAccountId),
              debitAmount: "0",
              creditAmount: String(chargeAmt),
              narration: `Cash paid at offload — ${charge.description || "charge"}`,
            });
          } else if (charge.chargeType === "unpaid_payable" && charge.creditLedgerAccountId) {
            // Validate ledger account belongs to company inside the same transaction.
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

            await tx.insert(voucherEntries).values({
              voucherId: voucherB.id,
              ledgerAccountId: parseInt(charge.creditLedgerAccountId),
              debitAmount: "0",
              creditAmount: String(chargeAmt),
              narration: `Payable — ${charge.description || "charge"}`,
            });
          } else if (charge.chargeType === "other" && charge.creditLedgerAccountId) {
            // Validate ledger account belongs to company inside the same transaction.
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

            await tx.insert(voucherEntries).values({
              voucherId: voucherB.id,
              ledgerAccountId: parseInt(charge.creditLedgerAccountId),
              debitAmount: "0",
              creditAmount: String(chargeAmt),
              narration: `Other charge — ${charge.description || "charge"}`,
            });
          } else if (charge.chargeType === "parent_agent") {
            // Agent charge via parent company (HADI L'SHI) — Cr Prepaid Expenses in SP Test Co.
            // The HADI L'SHI side (Dr Agent / Cr SP Intercompany) is posted after Voucher B.
            const prepaidExpAcct = await getSpAccount(companyId, "sp_prepaid_expenses");
            if (!prepaidExpAcct)
              throw new Error("Prepaid Expenses account (SP-PREEXP) not found. Run SP setup or contact admin.");

            await tx.insert(voucherEntries).values({
              voucherId: voucherB.id,
              ledgerAccountId: prepaidExpAcct.id,
              debitAmount: "0",
              creditAmount: String(chargeAmt),
              narration: `Agent charge via HADI L'SHI — ${charge.description || ""}`,
            });
          } else {
            // invoice_freight or fallback → Cr Stock Cost Payable Clearing
            await tx.insert(voucherEntries).values({
              voucherId: voucherB.id,
              ledgerAccountId: costClrAcct.id,
              debitAmount: "0",
              creditAmount: String(chargeAmt),
              narration: `Supplier freight/other — ${charge.description || "charge"}`,
            });
          }
        }

        // ── Insert sp_offload record ──────────────────────────────────────────
        const [offload] = await tx
          .insert(spOffloads)
          .values({
            companyId,
            containerId: container.id,
            offloadDate,
            totalQty: String(totalQty),
            totalBaseCostUsd: String(totalBaseCost),
            totalLandedCostUsd: String(totalLandedCost),
            totalFinalCostUsd: String(totalFinalCost),
            voucherIdReversal: voucherA.id,
            voucherIdStock: voucherB.id,
          })
          .returning();

        // ── Insert offload charges ────────────────────────────────────────────
        if (charges.length > 0) {
          await tx.insert(spOffloadCharges).values(
            charges
              .filter((c) => parseNum(c.amountUsd) > 0)
              .map((c) => ({
                offloadId: offload.id,
                companyId,
                chargeType: c.chargeType,
                description: c.description || null,
                amountUsd: String(parseNum(c.amountUsd)),
                prepaidChargeId: c.prepaidChargeId ? parseInt(c.prepaidChargeId) : null,
                // For parent_agent: store the agent ledger id here for reference/traceability
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

        // ── Voucher C: HADI L'SHI agent journals (if any parent_agent charges) ──
        const agentCharges = charges.filter(
          (c) => c.chargeType === "parent_agent" && parseNum(c.amountUsd) > 0 && c.parentAgentAccountId
        );
        if (agentCharges.length > 0) {
          // Lookup HADI L'SHI intercompany account (lives in HADI L'SHI, company_id=1)
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
          if (!hadiSpInterco) {
            throw new Error(
              "HADI L'SHI intercompany account not found (SP-IC). Run startup migrations or contact admin."
            );
          }

          const totalAgentAmt = agentCharges.reduce((s: number, c) => s + parseNum(c.amountUsd), 0);

          // Create Voucher C in HADI L'SHI (company_id=1)
          const [voucherC] = await tx
            .insert(vouchers)
            .values({
              companyId: 1,
              voucherType: "Journal",
              voucherNumber: `SP-AGENT-${container.id}-${Date.now()}`,
              voucherDate: offloadDate,
              description: `Agent charges for SP offload — ${container.supplierName} inv ${container.invoiceNumber}`,
              totalAmount: String(totalAgentAmt),
              currency: SP_RELEASE_CURRENCY,
              exchangeRate: SP_RELEASE_EXCHANGE_RATE,
              sourceModule: "SP",
            })
            .returning();

          // Dr each agent account in HADI L'SHI
          for (const ac of agentCharges) {
            const agentLedgerId = parseInt(ac.parentAgentAccountId ?? "");
            await tx.insert(voucherEntries).values({
              voucherId: voucherC.id,
              ledgerAccountId: agentLedgerId,
              debitAmount: String(parseNum(ac.amountUsd)),
              creditAmount: "0",
              narration: `Agent charge for SP container #${container.id}${ac.description ? ` — ${ac.description}` : ""}`,
            });
          }

          // Cr SP Test Co — Intercompany (excluded from Net Position by account type)
          await tx.insert(voucherEntries).values({
            voucherId: voucherC.id,
            ledgerAccountId: hadiSpInterco.id,
            debitAmount: "0",
            creditAmount: String(totalAgentAmt),
            narration: `SP offload agent charges total — container #${container.id}`,
          });
        }

        // ── Insert stock movements + ERP inventory atomically ────────────────
        for (const line of containerLines) {
          const qty = parseNum(line.qty);
          const baseUnitCost = parseNum(line.unitRateUsd) * discountFactor;
          const finalUnitCost = baseUnitCost + landedPerUnit;

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
              qtyIn: String(qty),
              qtyRemaining: String(qty),
              baseUnitCostUsd: String(baseUnitCost),
              landedUnitCostUsd: String(landedPerUnit),
              finalUnitCostUsd: String(finalUnitCost),
            })
            .returning();

          await adjustSpInventoryAtomic(tx, {
            companyId,
            locationId: offloadLocation.id,
            stockItemId: line.stockItemId,
            deltaQty: qty,
            incomingRate: finalUnitCost,
            context: `SP offload container #${container.id} line #${line.id}`,
            sourceVoucherType: "SP_OFFLOAD",
            sourceVoucherId: offload.id,
          });

          if (!movement) {
            throw new Error(`SP offload container #${container.id} failed to create its stock movement`);
          }
        }

        // ── Update container status ───────────────────────────────────────────
        await tx.update(spContainers).set({ status: "offloaded" }).where(eq(spContainers.id, container.id));

        return offload;
      });

      res.json(result);
    } catch (error: unknown) {
      if (respondToSpInventoryIntegrityError(res, error)) return;
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

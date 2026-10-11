import type { Express, Request, Response } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { sql, eq, and, isNull, desc, asc } from "drizzle-orm";
import {
  ledgerAccounts,
  vouchers,
  voucherEntries,
  bankAccounts,
  spContainers,
  spContainerLines,
  spPrepaidCharges,
  spOffloads,
  spOffloadCharges,
  spStockMovements,
  type SpOffloadCharge,
} from "@shared/schema";
import { getClientDate } from "../../lib/dateUtils";
import { resultRows } from "../../lib/queryResult";
import { requireSpCompany, getSpAccount, parseNum } from "./spHelpers";
import { parseMoneyInput, plusMoney, toMoney } from "../../lib/money";
import {
  postFactoryPartyLineVoucherTx,
  postFactoryVoucherTx,
  usdLineAmounts,
} from "../../services/factory/factoryVoucherPosting";
import {
  editPostedFactoryVoucherTx,
  sendVoucherCorrectionRefusal,
} from "../../services/factory/factoryVoucherCorrection";
import { PostingValidationError } from "../../services/accounting/centralPostingEngine";

// ── Containers + Prepaid Charges ─────────────────────────────────────────────

export function registerSpContainerRoutes(app: Express) {
  app.get("/api/sp/containers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const containers = await db
        .select()
        .from(spContainers)
        .where(eq(spContainers.companyId, companyId))
        .orderBy(desc(spContainers.createdAt));

      const lines = await db.select().from(spContainerLines).where(eq(spContainerLines.companyId, companyId));

      const result = containers.map((c) => ({
        ...c,
        lines: lines.filter((l) => l.containerId === c.id),
        totalQty: lines.filter((l) => l.containerId === c.id).reduce((s, l) => s + parseNum(l.qty), 0),
      }));

      res.json(result);
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if (error instanceof PostingValidationError)
        return res.status(400).json({ code: error.code, message: error.message });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/sp/containers", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const {
        supplierId,
        supplierName,
        containerNumber,
        invoiceNumber,
        invoiceDate,
        invoiceTotalUsd,
        discountPct,
        freightEstimateUsd,
        notes,
        lines,
        otwAccountId,
        otwClearingAccountId,
      } = req.body;

      if (!supplierName || !invoiceNumber || !invoiceDate) {
        return res.status(400).json({ message: "supplierName, invoiceNumber, invoiceDate are required" });
      }

      let otwAcct = await getSpAccount(companyId, "sp_goods_otw");
      let otwClrAcct = await getSpAccount(companyId, "sp_otw_clearing");
      if (!otwAcct || !otwClrAcct) {
        return res.status(400).json({ message: "Chart of accounts not set up. Run /api/sp/setup first." });
      }

      // Allow optional override accounts — validate they belong to this company
      if (otwAccountId) {
        const [customOtw] = await db
          .select()
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.id, parseInt(otwAccountId)),
              eq(ledgerAccounts.companyId, companyId),
              isNull(ledgerAccounts.deletedAt)
            )
          );
        if (!customOtw) return res.status(400).json({ message: "Goods OTW account not found for this company" });
        otwAcct = customOtw;
      }
      if (otwClearingAccountId) {
        const [customOtwClr] = await db
          .select()
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.id, parseInt(otwClearingAccountId)),
              eq(ledgerAccounts.companyId, companyId),
              isNull(ledgerAccounts.deletedAt)
            )
          );
        if (!customOtwClr) return res.status(400).json({ message: "OTW Clearing account not found for this company" });
        otwClrAcct = customOtwClr;
      }

      const totalUsd = (parseMoneyInput(invoiceTotalUsd) ?? toMoney(0)).toDecimalPlaces(2);
      const supplierIdNum = supplierId ? parseInt(String(supplierId)) : null;

      const result = await db.transaction(async (tx) => {
        const [container] = await tx
          .insert(spContainers)
          .values({
            companyId,
            supplierId: supplierIdNum,
            supplierName,
            containerNumber: containerNumber || null,
            invoiceNumber,
            invoiceDate,
            invoiceTotalUsd: totalUsd.toFixed(2),
            discountPct: String(parseNum(discountPct)),
            freightEstimateUsd: String(parseNum(freightEstimateUsd)),
            notes: notes || null,
            status: "open",
          })
          .returning();

        // Insert lines
        if (lines && lines.length > 0) {
          await tx.insert(spContainerLines).values(
            lines.map((l: Record<string, unknown>) => ({
              containerId: container.id,
              companyId,
              articleCode: l.articleCode,
              description: l.description || null,
              qty: String(parseNum(l.qty)),
              unitRateUsd: String(parseNum(l.unitRateUsd)),
              stockItemId: l.stockItemId || null,
            }))
          );
        }

        // Voucher: Dr Goods OTW / Cr Goods OTW Clearing
        if (totalUsd.greaterThan(0)) {
          // Phase 22 (C): identity, Decimal, deterministic SP-OTW- number (read as
          // identity by the SP lists). The clearing line carries the supplier as
          // party, so it is posted by the party-line writer (see factoryVoucherPosting).
          const { voucherId } = await postFactoryPartyLineVoucherTx(tx, {
            companyId,
            voucherNumber: (generation) => `SP-OTW-${container.id}-${generation}`,
            voucherDate: invoiceDate,
            description: `Goods OTW: ${supplierName} — Invoice ${invoiceNumber}`,
            sourceModule: "SP",
            source: { sourceType: "sp-container-otw", sourceId: `${companyId}:${container.id}`, phase: "voucher" },
            lines: [
              {
                ledgerAccountId: otwAcct.id,
                debit: totalUsd,
                narration: `Goods OTW — ${supplierName} inv ${invoiceNumber}`,
              },
              {
                ledgerAccountId: otwClrAcct.id,
                supplierId: supplierIdNum,
                credit: totalUsd,
                narration: `OTW Clearing — ${supplierName} inv ${invoiceNumber}`,
              },
            ],
          });
          const voucher = { id: voucherId };
          await tx.update(spContainers).set({ goodsOtwVoucherId: voucher.id }).where(eq(spContainers.id, container.id));
        }

        return container;
      });

      res.json(result);
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if (error instanceof PostingValidationError)
        return res.status(400).json({ code: error.code, message: error.message });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // PATCH /api/sp/containers/:id — edit header fields + regenerate OTW voucher
  app.patch("/api/sp/containers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const containerId = parseInt(req.params.id);
      if (isNaN(containerId)) return res.status(400).json({ message: "Invalid container ID" });

      const containerEditConflictMessage = "Cannot edit an offloaded container";

      const [existing] = await db
        .select()
        .from(spContainers)
        .where(and(eq(spContainers.id, containerId), eq(spContainers.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Container not found" });
      if (existing.status === "offloaded") {
        return res.status(400).json({ message: containerEditConflictMessage });
      }

      const {
        supplierId,
        supplierName,
        containerNumber,
        invoiceNumber,
        invoiceDate,
        invoiceTotalUsd,
        discountPct,
        freightEstimateUsd,
        notes,
      } = req.body;

      const otwAcct = await getSpAccount(companyId, "sp_goods_otw");
      const otwClrAcct = await getSpAccount(companyId, "sp_otw_clearing");
      if (!otwAcct || !otwClrAcct) {
        return res.status(400).json({ message: "Chart of accounts not set up" });
      }

      const updated = await db.transaction(async (tx) => {
        // Lock the lifecycle row before deriving defaults or updating the OTW
        // voucher. This serializes container edits with offload/reversal work and
        // prevents a stale pre-check from editing a container after it was offloaded.
        const [lockedExisting] = await tx
          .select()
          .from(spContainers)
          .where(and(eq(spContainers.id, containerId), eq(spContainers.companyId, companyId)))
          .limit(1)
          .for("update");

        if (!lockedExisting || lockedExisting.status === "offloaded") {
          return null;
        }

        const totalUsd = (
          parseMoneyInput(invoiceTotalUsd ?? lockedExisting.invoiceTotalUsd) ?? toMoney(0)
        ).toDecimalPlaces(2);
        const supplierIdNum = supplierId ? parseInt(String(supplierId)) : (lockedExisting.supplierId ?? null);
        const newSupplierName = supplierName ?? lockedExisting.supplierName;
        const newInvoiceNumber = invoiceNumber ?? lockedExisting.invoiceNumber;
        const newInvoiceDate = invoiceDate ?? lockedExisting.invoiceDate;

        // Update container fields
        const [updatedContainer] = await tx
          .update(spContainers)
          .set({
            supplierId: supplierIdNum,
            supplierName: newSupplierName,
            containerNumber: containerNumber !== undefined ? containerNumber || null : lockedExisting.containerNumber,
            invoiceNumber: newInvoiceNumber,
            invoiceDate: newInvoiceDate,
            invoiceTotalUsd: totalUsd.toFixed(2),
            discountPct: String(parseNum(discountPct ?? lockedExisting.discountPct)),
            freightEstimateUsd: String(parseNum(freightEstimateUsd ?? lockedExisting.freightEstimateUsd)),
            notes: notes !== undefined ? notes || null : lockedExisting.notes,
          })
          .where(and(eq(spContainers.id, containerId), eq(spContainers.companyId, companyId)))
          .returning();

        // Regenerate OTW voucher if amount or supplier changed
        if (lockedExisting.goodsOtwVoucherId && totalUsd.greaterThan(0)) {
          const otwVoucherId = lockedExisting.goodsOtwVoucherId;
          // Phase 22 (C), G4/PE9: an audited open-period edit of the posted OTW
          // voucher (refused with 409 in a closed period: reverse and re-post).
          await editPostedFactoryVoucherTx(
            tx,
            {
              companyId,
              voucherIds: [otwVoucherId],
              reason: "sp-container-otw-edit",
              actor: { userId: req.session.userId, username: req.session.username },
              newVoucherDate: newInvoiceDate,
            },
            async () => {
              await tx
                .update(vouchers)
                .set({
                  voucherDate: newInvoiceDate,
                  description: `Goods OTW: ${newSupplierName} — Invoice ${newInvoiceNumber}`,
                  totalAmount: totalUsd.toFixed(2),
                })
                .where(eq(vouchers.id, otwVoucherId));
              // Wave 16 (A): the edit carries the container's supplier on the header
              // itself; the container trigger no longer rewrites posted vouchers.
              await tx.execute(
                sql`UPDATE vouchers SET supplier_id = ${supplierIdNum}
                     WHERE id = ${otwVoucherId} AND company_id = ${companyId}
                       AND supplier_id IS DISTINCT FROM ${supplierIdNum}`
              );
              // Delete old entries and recreate with updated amounts
              await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, otwVoucherId));
              await tx.insert(voucherEntries).values([
                {
                  voucherId: otwVoucherId,
                  ledgerAccountId: otwAcct.id,
                  ...usdLineAmounts(totalUsd, 0),
                  narration: `Goods OTW — ${newSupplierName} inv ${newInvoiceNumber}`,
                },
                {
                  voucherId: otwVoucherId,
                  ledgerAccountId: otwClrAcct.id,
                  supplierId: supplierIdNum,
                  ...usdLineAmounts(0, totalUsd),
                  narration: `OTW Clearing — ${newSupplierName} inv ${newInvoiceNumber}`,
                },
              ]);
            }
          );
        } else if (!lockedExisting.goodsOtwVoucherId && totalUsd.greaterThan(0)) {
          // Create new voucher if none existed
          const { voucherId } = await postFactoryPartyLineVoucherTx(tx, {
            companyId,
            voucherNumber: (generation) => `SP-OTW-${containerId}-${generation}`,
            voucherDate: newInvoiceDate,
            description: `Goods OTW: ${newSupplierName} — Invoice ${newInvoiceNumber}`,
            sourceModule: "SP",
            source: { sourceType: "sp-container-otw", sourceId: `${companyId}:${containerId}`, phase: "voucher" },
            lines: [
              {
                ledgerAccountId: otwAcct.id,
                debit: totalUsd,
                narration: `Goods OTW — ${newSupplierName} inv ${newInvoiceNumber}`,
              },
              {
                ledgerAccountId: otwClrAcct.id,
                supplierId: supplierIdNum,
                credit: totalUsd,
                narration: `OTW Clearing — ${newSupplierName} inv ${newInvoiceNumber}`,
              },
            ],
          });
          await tx.update(spContainers).set({ goodsOtwVoucherId: voucherId }).where(eq(spContainers.id, containerId));
        }

        return updatedContainer;
      });

      if (!updated) {
        return res.status(409).json({
          code: "SP_CONTAINER_STATE_CONFLICT",
          message: containerEditConflictMessage,
        });
      }

      res.json(updated);
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if (error instanceof PostingValidationError)
        return res.status(400).json({ code: error.code, message: error.message });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.get("/api/sp/containers/:id", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid id" });

      const [container] = await db
        .select()
        .from(spContainers)
        .where(and(eq(spContainers.id, id), eq(spContainers.companyId, companyId)));

      if (!container) return res.status(404).json({ message: "Container not found" });

      const lines = await db
        .select()
        .from(spContainerLines)
        .where(eq(spContainerLines.containerId, id))
        .orderBy(asc(spContainerLines.id));

      const prepaid = await db
        .select()
        .from(spPrepaidCharges)
        .where(and(eq(spPrepaidCharges.containerId, id), eq(spPrepaidCharges.companyId, companyId)))
        .orderBy(asc(spPrepaidCharges.createdAt));

      const [offload] = await db
        .select()
        .from(spOffloads)
        .where(and(eq(spOffloads.containerId, id), eq(spOffloads.companyId, companyId)));

      let offloadCharges: SpOffloadCharge[] = [];
      if (offload) {
        offloadCharges = await db.select().from(spOffloadCharges).where(eq(spOffloadCharges.offloadId, offload.id));
      }

      const movements = await db
        .select()
        .from(spStockMovements)
        .where(and(eq(spStockMovements.containerId, id), eq(spStockMovements.companyId, companyId)));

      res.json({ ...container, lines, prepaid, offload: offload || null, offloadCharges, movements });
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if (error instanceof PostingValidationError)
        return res.status(400).json({ code: error.code, message: error.message });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // GET /api/sp/containers/:id/line-preview — enriched per-line preview with alias resolution
  app.get("/api/sp/containers/:id/line-preview", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const id = parseInt(req.params.id);
      if (!id) return res.status(400).json({ message: "Invalid id" });

      const [container] = await db
        .select()
        .from(spContainers)
        .where(and(eq(spContainers.id, id), eq(spContainers.companyId, companyId)));

      if (!container) return res.status(404).json({ message: "Container not found" });

      const lines = await db
        .select()
        .from(spContainerLines)
        .where(eq(spContainerLines.containerId, id))
        .orderBy(asc(spContainerLines.id));

      type SpContainerAliasRow = {
        alias_code: string;
        stock_item_id: number;
        item_code: string;
        item_name: string;
      };
      const aliasResult = await db.execute(sql`
        SELECT a.alias_code, a.stock_item_id, si.code AS item_code, si.name AS item_name
        FROM stock_item_code_aliases a
        JOIN stock_items si ON si.id = a.stock_item_id
        WHERE a.company_id = ${companyId}
      `);
      const aliasMap = new Map<string, { stockItemId: number; itemCode: string; itemName: string }>();
      for (const row of resultRows<SpContainerAliasRow>(aliasResult)) {
        aliasMap.set(row.alias_code, {
          stockItemId: row.stock_item_id,
          itemCode: row.item_code,
          itemName: row.item_name,
        });
      }

      const discountFactor = 1 - toMoney(container.discountPct).toNumber() / 100;
      const totalQty = lines.reduce((s, l) => plusMoney(s, l.qty), 0);

      const enriched = lines.map((l) => {
        const alias = aliasMap.get(l.articleCode);
        const qty = toMoney(l.qty).toNumber();
        const unitRate = toMoney(l.unitRateUsd).toNumber();
        const discountedBaseRate = unitRate * discountFactor;
        return {
          id: l.id,
          articleCode: l.articleCode,
          description: l.description,
          qty,
          unitRateUsd: unitRate,
          discountedBaseRate,
          totalBaseUsd: discountedBaseRate * qty,
          lineProportion: totalQty > 0 ? qty / totalQty : 0,
          aliasResolved: !!alias,
          stockItemId: alias?.stockItemId ?? null,
          stockItemCode: alias?.itemCode ?? null,
          stockItemName: alias?.itemName ?? null,
        };
      });

      res.json({
        lines: enriched,
        totalQty,
        discountFactor,
        discountPct: container.discountPct,
        unmappedCount: enriched.filter((l) => !l.aliasResolved).length,
      });
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if (error instanceof PostingValidationError)
        return res.status(400).json({ code: error.code, message: error.message });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  // ── Prepaid Charges ───────────────────────────────────────────────────────

  app.get("/api/sp/prepaid", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const containerId = req.query.containerId ? parseInt(req.query.containerId as string) : null;

      const conditions = [eq(spPrepaidCharges.companyId, companyId)];
      if (containerId) conditions.push(eq(spPrepaidCharges.containerId, containerId));

      const rows = await db
        .select()
        .from(spPrepaidCharges)
        .where(and(...conditions))
        .orderBy(desc(spPrepaidCharges.createdAt));

      res.json(rows);
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if (error instanceof PostingValidationError)
        return res.status(400).json({ code: error.code, message: error.message });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });

  app.post("/api/sp/prepaid", requireAuth, async (req: Request, res: Response) => {
    try {
      const companyId = await requireSpCompany(req, res);
      if (!companyId) return;

      const { containerId, prepaidDate, chargeType, agentName, amountPaidUsd, bankAccountId, debitAccountId, notes } =
        req.body;

      if (!chargeType || !amountPaidUsd) {
        return res.status(400).json({ message: "chargeType, amountPaidUsd required" });
      }

      let prepaidAcct = await getSpAccount(companyId, "sp_prepaid");
      if (!prepaidAcct) return res.status(400).json({ message: "SP accounts not set up" });

      // Allow optional debit account override — validate it belongs to this company
      if (debitAccountId) {
        const [customDebit] = await db
          .select()
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.id, parseInt(debitAccountId)),
              eq(ledgerAccounts.companyId, companyId),
              isNull(ledgerAccounts.deletedAt)
            )
          );
        if (!customDebit) return res.status(400).json({ message: "Debit account not found for this company" });
        prepaidAcct = customDebit;
      }

      // Validate bank account belongs to this company
      if (bankAccountId) {
        const [bank] = await db
          .select()
          .from(bankAccounts)
          .where(and(eq(bankAccounts.id, parseInt(bankAccountId)), eq(bankAccounts.companyId, companyId)));
        if (!bank) return res.status(400).json({ message: "Bank account not found for this company" });
      }

      const amount = (parseMoneyInput(amountPaidUsd) ?? toMoney(0)).toDecimalPlaces(2);
      const date = prepaidDate || getClientDate(req);

      const result = await db.transaction(async (tx) => {
        const [charge] = await tx
          .insert(spPrepaidCharges)
          .values({
            companyId,
            containerId: containerId ? parseInt(containerId) : null,
            prepaidDate: date,
            chargeType,
            agentName: agentName || null,
            amountPaidUsd: amount.toFixed(2),
            amountUsedUsd: "0",
            notes: notes || null,
          })
          .returning();

        const desc = `Prepaid ${chargeType}${agentName ? ` — ${agentName}` : ""} for container #${containerId}`;
        // Phase 22 (C): through the engine with the prepaid charge's identity
        // (SP-PRE- family number kept, deterministic suffix).
        const { voucher } = await postFactoryVoucherTx(tx, {
          companyId,
          voucherNumber: (generation) => `SP-PRE-${charge.id}-${generation}`,
          voucherDate: date,
          description: desc,
          sourceModule: "SP",
          source: { sourceType: "sp-prepaid-charge", sourceId: charge.id, phase: "voucher" },
          lines: [
            // Dr Prepaid Charges / Cr Bank
            { ledgerAccountId: prepaidAcct.id, debit: amount, narration: `Prepaid ${chargeType} — ${agentName || ""}` },
            ...(bankAccountId
              ? [
                  {
                    bankAccountId: parseInt(bankAccountId),
                    credit: amount,
                    narration: `Payment for prepaid ${chargeType}`,
                  },
                ]
              : []),
          ],
        });

        await tx.update(spPrepaidCharges).set({ voucherId: voucher.id }).where(eq(spPrepaidCharges.id, charge.id));

        return { ...charge, voucherId: voucher.id };
      });

      res.json(result);
    } catch (error: unknown) {
      if (sendVoucherCorrectionRefusal(res, error)) return;
      if (error instanceof PostingValidationError)
        return res.status(400).json({ code: error.code, message: error.message });
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

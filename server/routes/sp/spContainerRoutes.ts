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

      const totalUsd = parseNum(invoiceTotalUsd);
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
            invoiceTotalUsd: String(totalUsd),
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
        if (totalUsd > 0) {
          const voucherNum = `SP-OTW-${container.id}-${Date.now()}`;
          const [voucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherType: "Journal",
              voucherNumber: voucherNum,
              voucherDate: invoiceDate,
              description: `Goods OTW: ${supplierName} — Invoice ${invoiceNumber}`,
              totalAmount: String(totalUsd),
              currency: "USD",
              exchangeRate: "1",
              sourceModule: "SP",
            })
            .returning();

          await tx.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: otwAcct.id,
            debitAmount: String(totalUsd),
            creditAmount: "0",
            narration: `Goods OTW — ${supplierName} inv ${invoiceNumber}`,
          });

          await tx.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: otwClrAcct.id,
            debitAmount: "0",
            creditAmount: String(totalUsd),
            supplierId: supplierIdNum,
            narration: `OTW Clearing — ${supplierName} inv ${invoiceNumber}`,
          });

          await tx.update(spContainers).set({ goodsOtwVoucherId: voucher.id }).where(eq(spContainers.id, container.id));
        }

        return container;
      });

      res.json(result);
    } catch (error: unknown) {
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

      const [existing] = await db
        .select()
        .from(spContainers)
        .where(and(eq(spContainers.id, containerId), eq(spContainers.companyId, companyId)));
      if (!existing) return res.status(404).json({ message: "Container not found" });
      if (existing.status === "offloaded") {
        return res.status(400).json({ message: "Cannot edit an offloaded container" });
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

      const totalUsd = parseNum(invoiceTotalUsd ?? existing.invoiceTotalUsd);
      const supplierIdNum = supplierId ? parseInt(String(supplierId)) : (existing.supplierId ?? null);
      const newSupplierName = supplierName ?? existing.supplierName;
      const newInvoiceNumber = invoiceNumber ?? existing.invoiceNumber;
      const newInvoiceDate = invoiceDate ?? existing.invoiceDate;

      const otwAcct = await getSpAccount(companyId, "sp_goods_otw");
      const otwClrAcct = await getSpAccount(companyId, "sp_otw_clearing");
      if (!otwAcct || !otwClrAcct) {
        return res.status(400).json({ message: "Chart of accounts not set up" });
      }

      const updated = await db.transaction(async (tx) => {
        // Update container fields
        const [updatedContainer] = await tx
          .update(spContainers)
          .set({
            supplierId: supplierIdNum,
            supplierName: newSupplierName,
            containerNumber: containerNumber !== undefined ? containerNumber || null : existing.containerNumber,
            invoiceNumber: newInvoiceNumber,
            invoiceDate: newInvoiceDate,
            invoiceTotalUsd: String(totalUsd),
            discountPct: String(parseNum(discountPct ?? existing.discountPct)),
            freightEstimateUsd: String(parseNum(freightEstimateUsd ?? existing.freightEstimateUsd)),
            notes: notes !== undefined ? notes || null : existing.notes,
          })
          .where(and(eq(spContainers.id, containerId), eq(spContainers.companyId, companyId)))
          .returning();

        // Regenerate OTW voucher if amount or supplier changed
        if (existing.goodsOtwVoucherId && totalUsd > 0) {
          // Update voucher header
          await tx
            .update(vouchers)
            .set({
              voucherDate: newInvoiceDate,
              description: `Goods OTW: ${newSupplierName} — Invoice ${newInvoiceNumber}`,
              totalAmount: String(totalUsd),
            })
            .where(eq(vouchers.id, existing.goodsOtwVoucherId));

          // Delete old entries and recreate with updated amounts
          await tx.delete(voucherEntries).where(eq(voucherEntries.voucherId, existing.goodsOtwVoucherId));

          await tx.insert(voucherEntries).values({
            voucherId: existing.goodsOtwVoucherId,
            ledgerAccountId: otwAcct.id,
            debitAmount: String(totalUsd),
            creditAmount: "0",
            narration: `Goods OTW — ${newSupplierName} inv ${newInvoiceNumber}`,
          });

          await tx.insert(voucherEntries).values({
            voucherId: existing.goodsOtwVoucherId,
            ledgerAccountId: otwClrAcct.id,
            debitAmount: "0",
            creditAmount: String(totalUsd),
            supplierId: supplierIdNum,
            narration: `OTW Clearing — ${newSupplierName} inv ${newInvoiceNumber}`,
          });
        } else if (!existing.goodsOtwVoucherId && totalUsd > 0) {
          // Create new voucher if none existed
          const voucherNum = `SP-OTW-${containerId}-${Date.now()}`;
          const [voucher] = await tx
            .insert(vouchers)
            .values({
              companyId,
              voucherType: "Journal",
              voucherNumber: voucherNum,
              voucherDate: newInvoiceDate,
              description: `Goods OTW: ${newSupplierName} — Invoice ${newInvoiceNumber}`,
              totalAmount: String(totalUsd),
              currency: "USD",
              exchangeRate: "1",
              sourceModule: "SP",
            })
            .returning();

          await tx.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: otwAcct.id,
            debitAmount: String(totalUsd),
            creditAmount: "0",
            narration: `Goods OTW — ${newSupplierName} inv ${newInvoiceNumber}`,
          });

          await tx.insert(voucherEntries).values({
            voucherId: voucher.id,
            ledgerAccountId: otwClrAcct.id,
            debitAmount: "0",
            creditAmount: String(totalUsd),
            supplierId: supplierIdNum,
            narration: `OTW Clearing — ${newSupplierName} inv ${newInvoiceNumber}`,
          });

          await tx.update(spContainers).set({ goodsOtwVoucherId: voucher.id }).where(eq(spContainers.id, containerId));
        }

        return updatedContainer;
      });

      res.json(updated);
    } catch (error: unknown) {
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

      const discountFactor = 1 - parseFloat(container.discountPct || "0") / 100;
      const totalQty = lines.reduce((s, l) => s + parseFloat(l.qty || "0"), 0);

      const enriched = lines.map((l) => {
        const alias = aliasMap.get(l.articleCode);
        const qty = parseFloat(l.qty || "0");
        const unitRate = parseFloat(l.unitRateUsd || "0");
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

      const amount = parseNum(amountPaidUsd);
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
            amountPaidUsd: String(amount),
            amountUsedUsd: "0",
            notes: notes || null,
          })
          .returning();

        const voucherNum = `SP-PRE-${charge.id}-${Date.now()}`;
        const desc = `Prepaid ${chargeType}${agentName ? ` — ${agentName}` : ""} for container #${containerId}`;

        const [voucher] = await tx
          .insert(vouchers)
          .values({
            companyId,
            voucherType: "Journal",
            voucherNumber: voucherNum,
            voucherDate: date,
            description: desc,
            totalAmount: String(amount),
            currency: "USD",
            exchangeRate: "1",
            sourceModule: "SP",
          })
          .returning();

        // Dr Prepaid Charges
        await tx.insert(voucherEntries).values({
          voucherId: voucher.id,
          ledgerAccountId: prepaidAcct.id,
          debitAmount: String(amount),
          creditAmount: "0",
          narration: `Prepaid ${chargeType} — ${agentName || ""}`,
        });

        // Cr Bank
        if (bankAccountId) {
          await tx.insert(voucherEntries).values({
            voucherId: voucher.id,
            bankAccountId: parseInt(bankAccountId),
            debitAmount: "0",
            creditAmount: String(amount),
            narration: `Payment for prepaid ${chargeType}`,
          });
        }

        await tx.update(spPrepaidCharges).set({ voucherId: voucher.id }).where(eq(spPrepaidCharges.id, charge.id));

        return { ...charge, voucherId: voucher.id };
      });

      res.json(result);
    } catch (error: unknown) {
      res.status(500).json({ message: getErrorMessage(error) });
    }
  });
}

/**
 * chatbotRoutes: ChatbotTransaction endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { clearERPContextCache } from "../../chatService";
import {
  inventory,
  stockItems,
  vouchers,
  voucherEntries,
  suppliers,
  customers,
  locations,
  ledgerAccounts,
} from "@shared/schema";
import { eq, and, or, desc, isNull, ilike } from "drizzle-orm";
import { requireAIActionPermission, logAIAction } from "../../lib/aiActionPermission";
import { toMoney } from "../../lib/money";

export function registerChatbotTransactionRoutes(app: Express) {
  // ── Confirm Stock Transfer ────────────────────────────────────────────
  app.post("/api/chatbot/confirm-stock-transfer", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      const userId = req.session.userId;
      if (!companyId || !userId) return res.status(400).json({ message: "No company selected" });

      const denied = await requireAIActionPermission(req, "write");
      if (denied) return res.status(denied.code).json({ message: denied.message });

      const {
        date,
        sourceLocationId,
        destinationLocationId,
        notes,
        items,
        optional,
        analysisSummary,
        analysisDateRange,
      } = req.body;
      // Preserve the pre-existing direct/manual chatbot transfer behavior (real transfer,
      // inventory moves immediately) unless the caller explicitly opts into an optional
      // (AI-suggested, non-posting) transfer by sending optional:true. This keeps the
      // long-standing direct "transfer N of X from A to B" flow byte-for-byte unchanged.
      const isOptional = optional === true;

      if (!sourceLocationId || !destinationLocationId)
        return res.status(400).json({ message: "Source and destination locations are required" });
      if (!items?.length) return res.status(400).json({ message: "At least one item is required" });
      if (Number(sourceLocationId) === Number(destinationLocationId))
        return res.status(400).json({ message: "Source and destination must be different" });

      // ── Revalidate before creating anything (never trust the AI-produced numbers) ──
      const [srcLocRow, destLocRow] = await Promise.all([
        db
          .select({ id: locations.id })
          .from(locations)
          .where(and(eq(locations.id, Number(sourceLocationId)), eq(locations.companyId, companyId)))
          .limit(1),
        db
          .select({ id: locations.id })
          .from(locations)
          .where(and(eq(locations.id, Number(destinationLocationId)), eq(locations.companyId, companyId)))
          .limit(1),
      ]);
      if (!srcLocRow[0]) return res.status(404).json({ message: "Source location not found" });
      if (!destLocRow[0]) return res.status(404).json({ message: "Destination location not found" });

      for (const i of items) {
        const stockItemId = Number(i.stockItemId);
        const qty = Number(i.quantity);
        if (!stockItemId || isNaN(qty) || qty <= 0) {
          return res.status(400).json({ message: `Invalid item or quantity: ${JSON.stringify(i)}` });
        }
        const [itemRow] = await db
          .select({ id: stockItems.id })
          .from(stockItems)
          .where(and(eq(stockItems.id, stockItemId), eq(stockItems.companyId, companyId), isNull(stockItems.deletedAt)))
          .limit(1);
        if (!itemRow) return res.status(404).json({ message: `Stock item ${stockItemId} not found` });

        // Insufficient-stock enforcement only applies to AI-suggested (optional) drafts —
        // the pre-existing direct/manual chatbot transfer flow (optional:false) forwards to
        // /api/stock-transfers exactly as before, which already owns its own validation and
        // allows the same explicit negative-inventory override the manual UI supports.
        if (isOptional) {
          const [invRow] = await db
            .select({ quantity: inventory.quantity })
            .from(inventory)
            .where(
              and(
                eq(inventory.stockItemId, stockItemId),
                eq(inventory.locationId, Number(sourceLocationId)),
                eq(inventory.companyId, companyId)
              )
            )
            .limit(1);
          const currentStock = toMoney(invRow?.quantity).toNumber();
          // AI-driven confirmation must never authorize negative inventory; that override
          // stays a manual, explicit user action on the normal stock transfer screen.
          if (qty > currentStock) {
            return res.status(400).json({
              message: `Quantity ${qty} for stock item ${stockItemId} exceeds available stock (${currentStock})`,
            });
          }
        }
      }

      const resp = await fetch(`http://localhost:${process.env.PORT || 5000}/api/stock-transfers`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: req.headers.cookie || "" },
        body: JSON.stringify({
          sourceLocationId: Number(sourceLocationId),
          destinationLocationId: Number(destinationLocationId),
          notes: notes || "",
          voucherDate: date || new Date().toISOString().split("T")[0],
          optional: isOptional,
          items: items.map((i: Record<string, unknown>) => ({
            stockItemId: Number(i.stockItemId),
            quantity: String(i.quantity),
            sourceLocationId: Number(sourceLocationId),
          })),
        }),
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);

      const createdVoucherId = data.voucher?.id ?? data.voucherId ?? null;
      const createdTransferId = data.transfer?.id ?? data.id ?? null;

      // Write audit log via centralised helper
      await logAIAction({
        req,
        actionType: "write",
        actionName: "stock_transfer",
        inputJson: {
          sourceLocationId,
          destinationLocationId,
          date,
          notes,
          itemCount: items?.length ?? 0,
          optional: isOptional,
          analysisSummary: analysisSummary || null,
          analysisDateRange: analysisDateRange || null,
        },
        outputJson: { transferId: createdTransferId, voucherId: createdVoucherId },
        status: "success",
        createdRecordId: createdTransferId || createdVoucherId || null,
      });

      clearERPContextCache(companyId);
      res.json({
        success: true,
        transferId: createdTransferId,
        voucherId: createdVoucherId,
        optional: isOptional,
        voucher: data.voucher,
      });
    } catch (error: unknown) {
      logger.error("[Chatbot] confirm-stock-transfer error:", { error: getErrorMessage(error) });
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Last Transaction Lookup ──────────────────────────────────────────
  app.get("/api/chatbot/last-transaction", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const type = (req.query.type as string) || "";
      const typeFilter = ["Payment", "Receipt", "Journal"].includes(type) ? type : null;

      const rows = await db
        .select({
          id: vouchers.id,
          voucherNumber: vouchers.voucherNumber,
          voucherType: vouchers.voucherType,
          voucherDate: vouchers.voucherDate,
          description: vouchers.description,
          totalAmount: vouchers.totalAmount,
        })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            isNull(vouchers.deletedAt),
            ...(typeFilter ? [eq(vouchers.voucherType, typeFilter)] : [])
          )
        )
        .orderBy(desc(vouchers.createdAt))
        .limit(1);

      if (!rows.length) return res.json({ found: false });

      const v = rows[0];
      const entries = await db
        .select({
          ledgerAccountId: voucherEntries.ledgerAccountId,
          accountName: ledgerAccounts.name,
          debitAmount: voucherEntries.debitAmount,
          creditAmount: voucherEntries.creditAmount,
          narration: voucherEntries.narration,
        })
        .from(voucherEntries)
        .leftJoin(ledgerAccounts, eq(voucherEntries.ledgerAccountId, ledgerAccounts.id))
        .where(eq(voucherEntries.voucherId, v.id));

      res.json({ found: true, voucher: v, entries });
    } catch (_error: unknown) {
      res.status(500).json({ message: "Internal server error" });
    }
  });

  // ── Smart Search ─────────────────────────────────────────────────────
  app.get("/api/chatbot/search", requireAuth, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const denied = await requireAIActionPermission(req, "read");
      if (denied) return res.status(denied.code).json({ message: denied.message });

      const q = ((req.query.q as string) || "").trim();
      const modules = ((req.query.modules as string) || "").split(",").filter(Boolean);
      if (!q) return res.json({ results: [] });

      const searchModules = modules.length > 0 ? modules : ["vouchers", "customers", "suppliers", "items"];
      const results: unknown[] = [];

      if (searchModules.includes("vouchers")) {
        const vrows = await db
          .select({
            id: vouchers.id,
            voucherNumber: vouchers.voucherNumber,
            voucherType: vouchers.voucherType,
            voucherDate: vouchers.voucherDate,
            description: vouchers.description,
            totalAmount: vouchers.totalAmount,
          })
          .from(vouchers)
          .where(
            and(
              eq(vouchers.companyId, companyId),
              isNull(vouchers.deletedAt),
              or(ilike(vouchers.description, `%${q}%`), ilike(vouchers.voucherNumber, `%${q}%`))
            )
          )
          .orderBy(desc(vouchers.voucherDate))
          .limit(5);
        vrows.forEach((r) =>
          results.push({
            module: "Voucher",
            id: r.id,
            title: r.voucherNumber,
            subtitle: r.description || "",
            meta: `${r.voucherType} · ${r.voucherDate} · ${r.totalAmount}`,
            path: `/vouchers`,
          })
        );
      }
      if (searchModules.includes("customers")) {
        const crows = await db
          .select({ id: customers.id, name: customers.legalName, phone: customers.phone })
          .from(customers)
          .where(
            and(eq(customers.companyId, companyId), isNull(customers.deletedAt), ilike(customers.legalName, `%${q}%`))
          )
          .limit(5);
        crows.forEach((r) =>
          results.push({
            module: "Customer",
            id: r.id,
            title: r.name,
            subtitle: r.phone || "",
            meta: "Customer",
            path: `/customers`,
          })
        );
      }
      if (searchModules.includes("suppliers")) {
        const srows = await db
          .select({ id: suppliers.id, legalName: suppliers.legalName, code: suppliers.code })
          .from(suppliers)
          .where(and(isNull(suppliers.deletedAt), ilike(suppliers.legalName, `%${q}%`)))
          .limit(5);
        srows.forEach((r) =>
          results.push({
            module: "Supplier",
            id: r.id,
            title: r.legalName,
            subtitle: r.code || "",
            meta: "Supplier",
            path: `/suppliers`,
          })
        );
      }
      if (searchModules.includes("items")) {
        const irows = await db
          .select({ id: stockItems.id, name: stockItems.name, code: stockItems.code })
          .from(stockItems)
          .where(
            and(
              eq(stockItems.companyId, companyId),
              isNull(stockItems.deletedAt),
              or(ilike(stockItems.name, `%${q}%`), ilike(stockItems.code, `%${q}%`))
            )
          )
          .limit(5);
        irows.forEach((r) =>
          results.push({
            module: "Stock Item",
            id: r.id,
            title: r.name,
            subtitle: r.code || "",
            meta: "Item",
            path: `/stock-items`,
          })
        );
      }

      await logAIAction({
        req,
        actionType: "read",
        actionName: "smart_search",
        inputJson: { q, modules: searchModules },
        outputJson: { resultCount: results.length },
        status: "success",
      });

      res.json({ results });
    } catch (_error: unknown) {
      res.status(500).json({ message: "Internal server error" });
    }
  });
}

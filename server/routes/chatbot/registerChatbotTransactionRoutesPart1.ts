// Extracted from ./transactions.ts
import type { Express } from "express";
import { db } from "../../db";
import { requireAuth } from "../../auth";
import { stockItems, vouchers, voucherEntries, suppliers, customers, ledgerAccounts } from "@shared/schema";
import { eq, and, or, desc, isNull, ilike } from "drizzle-orm";
import { requireAIActionPermission, logAIAction } from "../../lib/aiActionPermission";

export function registerChatbotTransactionRoutesPart1(app: Express) {
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

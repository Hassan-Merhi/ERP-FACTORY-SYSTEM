import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
/**
 * voucherEntryRoutes: VoucherEntryByAccount endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth, requireNonPOS } from "../../auth";
import { vouchers, voucherEntries, ledgerAccounts } from "@shared/schema";
import { eq, and, desc, inArray, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { parseBoundedPagination, wantsBoundedPagination } from "../../lib/boundedPagination";

export function registerVoucherEntryByAccountRoutes(app: Express) {
  // ── ACCOUNT TRANSFER: fetch all entries for a ledger account ──
  app.get("/api/voucher-entries/by-account/:accountId", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });
      const accountId = parseInt(req.params.accountId);
      if (isNaN(accountId)) return res.status(400).json({ message: "Invalid account ID" });

      const [account] = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, accountId), eq(ledgerAccounts.companyId, companyId)));
      if (!account) return res.status(404).json({ message: "Account not found" });

      const selection = {
        id: voucherEntries.id,
        voucherId: voucherEntries.voucherId,
        narration: voucherEntries.narration,
        debitAmount: voucherEntries.debitAmount,
        creditAmount: voucherEntries.creditAmount,
        voucherNumber: vouchers.voucherNumber,
        voucherType: vouchers.voucherType,
        voucherDate: vouchers.voucherDate,
        voucherDescription: vouchers.description,
      };
      const conditions: SQL[] = [eq(voucherEntries.ledgerAccountId, accountId), eq(vouchers.companyId, companyId)];
      const search = typeof req.query.search === "string" ? req.query.search.trim().slice(0, 200) : "";
      if (search) {
        const searchCondition = or(
          punctuationInsensitiveSearch(vouchers.voucherNumber, search),
          punctuationInsensitiveSearch(vouchers.voucherType, search),
          punctuationInsensitiveSearch(vouchers.description, search),
          punctuationInsensitiveSearch(voucherEntries.narration, search)
        );
        if (searchCondition) conditions.push(searchCondition);
      }
      const where = and(...conditions);

      // Preserve the established array contract for old callers. The account
      // transfer page opts into this native database page so PostgreSQL no
      // longer materializes an account's entire history on every selection.
      if (!wantsBoundedPagination(req.query as Record<string, unknown>)) {
        const rows = await db
          .select(selection)
          .from(voucherEntries)
          .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
          .where(where)
          .orderBy(desc(vouchers.voucherDate), desc(vouchers.id));
        return res.json(rows);
      }

      const { page, limit, offset } = parseBoundedPagination(req.query as Record<string, unknown>);
      const [countRows, items] = await Promise.all([
        db
          .select({ total: sql<number>`count(*)::int` })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
          .where(where),
        db
          .select(selection)
          .from(voucherEntries)
          .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
          .where(where)
          .orderBy(desc(vouchers.voucherDate), desc(vouchers.id))
          .limit(limit)
          .offset(offset),
      ]);
      const total = countRows[0]?.total ?? 0;
      const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
      res.setHeader("Cache-Control", "private, max-age=15, stale-while-revalidate=15");
      return res.json({
        items,
        total,
        page,
        pageSize: limit,
        totalPages,
        hasNextPage: page < totalPages,
        hasPreviousPage: page > 1 && totalPages > 0,
      });
    } catch (e: unknown) {
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });

  // ── ACCOUNT TRANSFER: move selected entries to a different ledger account ──
  app.post("/api/voucher-entries/transfer-account", requireAuth, requireNonPOS, async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { entryIds, toAccountId } = z
        .object({
          entryIds: z.array(z.number().int().positive()).min(1, "Select at least one entry"),
          toAccountId: z.number().int().positive("Destination account required"),
        })
        .parse(req.body);

      const [toAccount] = await db
        .select()
        .from(ledgerAccounts)
        .where(and(eq(ledgerAccounts.id, toAccountId), eq(ledgerAccounts.companyId, companyId)));
      if (!toAccount) return res.status(404).json({ message: "Destination account not found" });

      // Verify all entries belong to the current company via their vouchers
      const entriesWithVouchers = await db
        .select({ id: voucherEntries.id, companyId: vouchers.companyId })
        .from(voucherEntries)
        .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
        .where(inArray(voucherEntries.id, entryIds));

      const unauthorised = entriesWithVouchers.filter((e) => e.companyId !== companyId);
      if (unauthorised.length > 0) {
        return res.status(403).json({ message: "Some entries do not belong to the current company" });
      }
      if (entriesWithVouchers.length !== entryIds.length) {
        return res.status(404).json({ message: "Some entries were not found" });
      }

      await db.update(voucherEntries).set({ ledgerAccountId: toAccountId }).where(inArray(voucherEntries.id, entryIds));

      res.json({ moved: entryIds.length, toAccount: toAccount.name });
    } catch (e: unknown) {
      if (e instanceof z.ZodError) return res.status(400).json({ message: e.issues.map((x) => x.message).join(", ") });
      res.status(500).json({ message: getErrorMessage(e) });
    }
  });
}

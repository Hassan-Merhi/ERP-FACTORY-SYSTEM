import { punctuationInsensitiveSearch } from "../../lib/searchNormalization";
/**
 * voucherEntryRoutes: VoucherEntryByAccount endpoints.
 *
 * Registered by ./index.ts in the original order; Express resolves
 * first-match, so that order is behaviour.
 */
import type { Express } from "express";
import { errorStatus, getErrorMessage } from "../../lib/httpHandlers";
import { db } from "../../db";
import { requireAuth, requireNonPOS, requireRole } from "../../auth";
import { vouchers, voucherEntries, ledgerAccounts, customers } from "@shared/schema";
import { eq, and, desc, inArray, isNotNull, isNull, or, sql, type SQL } from "drizzle-orm";
import { voucherMutationBlockReason } from "../../lib/migratedVoucherGuard";
import { logAudit } from "../_helpers";
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
  // Wave 16 (B): re-pointing posted lines rewrites the history of two
  // accounts, so it is Admin/Owner only (Developer passes), runs in one
  // transaction with the lines locked, checks each line's voucher against the
  // closed period, and writes its audit row in that transaction.
  app.post("/api/voucher-entries/transfer-account", requireAuth, requireRole("Admin", "Owner"), async (req, res) => {
    try {
      const companyId = req.session.currentCompanyId;
      if (!companyId) return res.status(400).json({ message: "No company selected" });

      const { entryIds, toAccountId } = z
        .object({
          entryIds: z.array(z.number().int().positive()).min(1, "Select at least one entry"),
          toAccountId: z.number().int().positive("Destination account required"),
        })
        .parse(req.body);

      const outcome = await db.transaction(async (tx) => {
        const [toAccount] = await tx
          .select()
          .from(ledgerAccounts)
          .where(
            and(
              eq(ledgerAccounts.id, toAccountId),
              eq(ledgerAccounts.companyId, companyId),
              isNull(ledgerAccounts.deletedAt)
            )
          );
        if (!toAccount) return { status: 404, message: "Destination account not found" } as const;

        // Lock the lines, then verify all of them belong to the current company via their vouchers.
        await tx
          .select({ id: voucherEntries.id })
          .from(voucherEntries)
          .where(inArray(voucherEntries.id, entryIds))
          .for("update");
        const entriesWithVouchers = await tx
          .select({
            id: voucherEntries.id,
            voucherId: voucherEntries.voucherId,
            companyId: vouchers.companyId,
            voucherNumber: vouchers.voucherNumber,
            voucherDate: vouchers.voucherDate,
            effectiveDate: vouchers.effectiveDate,
            sourceModule: vouchers.sourceModule,
            ledgerAccountId: voucherEntries.ledgerAccountId,
            customerId: voucherEntries.customerId,
            debitAmount: voucherEntries.debitAmount,
            creditAmount: voucherEntries.creditAmount,
            otherTargetCount: sql<number>`(
            (${voucherEntries.bankAccountId} IS NOT NULL)::int + (${voucherEntries.fixedAssetId} IS NOT NULL)::int +
            (${voucherEntries.supplierId} IS NOT NULL)::int + (${voucherEntries.employeeId} IS NOT NULL)::int +
            (${voucherEntries.factorySupplierId} IS NOT NULL)::int
          )`.mapWith(Number),
          })
          .from(voucherEntries)
          .innerJoin(vouchers, eq(vouchers.id, voucherEntries.voucherId))
          .where(inArray(voucherEntries.id, entryIds));

        const unauthorised = entriesWithVouchers.filter((e) => e.companyId !== companyId);
        if (unauthorised.length > 0) {
          return { status: 403, message: "Some entries do not belong to the current company" } as const;
        }
        if (entriesWithVouchers.length !== entryIds.length) {
          return { status: 404, message: "Some entries were not found" } as const;
        }
        const blocked = entriesWithVouchers
          .map((e) => voucherMutationBlockReason({ voucherNumber: e.voucherNumber, sourceModule: e.sourceModule }))
          .find(Boolean);
        if (blocked) return { status: 403, message: blocked } as const;
        // Only ledger-account lines move. Moving a supplier/employee/bank line's
        // ledger id would leave it posting to two accounts.
        if (entriesWithVouchers.some((e) => e.ledgerAccountId === null || e.otherTargetCount > 0)) {
          return { status: 400, message: "Only ledger account entries can be moved" } as const;
        }

        // Closed period: each line's voucher, on both of its dates (the same
        // check the voucher_entries trigger makes; raised here first so the
        // whole move is refused before any line changes).
        for (const voucherId of new Set(entriesWithVouchers.map((e) => e.voucherId))) {
          await tx.execute(sql`SELECT erp_assert_voucher_open(${voucherId}::integer)`);
        }

        // A customer line keeps its customer link only when the destination is
        // that same customer's account; otherwise the link is cleared so the line
        // no longer counts in that customer's statement.
        const [destinationCustomer] = await tx
          .select({ id: customers.id })
          .from(customers)
          .where(and(eq(customers.companyId, companyId), eq(customers.ledgerAccountId, toAccountId)))
          .limit(1);
        const destinationCustomerId = destinationCustomer?.id ?? null;

        await tx
          .update(voucherEntries)
          .set({ ledgerAccountId: toAccountId, customerId: destinationCustomerId })
          .where(and(inArray(voucherEntries.id, entryIds), isNotNull(voucherEntries.customerId)));
        await tx
          .update(voucherEntries)
          .set({ ledgerAccountId: toAccountId })
          .where(and(inArray(voucherEntries.id, entryIds), isNull(voucherEntries.customerId)));

        // Re-pointing posted lines changes historical balances; record exactly what moved.
        await logAudit(
          {
            userId: req.session.userId!,
            username: req.session.username || "unknown",
            companyId,
            action: "update",
            tableName: "voucher_entries",
            recordId: toAccountId,
            recordIdentifier: `transfer-account → ${toAccount.code}`,
            changes: {
              movedEntries: {
                old: entriesWithVouchers.map((e) => ({
                  entryId: e.id,
                  voucherNumber: e.voucherNumber,
                  voucherDate: e.voucherDate,
                  effectiveDate: e.effectiveDate,
                  ledgerAccountId: e.ledgerAccountId,
                  customerId: e.customerId,
                  debitAmount: e.debitAmount,
                  creditAmount: e.creditAmount,
                })),
                new: { ledgerAccountId: toAccountId, customerId: destinationCustomerId },
              },
            },
          },
          tx
        );
        return { status: 200, toAccount } as const;
      });

      if (outcome.status !== 200) return res.status(outcome.status).json({ message: outcome.message });
      res.json({ moved: entryIds.length, toAccount: outcome.toAccount.name });
    } catch (e: unknown) {
      if (e instanceof z.ZodError) return res.status(400).json({ message: e.issues.map((x) => x.message).join(", ") });
      res.status(errorStatus(e, 500)).json({ message: getErrorMessage(e) });
    }
  });
}

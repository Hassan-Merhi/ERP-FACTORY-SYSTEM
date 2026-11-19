// Extracted from ./containerHelpers.ts: a stage of containerHelpers.
import { storage } from "../../storage";
import { vouchers, voucherEntries, ledgerAccounts, companies, purchaseOrders } from "@shared/schema";
import { eq, and, or, sql, like, ilike, isNull, ne } from "drizzle-orm";
import { toMoney } from "../../lib/money";
import type { DatabaseOrTransaction, DbTransaction } from "../../db";
import type { LegacyPoJournalMatch } from "./containerHelpers";

export async function containerHelpersStep({
  verifiedParentCompanyId,
  amountStr,
  poNumbers,
  containerNumber,
  dbOrTx,
  verifiedSubsidiaryCompanyId,
  legacyPoMatch,
  tx,
}: {
  verifiedParentCompanyId: number | undefined;
  amountStr: string;
  poNumbers: string | string[];
  containerNumber: string | undefined;
  dbOrTx: DatabaseOrTransaction;
  verifiedSubsidiaryCompanyId: number | undefined;
  legacyPoMatch: LegacyPoJournalMatch | undefined;
  tx: DbTransaction;
}) {
  const parentCompanyId = verifiedParentCompanyId ?? (await storage.getParentCompanyId());
  if (!parentCompanyId) return { done: true as const, value: { found: false, updated: false, amount: amountStr } };

  const nums = Array.isArray(poNumbers) ? poNumbers.filter(Boolean) : [poNumbers];

  // Build OR condition across all provided PO number patterns.
  // Three naming conventions exist depending on which creation path was used:
  //   INTERCO-PARENT-{n}-{ts}  — storage.ts / adminRoutes.ts
  //   INTERCO-{n}-{ts}         — adminRoutes.ts (older path)
  //   IC-{childCompanyId}-{n}-{ts} — importRoutes.ts (container import flow)
  const likeConditions = nums.flatMap((n) => [
    like(vouchers.voucherNumber, `INTERCO-PARENT-${n}-%`),
    like(vouchers.voucherNumber, `INTERCO-${n}-%`),
    // The live PO importer writes IC-PO-2024-290-{timestamp}; this
    // format was missing from the edit lookup (Beira/Mali regression).
    like(vouchers.voucherNumber, `IC-${n}-%`),
    like(vouchers.voucherNumber, `IC-%-${n}-%`),
  ]);
  const patternClause = likeConditions.length === 1 ? likeConditions[0] : or(...likeConditions);

  // Locate the parent INTERCO voucher for this specific container.
  // Two description formats exist depending on which creation path was used:
  //   A) Container-based:  description starts with the container number
  //      e.g. "CAJU5262333 EUROGULF"
  //   B) PO-based:         description is generic "Inter-company credit: …"
  //      but the entry NARRATION contains "- Container EMCU7265605"
  // We try format A first (description LIKE), then fall back to format B
  // (entry narration LIKE) so both paths are handled.
  let parentVoucher: { id: number; totalAmount: string | null } | undefined;
  let recoveredUnnamedLegacy = false;
  if (containerNumber) {
    // Format A: container number in description
    const [byDesc] = await dbOrTx
      .select({ id: vouchers.id, totalAmount: vouchers.totalAmount })
      .from(vouchers)
      .where(
        and(
          eq(vouchers.companyId, parentCompanyId),
          isNull(vouchers.deletedAt),
          patternClause,
          like(vouchers.description, `%${containerNumber}%`)
        )
      )
      .limit(1);
    if (byDesc) {
      parentVoucher = byDesc;
    } else {
      // Format B: container number in entry narration
      const [byNarration] = await dbOrTx
        .select({ id: vouchers.id, totalAmount: vouchers.totalAmount })
        .from(vouchers)
        .innerJoin(voucherEntries, eq(voucherEntries.voucherId, vouchers.id))
        .where(
          and(
            eq(vouchers.companyId, parentCompanyId),
            isNull(vouchers.deletedAt),
            patternClause,
            like(voucherEntries.narration, `%${containerNumber}%`)
          )
        )
        .limit(1);
      parentVoucher = byNarration;
    }
  } else {
    const [byPo] = await dbOrTx
      .select({ id: vouchers.id, totalAmount: vouchers.totalAmount })
      .from(vouchers)
      .where(and(eq(vouchers.companyId, parentCompanyId), isNull(vouchers.deletedAt), patternClause))
      .limit(1);
    parentVoucher = byPo;
  }

  // Some older PO imports used a generic JOURNAL-{timestamp} number.
  // Only accept those when BOTH the exact container and this subsidiary's
  // named parent receivable debit are present. A generic journal must never
  // be treated as intercompany based on its amount or date alone.
  if (!parentVoucher && verifiedParentCompanyId && verifiedSubsidiaryCompanyId && containerNumber) {
    const [subsidiary] = await dbOrTx
      .select({ name: companies.name })
      .from(companies)
      .where(eq(companies.id, verifiedSubsidiaryCompanyId))
      .limit(1);
    if (subsidiary) {
      const parentCreditName = `${subsidiary.name} Credit`;
      const matchingLegacy = await dbOrTx
        .select({ id: vouchers.id, totalAmount: vouchers.totalAmount })
        .from(vouchers)
        .innerJoin(voucherEntries, eq(voucherEntries.voucherId, vouchers.id))
        .innerJoin(ledgerAccounts, eq(voucherEntries.ledgerAccountId, ledgerAccounts.id))
        .where(
          and(
            eq(vouchers.companyId, parentCompanyId),
            isNull(vouchers.deletedAt),
            like(vouchers.voucherNumber, "JOURNAL-%"),
            like(vouchers.description, `%${containerNumber}%`),
            eq(ledgerAccounts.companyId, parentCompanyId),
            ilike(ledgerAccounts.name, parentCreditName),
            sql`${voucherEntries.debitAmount} > 0`
          )
        )
        .limit(2);
      if (matchingLegacy.length > 1) {
        throw new Error(
          `Multiple legacy parent journals match container ${containerNumber}; reconcile them before editing.`
        );
      }
      parentVoucher = matchingLegacy[0];
    }
  }

  // A subset of historic manual parent journals have no PO/container
  // description or entry narration. Only the original child voucher is
  // allowed to identify one, with exact supplier, day, amount and subsidiary
  // receivable. This never creates a journal or guesses from a total alone.
  if (
    !parentVoucher &&
    verifiedParentCompanyId &&
    verifiedSubsidiaryCompanyId &&
    containerNumber &&
    legacyPoMatch &&
    Number.isInteger(legacyPoMatch.purchaseOrderId) &&
    legacyPoMatch.purchaseOrderId > 0 &&
    Number.isInteger(legacyPoMatch.supplierId) &&
    legacyPoMatch.supplierId > 0
  ) {
    const original = toMoney(legacyPoMatch.originalVoucherTotal);
    if (original.gt(0)) {
      const originalAmount = original.toFixed(2);
      const [subsidiary] = await tx
        .select({ name: companies.name })
        .from(companies)
        .where(eq(companies.id, verifiedSubsidiaryCompanyId))
        .limit(1);
      if (subsidiary) {
        const sameValueSiblings = await tx
          .select({ id: purchaseOrders.id })
          .from(purchaseOrders)
          .innerJoin(vouchers, eq(purchaseOrders.voucherId, vouchers.id))
          .where(
            and(
              eq(purchaseOrders.companyId, verifiedSubsidiaryCompanyId),
              ne(purchaseOrders.id, legacyPoMatch.purchaseOrderId),
              eq(purchaseOrders.supplierId, legacyPoMatch.supplierId),
              eq(vouchers.companyId, verifiedSubsidiaryCompanyId),
              isNull(vouchers.deletedAt),
              eq(vouchers.voucherDate, legacyPoMatch.originalVoucherDate),
              eq(vouchers.totalAmount, originalAmount)
            )
          )
          .limit(1);
        if (sameValueSiblings.length) {
          throw new Error(
            `Ambiguous unnamed parent journal for PO ${nums[0]}: another PO has the same supplier, date and amount.`
          );
        }

        const candidates = await tx
          .select({
            id: vouchers.id,
            totalAmount: vouchers.totalAmount,
            receivableAccountId: ledgerAccounts.id,
          })
          .from(vouchers)
          .innerJoin(voucherEntries, eq(voucherEntries.voucherId, vouchers.id))
          .innerJoin(ledgerAccounts, eq(ledgerAccounts.id, voucherEntries.ledgerAccountId))
          .where(
            and(
              eq(vouchers.companyId, verifiedParentCompanyId),
              isNull(vouchers.deletedAt),
              like(vouchers.voucherNumber, "JOURNAL-%"),
              or(isNull(vouchers.description), eq(vouchers.description, "")),
              eq(vouchers.voucherDate, legacyPoMatch.originalVoucherDate),
              eq(vouchers.totalAmount, originalAmount),
              eq(ledgerAccounts.companyId, verifiedParentCompanyId),
              ilike(ledgerAccounts.name, `${subsidiary.name} Credit`),
              eq(voucherEntries.debitAmount, originalAmount),
              eq(voucherEntries.creditAmount, "0")
            )
          )
          .limit(20);
        const verified = [] as typeof candidates;
        for (const candidate of candidates) {
          const lines = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, candidate.id));
          if (
            lines.length === 2 &&
            lines.every((line) => !line.narration?.trim()) &&
            lines.some(
              (line) =>
                line.ledgerAccountId === candidate.receivableAccountId &&
                !line.supplierId &&
                toMoney(line.debitAmount).eq(original) &&
                toMoney(line.creditAmount).isZero()
            ) &&
            lines.some(
              (line) =>
                line.supplierId === legacyPoMatch.supplierId &&
                !line.ledgerAccountId &&
                toMoney(line.creditAmount).eq(original) &&
                toMoney(line.debitAmount).isZero()
            )
          ) {
            verified.push(candidate);
          }
        }
        if (candidates.length >= 20 || verified.length > 1) {
          throw new Error(`Ambiguous unnamed parent journals for PO ${nums[0]}; manual reconciliation required.`);
        }
        if (verified.length === 1) {
          parentVoucher = verified[0];
          recoveredUnnamedLegacy = true;
        }
      }
    }
  }

  return { done: false as const, parentCompanyId, nums, parentVoucher, recoveredUnnamedLegacy };
}

import Decimal from "decimal.js";
import { db, type DbTransaction } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  intercompanyPosConfigs,
  companies,
  ledgerAccounts,
  vouchers,
  voucherEntries,
  type IntercompanyPosConfig,
} from "@shared/schema";
import { eq, and, sql, ilike, isNull, inArray } from "drizzle-orm";
import {
  createTenantDatabaseScope,
  getDatabaseScopeRuntimeContext,
  runWithDatabaseScopeRuntimeContext,
} from "../../services/security/databaseScopeRuntimeContext";
import { retireVouchersByNumberTx } from "../../services/accounting/voucherRetirement";

// ─── Intercompany POS ─────────────────────────────────────────────────────────
//
// A cash POS sale in a source company is mirrored as two daily running-total
// journals: INTERCO-SRC (Dr source interco / Cr cash, in the source company)
// and INTERCO-DST (Dr cash / Cr destination interco, in the destination).
//
// Every write happens in ONE transaction that holds a per-source-company
// advisory lock, so:
//   * concurrent sales serialize instead of overwriting each other's running
//     totals (the old read-modify-write lost updates), and
//   * a failure leaves neither company's journal half-written.
//
// The transaction runs with both companies authorized in the database scope.
// That authority comes from the stored intercompany_pos_configs row, which the
// tenant boundary only lets a user save with membership in both companies
// (destCompanyId is a checked secondary company). Without it, row-level
// security hid the destination company's accounts and the DST side was
// silently skipped.
//
// DST vouchers are numbered per source company. Several sources may feed one
// destination, and the old shared INTERCO-DST-<dest>-<date> voucher meant a
// recalculation for one source deleted every other source's amounts.

const INTERCO_LOCK_NAMESPACE = 74_123;
const ZERO = new Decimal(0);

function money(value: Decimal.Value | null | undefined): Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  return new Decimal(value);
}

function srcVoucherNumber(sourceCompanyId: number, date: string): string {
  return `INTERCO-SRC-${sourceCompanyId}-${date}`;
}

function dstVoucherNumber(sourceCompanyId: number, destCompanyId: number, date: string): string {
  return `INTERCO-DST-${destCompanyId}-${date}-S${sourceCompanyId}`;
}

/** The pre-fix shared DST number, still present on historical dates. */
function legacyDstVoucherNumber(destCompanyId: number, date: string): string {
  return `INTERCO-DST-${destCompanyId}-${date}`;
}

async function loadEnabledConfig(sourceCompanyId: number): Promise<IntercompanyPosConfig | null> {
  const [config] = await db
    .select()
    .from(intercompanyPosConfigs)
    .where(eq(intercompanyPosConfigs.sourceCompanyId, sourceCompanyId));
  return config && config.enabled ? config : null;
}

/**
 * Runs `work` in a transaction scoped to the source company plus the configured
 * destination, serialized per source company.
 */
async function runIntercompanyTransaction<T>(
  sourceCompanyId: number,
  config: IntercompanyPosConfig,
  work: (tx: DbTransaction) => Promise<T>
): Promise<T> {
  const current = getDatabaseScopeRuntimeContext();
  if (current?.kind === "tenant" && current.companyId !== sourceCompanyId) {
    logger.error("[IntercompanyPOS] Refused: posting company differs from the request scope", {
      sourceCompanyId,
      requestCompanyId: current.companyId,
    });
    throw new Error("intercompany_pos_scope_mismatch");
  }
  const scope = createTenantDatabaseScope(sourceCompanyId, [config.destCompanyId], "authorized-companies");
  return runWithDatabaseScopeRuntimeContext(scope, () =>
    db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${INTERCO_LOCK_NAMESPACE}, ${sourceCompanyId})`);
      return work(tx);
    })
  );
}

async function isGoldenCoastCompany(tx: DbTransaction, companyId: number): Promise<boolean> {
  // Golden Coast has its own atomic, paired HADI settlement. Letting this
  // transfer run as well credits the source cash a second time.
  const rows = await tx
    .select({ subType: ledgerAccounts.subType })
    .from(ledgerAccounts)
    .where(
      and(
        eq(ledgerAccounts.companyId, companyId),
        sql`${ledgerAccounts.subType} IN ('gc_partner_capital', 'gc_owner_capital')`,
        eq(ledgerAccounts.active, true),
        isNull(ledgerAccounts.deletedAt)
      )
    );
  const roles = new Set(rows.map((row) => row.subType));
  return roles.has("gc_partner_capital") && roles.has("gc_owner_capital");
}

async function postTransferTx(
  tx: DbTransaction,
  config: IntercompanyPosConfig,
  cashAccountId: number,
  amount: Decimal,
  date: string
): Promise<void> {
  const sourceCompanyId = config.sourceCompanyId;
  const [srcCompanyRow] = await tx
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, sourceCompanyId));
  const [dstCompanyRow] = await tx
    .select({ name: companies.name })
    .from(companies)
    .where(eq(companies.id, config.destCompanyId));
  const srcCompanyName = srcCompanyRow?.name ?? `Company ${sourceCompanyId}`;
  const dstCompanyName = dstCompanyRow?.name ?? `Company ${config.destCompanyId}`;

  const [cashAccount] = await tx
    .select({ name: ledgerAccounts.name })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.id, cashAccountId), eq(ledgerAccounts.companyId, sourceCompanyId)));
  if (!cashAccount) return;
  const cashName = cashAccount.name;

  let destCashAccounts = await tx
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.companyId, config.destCompanyId), eq(ledgerAccounts.name, cashName)));
  if (destCashAccounts.length === 0) {
    destCashAccounts = await tx
      .select({ id: ledgerAccounts.id })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, config.destCompanyId), ilike(ledgerAccounts.name, cashName)));
  }
  const destCashAccount = destCashAccounts[0] ?? null;

  // Source voucher: Dr source interco / Cr cash. Skipped for SP companies so
  // Cash in Net Position is not reduced; only the destination side is needed.
  if (!config.skipSourceVoucher) {
    await addToRunningTotalVoucherTx(tx, {
      companyId: sourceCompanyId,
      voucherNumber: srcVoucherNumber(sourceCompanyId, date),
      date,
      narration: `Cash transferred to ${dstCompanyName} – ${date}`,
      totalAccountId: config.sourceIntercoAccountId,
      totalSide: "debit",
      lineAccountId: cashAccountId,
      amount,
    });
  }

  if (destCashAccount) {
    await addToRunningTotalVoucherTx(tx, {
      companyId: config.destCompanyId,
      voucherNumber: dstVoucherNumber(sourceCompanyId, config.destCompanyId, date),
      date,
      narration: `Cash received from ${srcCompanyName} – ${date}`,
      totalAccountId: config.destIntercoAccountId,
      totalSide: "credit",
      lineAccountId: destCashAccount.id,
      amount,
    });
  } else {
    logger.warn(
      `[IntercompanyPOS] Could not find cash account "${cashName}" in company ${config.destCompanyId}. Dest voucher skipped.`
    );
  }
}

/**
 * Adds `amount` to a daily running-total journal: one line per cash account on
 * `lineAccountId`'s side and a single balancing line on `totalAccountId` that
 * always equals the sum of the other lines. Must run under the interco lock.
 */
async function addToRunningTotalVoucherTx(
  tx: DbTransaction,
  opts: {
    companyId: number;
    voucherNumber: string;
    date: string;
    narration: string;
    totalAccountId: number;
    totalSide: "debit" | "credit";
    lineAccountId: number;
    amount: Decimal;
  }
): Promise<void> {
  const { companyId, voucherNumber, date, narration, totalAccountId, totalSide, lineAccountId, amount } = opts;
  const lineSide = totalSide === "debit" ? "credit" : "debit";
  const amountText = amount.toFixed(2);
  const sideValues = (side: "debit" | "credit", value: string) =>
    side === "debit" ? { debitAmount: value, creditAmount: "0" } : { debitAmount: "0", creditAmount: value };
  const sideAmount = (entry: typeof voucherEntries.$inferSelect, side: "debit" | "credit") =>
    money(side === "debit" ? entry.debitAmount : entry.creditAmount);

  const [existing] = await tx
    .select()
    .from(vouchers)
    .where(and(eq(vouchers.companyId, companyId), eq(vouchers.voucherNumber, voucherNumber)));

  if (!existing) {
    const [created] = await tx
      .insert(vouchers)
      .values({
        companyId,
        voucherNumber,
        voucherType: "Journal",
        description: narration,
        voucherDate: date,
        totalAmount: amountText,
        sourceModule: "ERP",
      })
      .returning();
    await tx.insert(voucherEntries).values([
      { voucherId: created.id, ledgerAccountId: totalAccountId, ...sideValues(totalSide, amountText), narration },
      { voucherId: created.id, ledgerAccountId: lineAccountId, ...sideValues(lineSide, amountText), narration },
    ]);
    return;
  }

  const entries = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, existing.id));
  const lineEntry = entries.find(
    (entry) => entry.ledgerAccountId === lineAccountId && sideAmount(entry, lineSide).gt(ZERO)
  );
  if (lineEntry) {
    await tx
      .update(voucherEntries)
      .set(sideValues(lineSide, sideAmount(lineEntry, lineSide).plus(amount).toFixed(2)))
      .where(eq(voucherEntries.id, lineEntry.id));
  } else {
    await tx.insert(voucherEntries).values({
      voucherId: existing.id,
      ledgerAccountId: lineAccountId,
      ...sideValues(lineSide, amountText),
      narration,
    });
  }

  const refreshed = await tx.select().from(voucherEntries).where(eq(voucherEntries.voucherId, existing.id));
  const total = refreshed
    .filter((entry) => entry.ledgerAccountId !== totalAccountId)
    .reduce((sum, entry) => sum.plus(sideAmount(entry, lineSide)), ZERO);
  const totalText = total.toFixed(2);
  const totalEntry = refreshed.find(
    (entry) => entry.ledgerAccountId === totalAccountId && sideAmount(entry, totalSide).gt(ZERO)
  );
  if (totalEntry) {
    await tx.update(voucherEntries).set(sideValues(totalSide, totalText)).where(eq(voucherEntries.id, totalEntry.id));
  } else {
    await tx.insert(voucherEntries).values({
      voucherId: existing.id,
      ledgerAccountId: totalAccountId,
      ...sideValues(totalSide, totalText),
      narration,
    });
  }
  await tx.update(vouchers).set({ description: narration, totalAmount: totalText }).where(eq(vouchers.id, existing.id));
}

/**
 * Retires the running-total journal before a rebuild (wave 16 A): soft delete,
 * audited, its number and posting identity released; it used to be
 * hard-deleted with no audit.
 */
async function deleteVoucherByNumberTx(tx: DbTransaction, companyId: number, voucherNumber: string): Promise<void> {
  await retireVouchersByNumberTx(tx, {
    companyId,
    voucherNumbers: [voucherNumber],
    reason: "intercompany-pos-mirror-rebuild",
  });
}

/**
 * Mirrors one cash POS sale into the intercompany journals. Called after the
 * sale commits; never throws (a sale must not fail on its mirror), but the
 * mirror is all-or-nothing and `recalculateIntercompanyForDate` rebuilds it.
 * Resolves true when the mirror is posted or not applicable.
 */
export async function runIntercompanyPosTransfer(
  sourceCompanyId: number,
  cashAccountId: number,
  saleAmount: number,
  saleDateStr: string
): Promise<boolean> {
  try {
    const amount = money(saleAmount).toDecimalPlaces(2);
    if (!amount.gt(ZERO)) return true;
    const config = await loadEnabledConfig(sourceCompanyId);
    if (!config) return true;

    await runIntercompanyTransaction(sourceCompanyId, config, async (tx) => {
      if (await isGoldenCoastCompany(tx, sourceCompanyId)) return;
      await postTransferTx(tx, config, cashAccountId, amount, saleDateStr);
    });
    return true;
  } catch (err: unknown) {
    logger.error("[IntercompanyPOS] Auto-transfer failed; nothing was posted. Recalculate the date to rebuild it.", {
      sourceCompanyId,
      saleDate: saleDateStr,
      error: getErrorMessage(err) ?? err,
    });
    return false;
  }
}

// ─── Recalculate Intercompany POS for a specific date ─────────────────────────
// Rebuilds this source company's INTERCO-SRC/DST vouchers for the date from all
// non-deleted cash Sales vouchers, atomically and under the same lock as live
// sales. Never throws; resolves false when the rebuild failed and was rolled
// back (the previous journals are then left untouched).
export async function recalculateIntercompanyForDate(companyId: number, date: string): Promise<boolean> {
  try {
    const config = await loadEnabledConfig(companyId);
    if (!config) return true;

    await runIntercompanyTransaction(companyId, config, async (tx) => {
      if (await isGoldenCoastCompany(tx, companyId)) return;

      await deleteVoucherByNumberTx(tx, companyId, srcVoucherNumber(companyId, date));
      await deleteVoucherByNumberTx(tx, config.destCompanyId, dstVoucherNumber(companyId, config.destCompanyId, date));

      // The pre-fix shared DST voucher can only be rebuilt from this source
      // when no other source feeds the same destination; otherwise it holds
      // their amounts too and is left as it is.
      const otherSources = await tx
        .select({ id: intercompanyPosConfigs.id })
        .from(intercompanyPosConfigs)
        .where(
          and(
            eq(intercompanyPosConfigs.destCompanyId, config.destCompanyId),
            sql`${intercompanyPosConfigs.sourceCompanyId} <> ${companyId}`
          )
        );
      if (otherSources.length === 0) {
        await deleteVoucherByNumberTx(tx, config.destCompanyId, legacyDstVoucherNumber(config.destCompanyId, date));
      } else {
        logger.warn("[IntercompanyPOS Recalc] Shared legacy DST voucher left unchanged", {
          sourceCompanyId: companyId,
          destCompanyId: config.destCompanyId,
          date,
        });
      }

      const daySales = await tx
        .select({ id: vouchers.id })
        .from(vouchers)
        .where(
          and(
            eq(vouchers.companyId, companyId),
            eq(vouchers.voucherType, "Sales"),
            eq(vouchers.voucherDate, date),
            isNull(vouchers.deletedAt)
          )
        );
      if (daySales.length === 0) return;

      const cashDebits = await tx
        .select({
          ledgerAccountId: voucherEntries.ledgerAccountId,
          debitAmount: voucherEntries.debitAmount,
        })
        .from(voucherEntries)
        .innerJoin(ledgerAccounts, eq(voucherEntries.ledgerAccountId, ledgerAccounts.id))
        .where(
          and(
            inArray(
              voucherEntries.voucherId,
              daySales.map((sale) => sale.id)
            ),
            eq(ledgerAccounts.accountType, "Cash"),
            sql`${voucherEntries.debitAmount}::numeric > 0`
          )
        )
        .orderBy(voucherEntries.id);

      for (const entry of cashDebits) {
        if (!entry.ledgerAccountId) continue;
        await postTransferTx(tx, config, entry.ledgerAccountId, money(entry.debitAmount), date);
      }
    });
    return true;
  } catch (err: unknown) {
    logger.error("[IntercompanyPOS Recalc] Error; rebuild rolled back.", {
      companyId,
      date,
      error: getErrorMessage(err) ?? err,
    });
    return false;
  }
}

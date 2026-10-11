import Decimal from "decimal.js";
import { db, type DbTransaction } from "../../db";
import { getErrorMessage } from "../../lib/httpHandlers";
import { logger } from "../../lib/logger";
import {
  accountingPostingRequests,
  intercompanyAccountLinks,
  intercompanyPosConfigs,
  companies,
  ledgerAccounts,
  vouchers,
  voucherEntries,
  type IntercompanyPosConfig,
} from "@shared/schema";
import { eq, and, sql, isNull, inArray } from "drizzle-orm";
import {
  createTenantDatabaseScope,
  getDatabaseScopeRuntimeContext,
  runWithDatabaseScopeRuntimeContext,
} from "../../services/security/databaseScopeRuntimeContext";
import { retireVouchersByNumberTx, retireVouchersTx } from "../../services/accounting/voucherRetirement";
import { pairLines, postErpVoucherTx } from "../../services/accounting/erpVoucherPosting";
import {
  getCompanyRequestRuntimeContext,
  runWithCompanyRequestRuntimeContext,
} from "../../services/security/companyRequestRuntimeContext";

// ─── Intercompany POS ─────────────────────────────────────────────────────────
//
// Phase 22 (B), D7: a cash POS sale in a source company is mirrored as ONE
// journal per sale in each company, posted through the central engine:
//   source:      Dr source interco / Cr cash             (unless skipSourceVoucher)
//   destination: Dr destination cash / Cr destination interco
// Each journal's posting identity is the sale (and its cash account), so a
// replay posts nothing twice; numbers are allocated by the engine. The daily
// running-total journals (INTERCO-SRC-<company>-<date>, INTERCO-DST-…) that
// used to be re-written on every sale are no longer posted; a rebuild of a date
// retires them (and the per-sale journals) and posts one journal per sale.
//
// The destination cash account is the CONFIGURED one: the active
// intercompany_account_links row from the source cash account to the
// destination company (decided by default, owner can override; it used to be
// found by name). Without a link the destination side is not posted and the
// mirror reports it.
//
// Every write happens in ONE transaction that holds a per-source-company
// advisory lock, with both companies authorized in the database scope. That
// authority comes from the stored intercompany_pos_configs row, which the
// tenant boundary only lets a user save with membership in both companies.

const INTERCO_LOCK_NAMESPACE = 74_123;
const ZERO = new Decimal(0);
export const INTERCO_POS_SOURCE_TYPE = "intercompany-pos-src";
export const INTERCO_POS_DEST_TYPE = "intercompany-pos-dst";

function money(value: Decimal.Value | null | undefined): Decimal {
  if (value === null || value === undefined || value === "") return ZERO;
  return new Decimal(value);
}

/** The pre-phase-22 daily running-total numbers, still present on historical dates. */
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
  const run = () =>
    runWithDatabaseScopeRuntimeContext(scope, () =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(${INTERCO_LOCK_NAMESPACE}, ${sourceCompanyId})`);
        return work(tx);
      })
    );
  // The engine asserts each company's transaction scope against the request:
  // the destination is authorized by the stored configuration (above).
  const request = getCompanyRequestRuntimeContext();
  if (!request) return run();
  const authorizedCompanyIds = [...new Set([...(request.authorizedCompanyIds ?? []), config.destCompanyId])];
  return runWithCompanyRequestRuntimeContext({ ...request, authorizedCompanyIds }, run);
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

/** The configured destination cash account for a source cash account (no name lookup). */
async function linkedDestinationCashAccountTx(
  tx: DbTransaction,
  config: IntercompanyPosConfig,
  cashAccountId: number
): Promise<number | null> {
  const [link] = await tx
    .select({ destLedgerAccountId: intercompanyAccountLinks.destLedgerAccountId })
    .from(intercompanyAccountLinks)
    .innerJoin(
      ledgerAccounts,
      and(
        eq(ledgerAccounts.id, intercompanyAccountLinks.destLedgerAccountId),
        eq(ledgerAccounts.companyId, config.destCompanyId),
        isNull(ledgerAccounts.deletedAt)
      )
    )
    .where(
      and(
        eq(intercompanyAccountLinks.sourceCompanyId, config.sourceCompanyId),
        eq(intercompanyAccountLinks.sourceLedgerAccountId, cashAccountId),
        eq(intercompanyAccountLinks.destCompanyId, config.destCompanyId),
        eq(intercompanyAccountLinks.active, true)
      )
    )
    .orderBy(intercompanyAccountLinks.id)
    .limit(1);
  return link?.destLedgerAccountId ?? null;
}

export interface IntercompanyPosSale {
  saleVoucherId: number;
  cashAccountId: number;
  amount: Decimal;
  date: string;
}

/** Posts the mirror journals of one sale (both companies) in `tx`. */
async function postSaleMirrorTx(tx: DbTransaction, config: IntercompanyPosConfig, sale: IntercompanyPosSale) {
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
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.id, sale.cashAccountId), eq(ledgerAccounts.companyId, sourceCompanyId)));
  if (!cashAccount) return;
  const saleKey = `${sale.saleVoucherId}:${sale.cashAccountId}`;

  // Source voucher: Dr source interco / Cr cash. Skipped for SP companies so
  // Cash in Net Position is not reduced; only the destination side is needed.
  if (!config.skipSourceVoucher) {
    const narration = `Cash transferred to ${dstCompanyName} – ${sale.date}`;
    await postErpVoucherTx(tx, {
      companyId: sourceCompanyId,
      voucherType: "Journal",
      voucherDate: sale.date,
      description: narration,
      lines: pairLines(
        { ledgerAccountId: config.sourceIntercoAccountId },
        { ledgerAccountId: sale.cashAccountId },
        sale.amount,
        narration
      ),
      source: { type: INTERCO_POS_SOURCE_TYPE, id: saleKey },
    });
  }

  const destCashAccountId = await linkedDestinationCashAccountTx(tx, config, sale.cashAccountId);
  if (!destCashAccountId) {
    logger.warn(
      `[IntercompanyPOS] No intercompany account link from cash account ${sale.cashAccountId} to company ${config.destCompanyId}. Dest voucher skipped.`
    );
    return;
  }
  const narration = `Cash received from ${srcCompanyName} – ${sale.date}`;
  await postErpVoucherTx(tx, {
    companyId: config.destCompanyId,
    voucherType: "Journal",
    voucherDate: sale.date,
    description: narration,
    lines: pairLines(
      { ledgerAccountId: destCashAccountId },
      { ledgerAccountId: config.destIntercoAccountId },
      sale.amount,
      narration
    ),
    source: { type: INTERCO_POS_DEST_TYPE, id: `${sourceCompanyId}:${saleKey}` },
  });
}

/** Live per-sale mirror journals of the source's sales dated `date`, in both companies. */
async function saleMirrorVoucherIdsTx(
  tx: DbTransaction,
  config: IntercompanyPosConfig,
  date: string
): Promise<{ companyId: number; voucherId: number }[]> {
  const rows = await tx
    .select({ companyId: vouchers.companyId, voucherId: vouchers.id })
    .from(accountingPostingRequests)
    .innerJoin(vouchers, eq(vouchers.id, accountingPostingRequests.voucherId))
    .where(
      and(
        isNull(vouchers.deletedAt),
        eq(vouchers.voucherDate, date),
        sql`(
          (${accountingPostingRequests.companyId} = ${config.sourceCompanyId}
             AND ${accountingPostingRequests.sourceType} = ${INTERCO_POS_SOURCE_TYPE})
          OR (${accountingPostingRequests.companyId} = ${config.destCompanyId}
             AND ${accountingPostingRequests.sourceType} = ${INTERCO_POS_DEST_TYPE}
             AND ${accountingPostingRequests.sourceId} LIKE ${`${config.sourceCompanyId}:%`})
        )`
      )
    );
  return rows.map((row) => ({ companyId: Number(row.companyId), voucherId: Number(row.voucherId) }));
}

/**
 * Retires a pre-phase-22 running-total journal (and, on a rebuild, the
 * per-sale journals): soft delete, audited, number and posting identity
 * released (wave 16 A).
 */
async function deleteVoucherByNumberTx(tx: DbTransaction, companyId: number, voucherNumber: string): Promise<void> {
  await retireVouchersByNumberTx(tx, {
    companyId,
    voucherNumbers: [voucherNumber],
    reason: "intercompany-pos-mirror-rebuild",
  });
}

/**
 * Mirrors one cash POS sale into the intercompany journals (one per company).
 * Called after the sale commits; never throws (a sale must not fail on its
 * mirror), but the mirror is all-or-nothing and `recalculateIntercompanyForDate`
 * rebuilds it. Resolves true when the mirror is posted or not applicable.
 */
export async function runIntercompanyPosTransfer(
  sourceCompanyId: number,
  cashAccountId: number,
  saleAmount: Decimal.Value,
  saleDateStr: string,
  saleVoucherId: number
): Promise<boolean> {
  try {
    const amount = money(saleAmount).toDecimalPlaces(2);
    if (!amount.gt(ZERO)) return true;
    const config = await loadEnabledConfig(sourceCompanyId);
    if (!config) return true;

    await runIntercompanyTransaction(sourceCompanyId, config, async (tx) => {
      if (await isGoldenCoastCompany(tx, sourceCompanyId)) return;
      await postSaleMirrorTx(tx, config, { saleVoucherId, cashAccountId, amount, date: saleDateStr });
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
      for (const mirror of await saleMirrorVoucherIdsTx(tx, config, date)) {
        await retireVouchersTx(tx, {
          companyId: mirror.companyId,
          voucherIds: [mirror.voucherId],
          reason: "intercompany-pos-mirror-rebuild",
        });
      }

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
          voucherId: voucherEntries.voucherId,
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

      // One mirror per sale and cash account (a sale's cash lines summed).
      const bySale = new Map<string, IntercompanyPosSale>();
      for (const entry of cashDebits) {
        if (!entry.ledgerAccountId) continue;
        const key = `${entry.voucherId}:${entry.ledgerAccountId}`;
        const sale = bySale.get(key) ?? {
          saleVoucherId: entry.voucherId,
          cashAccountId: entry.ledgerAccountId,
          amount: ZERO,
          date,
        };
        sale.amount = sale.amount.plus(money(entry.debitAmount));
        bySale.set(key, sale);
      }
      for (const sale of bySale.values()) {
        if (sale.amount.gt(ZERO)) await postSaleMirrorTx(tx, config, sale);
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

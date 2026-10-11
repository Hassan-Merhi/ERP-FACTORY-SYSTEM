/**
 * Intercompany links of the group net position (accounting audit wave 13,
 * owner decision 1: paired elimination).
 *
 * An intercompany balance is eliminated only against its counterpart in the
 * other group company; whatever does not match stays visible as an
 * "Intercompany difference" line. Accounts are recognised from what the
 * system itself records, never from a name or code pattern:
 *
 *   - inter_company_transfers (phase 26, MC-1): the intercompany account each
 *     leg posted against, recorded on the link (from_ic_account_id in the
 *     from company, to_ic_account_id in the to company). A link written before
 *     phase 26 has no ids: its leg's account other than the cash account the
 *     link names is used (the IC-TO-/IC-FROM- or TRANSFER-CLEARING line).
 *     The cash accounts themselves are never intercompany accounts (they used
 *     to be taken as such, so group elimination removed cash);
 *   - intercompany_pos_configs: source_interco_account_id (source company)
 *     with the destination company, dest_interco_account_id (destination)
 *     with the source company;
 *   - the parent-credit pair the PO import posts, BY ID (phase 26, MC-9): a
 *     subsidiary's company_settings.parent_credit_account_id with its parent,
 *     and in the parent the receivable recorded in the subsidiary's
 *     company_settings.parent_receivable_account_id (the PO import writes it;
 *     it used to be found by the name "<subsidiary> Credit");
 *   - every ledger account typed Intercompany (the classifier's party type),
 *     whose counterpart is unknown when no link above names it.
 *
 * Each read runs for one company at a time, inside that company's own scope
 * (the caller wraps it), so no cross-company query is needed.
 */
import { and, eq, inArray, isNull, or } from "drizzle-orm";
import {
  companySettings,
  interCompanyTransfers,
  intercompanyPosConfigs,
  ledgerAccounts,
  voucherEntries,
} from "@shared/schema";

import { db } from "../db";
import { toMoney } from "../lib/money";
import { canonicalAccountType } from "../services/accounting/accountClassification";
import { getPartyBalances } from "../services/accounting/balances/ledgerBalanceEngine";
import { storage } from "../storage";

export type IntercompanyLinkSource = "transfer" | "posConfig" | "parentCredit" | "intercompanyType";

export interface IntercompanyAccount {
  companyId: number;
  accountId: number;
  accountName: string;
  /** The other company of each link naming the account (empty: no counterpart recorded). */
  counterpartyCompanyIds: number[];
  sources: IntercompanyLinkSource[];
  /** Ledger balance as of the date, historical USD base, debit positive (receivable positive). */
  balance: string;
}

interface CompanyLike {
  id: number;
  name: string;
  parentCompanyId?: number | null;
}

/** The parent-side receivable of each direct subsidiary, by the id in the subsidiary's settings. */
async function loadChildParentReceivables(
  companyId: number,
  allCompanies: readonly CompanyLike[]
): Promise<{ childCompanyId: number; receivableAccountId: number | null }[]> {
  const childIds = allCompanies.filter((child) => Number(child.parentCompanyId) === companyId).map((c) => c.id);
  if (childIds.length === 0) return [];
  const rows = await db
    .select({
      companyId: companySettings.companyId,
      parentReceivableAccountId: companySettings.parentReceivableAccountId,
    })
    .from(companySettings)
    .where(inArray(companySettings.companyId, childIds));
  return rows.map((row) => ({ childCompanyId: row.companyId, receivableAccountId: row.parentReceivableAccountId }));
}

/** The intercompany accounts of one company and their balances (run inside the company's scope). */
export async function loadCompanyIntercompanyAccounts(
  company: CompanyLike,
  allCompanies: readonly CompanyLike[],
  asOfDate: string
): Promise<IntercompanyAccount[]> {
  const companyId = company.id;
  const links = new Map<number, { counterparties: Set<number>; sources: Set<IntercompanyLinkSource> }>();
  const link = (accountId: number | null | undefined, counterparty: number | null, source: IntercompanyLinkSource) => {
    if (!accountId || !Number.isInteger(accountId)) return;
    const entry = links.get(accountId) ?? { counterparties: new Set<number>(), sources: new Set() };
    if (counterparty !== null && counterparty !== companyId) entry.counterparties.add(counterparty);
    entry.sources.add(source);
    links.set(accountId, entry);
  };

  const [transfers, posConfigs, settings, accounts, childSettings] = await Promise.all([
    db
      .select({
        fromCompanyId: interCompanyTransfers.fromCompanyId,
        toCompanyId: interCompanyTransfers.toCompanyId,
        fromLedgerAccountId: interCompanyTransfers.fromLedgerAccountId,
        toLedgerAccountId: interCompanyTransfers.toLedgerAccountId,
        fromVoucherId: interCompanyTransfers.fromVoucherId,
        toVoucherId: interCompanyTransfers.toVoucherId,
        fromIcAccountId: interCompanyTransfers.fromIcAccountId,
        toIcAccountId: interCompanyTransfers.toIcAccountId,
      })
      .from(interCompanyTransfers)
      .where(
        and(
          or(eq(interCompanyTransfers.fromCompanyId, companyId), eq(interCompanyTransfers.toCompanyId, companyId)),
          isNull(interCompanyTransfers.deletedAt)
        )
      ),
    db
      .select()
      .from(intercompanyPosConfigs)
      .where(
        or(eq(intercompanyPosConfigs.sourceCompanyId, companyId), eq(intercompanyPosConfigs.destCompanyId, companyId))
      ),
    storage.getCompanySettings(companyId),
    db
      .select({ id: ledgerAccounts.id, name: ledgerAccounts.name, accountType: ledgerAccounts.accountType })
      .from(ledgerAccounts)
      .where(and(eq(ledgerAccounts.companyId, companyId), isNull(ledgerAccounts.deletedAt))),
    loadChildParentReceivables(companyId, allCompanies),
  ]);

  // Legacy links (no recorded intercompany account): the leg's non-cash account.
  const legacyLegs = new Map<number, { cashAccountId: number; counterparty: number }>();
  for (const transfer of transfers) {
    if (transfer.fromCompanyId === companyId) {
      if (transfer.fromIcAccountId) link(transfer.fromIcAccountId, transfer.toCompanyId, "transfer");
      else if (transfer.fromVoucherId) {
        legacyLegs.set(transfer.fromVoucherId, {
          cashAccountId: transfer.fromLedgerAccountId,
          counterparty: transfer.toCompanyId,
        });
      }
    }
    if (transfer.toCompanyId === companyId) {
      if (transfer.toIcAccountId) link(transfer.toIcAccountId, transfer.fromCompanyId, "transfer");
      else if (transfer.toVoucherId) {
        legacyLegs.set(transfer.toVoucherId, {
          cashAccountId: transfer.toLedgerAccountId,
          counterparty: transfer.fromCompanyId,
        });
      }
    }
  }
  if (legacyLegs.size > 0) {
    const legLines = await db
      .select({ voucherId: voucherEntries.voucherId, ledgerAccountId: voucherEntries.ledgerAccountId })
      .from(voucherEntries)
      .where(inArray(voucherEntries.voucherId, [...legacyLegs.keys()]));
    for (const line of legLines) {
      const leg = legacyLegs.get(line.voucherId);
      if (!leg || !line.ledgerAccountId || line.ledgerAccountId === leg.cashAccountId) continue;
      link(line.ledgerAccountId, leg.counterparty, "transfer");
    }
  }
  for (const config of posConfigs) {
    if (config.sourceCompanyId === companyId) link(config.sourceIntercoAccountId, config.destCompanyId, "posConfig");
    if (config.destCompanyId === companyId) link(config.destIntercoAccountId, config.sourceCompanyId, "posConfig");
  }
  if (company.parentCompanyId) {
    link(Number(settings?.parentCreditAccountId) || null, company.parentCompanyId, "parentCredit");
  }
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  for (const child of childSettings) link(child.receivableAccountId, child.childCompanyId, "parentCredit");
  for (const account of accounts) {
    if (canonicalAccountType(account.accountType) === "Intercompany") link(account.id, null, "intercompanyType");
  }

  // Only this company's own accounts (a configured id in another company is not its account).
  const ids = [...links.keys()].filter((id) => accountById.has(id));
  if (ids.length === 0) return [];
  const { parties } = await getPartyBalances(db, { companyId, kind: "ledger", ids, asOf: asOfDate });
  const balanceById = new Map(parties.map((party) => [party.id, party.historicalBaseClosing]));
  return ids.map((accountId) => {
    const entry = links.get(accountId)!;
    return {
      companyId,
      accountId,
      accountName: accountById.get(accountId)?.name ?? `Account #${accountId}`,
      counterpartyCompanyIds: [...entry.counterparties].sort((a, b) => a - b),
      sources: [...entry.sources],
      balance: toMoney(balanceById.get(accountId) ?? 0).toFixed(2),
    };
  });
}

/** Ids of ledger accounts in a group (used to drop them from the company lines). */
export function intercompanyAccountIds(accounts: readonly IntercompanyAccount[]): Set<number> {
  return new Set(accounts.map((account) => account.accountId));
}

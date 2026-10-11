/**
 * Intercompany links of the group net position (accounting audit wave 13,
 * owner decision 1: paired elimination).
 *
 * An intercompany balance is eliminated only against its counterpart in the
 * other group company; whatever does not match stays visible as an
 * "Intercompany difference" line. Accounts are recognised from what the
 * system itself records, never from a name or code pattern:
 *
 *   - inter_company_transfers: the from-company's from_ledger_account_id is
 *     its account with the to-company, and the reverse;
 *   - intercompany_pos_configs: source_interco_account_id (source company)
 *     with the destination company, dest_interco_account_id (destination)
 *     with the source company;
 *   - the parent-credit pair the PO import posts: a subsidiary's configured
 *     company_settings.parent_credit_account_id with its parent, and in the
 *     parent the receivable the PO import itself finds or creates for that
 *     subsidiary, the account named exactly "<subsidiary name> Credit"
 *     (routes/import/po-import.ts looks it up by that name in the parent);
 *   - every ledger account typed Intercompany (the classifier's party type),
 *     whose counterpart is unknown when no link above names it.
 *
 * Each read runs for one company at a time, inside that company's own scope
 * (the caller wraps it), so no cross-company query is needed.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { interCompanyTransfers, intercompanyPosConfigs, ledgerAccounts } from "@shared/schema";

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

  const [transfers, posConfigs, settings, accounts] = await Promise.all([
    db
      .selectDistinct({
        fromCompanyId: interCompanyTransfers.fromCompanyId,
        toCompanyId: interCompanyTransfers.toCompanyId,
        fromLedgerAccountId: interCompanyTransfers.fromLedgerAccountId,
        toLedgerAccountId: interCompanyTransfers.toLedgerAccountId,
      })
      .from(interCompanyTransfers)
      .where(or(eq(interCompanyTransfers.fromCompanyId, companyId), eq(interCompanyTransfers.toCompanyId, companyId))),
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
  ]);

  for (const transfer of transfers) {
    if (transfer.fromCompanyId === companyId) link(transfer.fromLedgerAccountId, transfer.toCompanyId, "transfer");
    if (transfer.toCompanyId === companyId) link(transfer.toLedgerAccountId, transfer.fromCompanyId, "transfer");
  }
  for (const config of posConfigs) {
    if (config.sourceCompanyId === companyId) link(config.sourceIntercoAccountId, config.destCompanyId, "posConfig");
    if (config.destCompanyId === companyId) link(config.destIntercoAccountId, config.sourceCompanyId, "posConfig");
  }
  if (company.parentCompanyId) {
    link(Number(settings?.parentCreditAccountId) || null, company.parentCompanyId, "parentCredit");
  }
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  const accountIdByName = new Map(accounts.map((account) => [account.name, account.id]));
  for (const child of allCompanies) {
    if (Number(child.parentCompanyId) !== companyId) continue;
    link(accountIdByName.get(`${child.name} Credit`), child.id, "parentCredit");
  }
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

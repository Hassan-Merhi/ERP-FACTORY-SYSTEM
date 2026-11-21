/**
 * The party lines of every net position report, on the one balance engine
 * (accounting audit wave 10).
 *
 * The live ERP net position (/api/stats/net-profit), its Excel export
 * (/api/stats/net-position-excel), the dated snapshot (calculateNetPositionAsOf:
 * monthly Excel, schedulers, WhatsApp) and the factory net position
 * (/api/factory/net-position) used to compute customers, suppliers and
 * employees with their own SQL, from operational tables
 * (customer_orders, customer_balances, factory containers and payments) or
 * from the employees.current_balance cache. They now all read the engine:
 *
 *   - customers, ERP suppliers, factory suppliers and employees are the
 *     engine's parties as of the date (effective-date basis, master opening
 *     with its side, mixed lines netted, each line counted once);
 *   - the figure is the engine's historical-base closing (base amounts where
 *     stored, debit/credit otherwise — the basis net position always used for
 *     the ledger accounts), so a party line equals the engine figure exactly;
 *   - ledger accounts a customer owns are returned in `customerLedgerIds` so
 *     the ledger classification leaves them out (the engine rolls them into the
 *     customer: they are never counted twice);
 *   - bank accounts (bank_accounts master rows, wave 10 part 3) are the
 *     engine's "bank" rows: the bank's own opening with its side plus the lines
 *     that name the bank and no ledger account, presented like a Cash/Bank
 *     ledger account (category "Bank": an asset, or a liability when
 *     overdrawn), labelled by the bank account's name and carrying
 *     `bankAccountId`. A line that names both a ledger account and a bank
 *     belongs to the ledger account (engine priority), which the ledger
 *     classification already counts, so a bank linked to a ledger
 *     (bank_accounts.linked_ledger_id) is never counted twice: its opening and
 *     its bank-only lines are on the bank line, the ledger's opening and every
 *     line naming the ledger on the ledger account's line.
 *
 * Amounts that are not in the ledger — unposted factory invoices, factory POS
 * credit sales, cache-only customer rows, unjournalled factory container
 * amounts, the salary-advance table's remaining balance over the ledger, the
 * payroll page's current balance over the ledger — are returned in a separate
 * `notInLedger` section: shown, labelled, never added to What We Have / What
 * We Owe.
 */

import {
  round2,
  notInLedgerSection,
  type NetPositionPartyOptions,
  type NetPositionParties,
} from "./netPositionPartiesHelpers";
import { loadNetPositionPartiesPart1 } from "./loadNetPositionPartiesPart1";
export {
  NET_POSITION_NOT_IN_LEDGER_LABEL,
  ERP_NET_POSITION_INCLUDES_SUPPLIERS,
  MISSING_ACCOUNT_CATEGORY,
  netPositionPartyValue,
  notInLedgerSection,
  type NetPositionPartyLine,
  type NotInLedgerLine,
  type NotInLedgerSection,
  type NetPositionPartyOptions,
  type NetPositionParties,
} from "./netPositionPartiesHelpers";

export async function loadNetPositionParties(
  companyId: number,
  options: NetPositionPartyOptions
): Promise<NetPositionParties> {
  const { forUs, onUs, memo, customerLedgerIds, payrollSigned } = await loadNetPositionPartiesPart1(companyId, options);

  forUs.sort((a, b) => b.value - a.value);
  onUs.sort((a, b) => b.value - a.value);
  return {
    forUs,
    onUs,
    forUsTotal: round2(forUs.reduce((sum, line) => sum + line.value, 0)),
    onUsTotal: round2(onUs.reduce((sum, line) => sum + line.value, 0)),
    customerLedgerIds,
    payrollSigned,
    notInLedger: notInLedgerSection(memo),
  };
}

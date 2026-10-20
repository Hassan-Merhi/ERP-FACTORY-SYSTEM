# FX Agent USD/EUR Wallets

**Schema deployment:** The original wallet feature requires `migrations/20261019_factory_fx_agent_wallets.sql` in production. Safe reversal additionally requires `migrations/20261020_factory_fx_agent_conversion_reversals.sql`, applied separately by an authorized operator. Code merges/deploys never automatically run production SQL.

## Owner case: Ramadan FX
An agent holds USD on the company's behalf, then agrees to hold EUR at an agreed historic conversion rate (e.g. USD 1.1115 per EUR). His native balance must remain EUR. Factory Net Position values outstanding EUR at the manually configured EUR-to-USD Settings rate **effective on or before the report as-of date**. A supplier payment can use a *different, explicitly entered* USD-per-EUR rate, post USD to the supplier, deduct the native EUR held by the agent, and recognize realized FX gain/loss.

## Records and invariants
- Existing ERP **ledger account** remains the agent's identity (no duplicate voucher account).
- `factory_fx_agent_wallets` is a one-time, explicitly confirmed USD opening snapshot; the source ledger's existing voucher opening and transactions are left intact.
- `factory_fx_agent_wallet_operations` is a dated native-currency movement ledger, never an overwrite of historical USD vouchers.
- USD->EUR transfer moves the wallet denomination; total historic USD book basis is unchanged, so no new GL posting is necessary solely to change denomination inside the same agent account.
- EUR->USD supplier settlement posts **one balanced voucher** through `postFactoryVoucherTx`: debit USD destination (factory supplier or ledger), credit the FX agent ledger account by its EUR book basis, credit/debit the existing `FX-REVALUATION` system account for the realized rate difference. All writes are a single DB transaction.
- Wallet writes lock the wallet row, use an idempotency key, validate account ownership and positive funds, and refuse backdated operations preceding newer movements.
- The current ledger base balance must match the wallet's remaining USD-plus-EUR historic book basis before new operations. If another journal altered the underlying account, settlement is blocked pending manual review.
- Net Position shows `USD native + EUR native * Factory Settings EUR rate` for synchronized activated agent accounts; *only* the report-time classification is adjusted. Ledger and historical USD values are unchanged. Unresolved rates or mismatched ledger books cause a warning and preserve the posted ledger value.

## Prerequisites
1. Review and apply `migrations/20261019_factory_fx_agent_wallets.sql` to a test database first (TablePlus compatible). Run no migration on production as part of PR review.
2. Set an effective-dated EUR-to-USD rate in Factory Settings (e.g. EUR = 1.15 for display). This is a valuation rate, not the agent's conversion contract.
3. Confirm the Ramadan ledger account is an asset with a positive USD debit balance, is **not** cash, bank, linked customer/bank, and has no known non-USD voucher history before activation.
4. Open **Factory Mode → Accounts** → edit the existing FX agent ledger account → **FX Agent USD / EUR — Convert, Pay, Reverse**. This opens a popup scoped to that exact account. Activate the wallet if needed, then convert USD to EUR at the negotiated rate.
5. For a USD supplier payment, enter the EUR amount and the actual negotiated payout rate, choose a **factory supplier or USD ledger beneficiary** and confirm posting.

## Example
- Existing agent ledger debit USD 10,000.
- Agreed USD/EUR 1.1115; wallet becomes EUR 8,996.851102 (book USD 10,000).
- Settings USD/EUR 1.15; Net Position agent value USD 10,346.38 (report-time only).
- Pay a supplier EUR 1,000 at USD/EUR 1.14: supplier USD payment 1,140, agent EUR native 7,996.851102, realized FX gain USD 28.50 at historical booked basis ~USD 1,111.50.
- Change Settings to 1.20: EUR balance is untouched; USD report value updates independently.

## Reconcile an unused wallet after USD ledger postings
If the posted USD ledger account changes after a wallet was activated, its
one-time opening snapshot can differ from the current USD ledger balance.
Accounts → Edit Agent → FX Agent shows both amounts rather than silently
treating the difference as FX gains or EUR funds.

An Admin, Owner or Developer can select **Reconcile unused USD wallet** only
when the wallet has **zero FX operations**. The confirmation requires a written
reason, the current wallet opening and ledger balance. The server locks the
wallet, rejects stale figures, verifies the account is active and its posted
vouchers do not report non-USD transaction currency, and checks again that
no FX conversion, payout or reversal exists. It restarts the wallet's USD
opening and activation date from today's posted USD ledger, with an atomic
audit-log entry recording the previous baseline, new baseline, date and
reason. It never alters vouchers. For dates before the new activation,
Net Position retains the posted USD ledger figure. If any FX operation
exists, the baseline cannot be reset and the mismatched books require
manual reconciliation instead. No extra SQL migration is required.

## Reversing a USD → EUR conversion
- Apply the **20261020 reversal migration** first. The popup will explain if the migration is missing; normal conversion/settlement functionality stays available.
- In Accounts → Edit the agent → FX popup → **USD → EUR conversions and reversals**, choose the conversion and supply a mandatory reason; confirm **Reverse to USD**.
- The reversal is a new auditable `EUR_TO_USD_REVERSAL` movement, linking to the original immutable conversion. It deducts exactly the original EUR and restores exactly the original USD book amount at the **original rate**. No GL voucher or FX gain/loss is posted for an unspent denomination-only reversal.
- A conversion cannot be reversed twice, or after any EUR settlement later than its conversion. The latter safeguard is intentionally conservative because the wallet pools EUR and cannot prove which conversion supplied a settled amount. This does **not** reverse USD supplier settlements or their posted vouchers.
- The same company-scoped wallet lock, idempotency keys, ledger synchronization guard and operation date ordering apply to reversals.
- Net Position still values the wallet EUR balance at the dated Settings rate; only the management card is removed from the Net Position UI.

## Verified
- `tests/factory-fx-agent-wallet-routes.test.ts` runs the whole lifecycle against PostgreSQL: activation (explicit USD confirmation, one wallet per account), USD->EUR conversion at 1.1115, a partial EUR settlement at 1.16 (balanced voucher, USD 4,640.00 paid, realized gain USD 194.00), the final settlement at 1.10 (realized loss USD 57.46, agent ledger back to zero within a cent), idempotent replay and key reuse, overdraw and self-payment refusals, the generic voucher edit/retirement lock, and the ledger-drift guard.
- The Factory backend access boundary owns `/api/factory/fx-agent-wallets*` through Net Position Details, like `/api/factory/net-position`.
- Net Position figures are unchanged when no wallet is active (the report characterization hash without the two new fields equals the previous pin).

## Remaining follow-ups
- Test company isolation, rate-unavailable historical snapshots and supplier statement reconciliation for a `factorySupplier` beneficiary.
- A dedicated atomic **settlement voucher + EUR payout** reversal is still not implemented; generic edit, reversal and retirement of a settled voucher remain forbidden. The new reversal applies to **unspent denomination conversions only**.
- Enforce wallet-awareness in *ordinary Journal Voucher* entry/edit and voucher retirement flows, rather than relying only on discrepancy detection. The account-scoped FX popup owns payment creation; the existing generic journal editor is **not yet wallet-aware**.
- Test opening-balance sources with unresolved legacy currency metadata before production activation.
- Test and specify formal unrealized revaluation accounting policy; Net Position display translation must not silently post P&L.
- Integrate wallet-native EUR balances in the general Accounts/Agent Ledger pages and exported statements, not just Factory Net Position.
- Check migration registry/startup policy and get an explicit migration deployment plan. No production SQL has been run here.

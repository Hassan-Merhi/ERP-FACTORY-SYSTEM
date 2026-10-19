# FX Agent USD/EUR Wallets — Draft Feature

**Status: code merged, feature off in production.** The two tables are declared in `shared/schema/runtime/fxAgentWallets.ts` (so test databases created with `drizzle-kit push` have them), but nothing creates them at startup and production never runs a push: the feature stays disabled (`setupRequired: true`) until `migrations/20261019_factory_fx_agent_wallets.sql` is reviewed and applied by hand with owner approval.

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
4. In Factory Net Position, use **FX Agent Accounts** → Manage → select existing ledger account → activate; choose USD to convert and actual agreed rate.
5. For a USD supplier payment, choose FX agent EUR amount, the actual negotiated payout rate, and a **factory supplier or USD ledger beneficiary**. Confirm posting.

## Example
- Existing agent ledger debit USD 10,000.
- Agreed USD/EUR 1.1115; wallet becomes EUR 8,996.851102 (book USD 10,000).
- Settings USD/EUR 1.15; Net Position agent value USD 10,346.38 (report-time only).
- Pay a supplier EUR 1,000 at USD/EUR 1.14: supplier USD payment 1,140, agent EUR native 7,996.851102, realized FX gain USD 28.50 at historical booked basis ~USD 1,111.50.
- Change Settings to 1.20: EUR balance is untouched; USD report value updates independently.

## Verified
- `tests/factory-fx-agent-wallet-routes.test.ts` runs the whole lifecycle against PostgreSQL: activation (explicit USD confirmation, one wallet per account), USD->EUR conversion at 1.1115, a partial EUR settlement at 1.16 (balanced voucher, USD 4,640.00 paid, realized gain USD 194.00), the final settlement at 1.10 (realized loss USD 57.46, agent ledger back to zero within a cent), idempotent replay and key reuse, overdraw and self-payment refusals, the generic voucher edit/retirement lock, and the ledger-drift guard.
- The Factory backend access boundary owns `/api/factory/fx-agent-wallets*` through Net Position Details, like `/api/factory/net-position`.
- Net Position figures are unchanged when no wallet is active (the report characterization hash without the two new fields equals the previous pin).

## Remaining follow-ups
- Test company isolation, rate-unavailable historical snapshots and supplier statement reconciliation for a `factorySupplier` beneficiary.
- Add a dedicated atomic wallet + journal reversal; until then ordinary edit, reversal and retirement of a settlement voucher are refused.
- Enforce wallet-awareness in *ordinary Journal Voucher* entry/edit and voucher retirement flows, rather than relying only on discrepancy detection. The current draft exposes the FX payment workflow in Factory Net Position; the existing generic journal editor is **not yet wallet-aware**.
- Test opening-balance sources with unresolved legacy currency metadata before production activation.
- Test and specify formal unrealized revaluation accounting policy; Net Position display translation must not silently post P&L.
- Integrate wallet-native EUR balances in the general Accounts/Agent Ledger pages and exported statements, not just Factory Net Position.
- Check migration registry/startup policy and get an explicit migration deployment plan. No production SQL has been run here.

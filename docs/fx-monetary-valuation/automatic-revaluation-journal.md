# Automatic FX revaluation journal

**Owner decision, 2026-11-19.** Earlier phases of this folder describe FX
valuation as report-only: saving a rate re-translated balances in reports and
posted nothing, and the revaluation was being journalled by hand after each
rate change. That policy is replaced for USD-base companies with a foreign
display currency (Mali USD/CFA, Zambia USD/ZMW): **saving a company exchange
rate now posts the revaluation automatically.**

The original automatic `FX-REVAL-*` journal (removed in wave 9) stays removed.
It treated every Cash account as CFA, used float arithmetic and posted again
when the same rate was re-saved. This implementation shares nothing with it.

## What is posted

After `POST /api/exchange-rates` commits the rate, the server calls
`postFxRevaluation` (`server/services/accounting/fxRevaluationPosting.ts`):

1. It reads the same valuation the reports show (`getMonetaryFxValuation`), at
   the company business date and the rate effective on that date.
2. For each **cash/bank account, customer and loan** that holds a foreign
   currency: `adjustment = native balance at the current rate − historical USD
   book value`, rounded to cents.
3. It posts **one balanced Journal**, dated the business date: one line per
   adjusted account, and the net against the system account
   **FX Revaluation Gain/Loss** (`FX-REVALUATION`).

Each account line is *base-only*: it carries the account's foreign currency
with a **zero native amount** (`rate_convention = 'BASE_ONLY_REVALUATION'`,
migration `0011`). CFA/ZMW balances and every original voucher are untouched;
only the USD book value moves. After the journal, book value equals the
current valuation, so the reports' "translation difference" for those accounts
returns to (sub-cent) zero and the gain or loss is in the ledger instead.

## Behaviour to rely on

- **Same rate saved again:** nothing is posted (`nothing_to_post`).
- **Rate changed back:** an equal and opposite journal is posted.
- **Several changes in one day:** one journal per change, each for the
  remaining difference only.
- **A rate dated in the past or future** that is not the rate in force on the
  business date changes no valuation, so nothing is posted.
- **Deleting a revaluation journal** restores the difference; the next rate
  save posts it again. Delete rather than edit: re-saving its lines through the
  Journal editor turns them into ordinary USD lines.
- **The rate save never fails because of the revaluation.** If the journal
  cannot be posted (closed period, missing system account), the rate is saved
  and the reason is returned and shown.
- Two simultaneous saves cannot both post the same difference (advisory lock
  plus a per-company posting sequence).

The response of `POST /api/exchange-rates` carries `fxRevaluation`
(`status`: `posted` | `nothing_to_post` | `skipped` | `failed`, voucher number,
net gain, per-account lines, unresolved accounts). Settings and the daily rate
popup show it in the save message.

## What is never revalued

- Accounts whose original currency is unresolved (an opening balance or legacy
  lines without native currency data). They are listed in the save message as
  "not revalued"; resolve them in Historical Opening Resolver first.
- Generic `Asset` accounts awaiting monetary review, deleted accounts,
  suppliers, employees, inventory and every non-monetary account.
- Differences below one cent.

## Before the first rate save after deployment

The first journal books the **whole difference accumulated so far**, as the
reports currently show it. A revaluation already entered by hand as an ordinary
USD journal line on a CFA/ZMW account is seen by the valuation as a separate
USD holding, not as a revaluation, so it does **not** reduce that difference.
Review (and where appropriate delete) such manual revaluation journals, and
compare the Multi-Currency Accounting page's differences with what you expect,
before saving the next rate. The same applies to Mali's legacy `FX-REVAL-*`
vouchers (decision B1 in `docs/accounting-audit-2026-10.md`).

## Deployment

Migration `0011_fx_revaluation_base_only_voucher_line.sql` must be applied
(the `db:deploy` release step does this). It only adds a validated branch to
`normalize_voucher_entry_currency_amounts()`; no row is read or changed.
Without it the journal is refused by the database and the save message reports
the revaluation as not posted; the rate itself is still saved.

Factory company rates (`factory_fx_rates`) are not part of this change.

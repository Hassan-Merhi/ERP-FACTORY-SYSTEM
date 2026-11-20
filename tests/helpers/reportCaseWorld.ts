/**
 * The rolled-back factory world (see rolledBackFactoryApp) plus small ledger,
 * voucher and second-company builders, for driving chat report cases and
 * services directly. Every pool and drizzle call is routed to the world's
 * transaction, so the code under test sees the rows the test inserts and
 * nothing survives the test. All SQL here is literal with $n parameters and
 * runs through the world's reviewed q/one helpers.
 *
 * The world company already has one location ("Yard", world.locationId) and
 * an Admin user (world.userId).
 */
import { withFactoryWorld, type FactoryWorld } from "./rolledBackFactoryApp";

export interface ReportWorld extends FactoryWorld {
  /** Another company, for proving scoping. */
  otherCompany: () => Promise<number>;
  /** A ledger account in the given company (default: this one). */
  ledger: (name: string, type: string, opts?: LedgerOpts) => Promise<number>;
  /** A voucher in the given company (default: this one). */
  voucher: (type: string, date: string, opts?: VoucherOpts) => Promise<number>;
  entry: (voucherId: number, ledgerId: number, dr: number | string, cr: number | string) => Promise<void>;
}

export interface LedgerOpts {
  companyId?: number;
  opening?: number | string;
  side?: "Dr" | "Cr" | null;
  subType?: string | null;
}

export interface VoucherOpts {
  companyId?: number;
  total?: number | string;
  description?: string | null;
  optional?: boolean;
  currency?: string;
}

let seq = 0;

export function withReportWorld<T>(work: (world: ReportWorld) => Promise<T>): Promise<T> {
  return withFactoryWorld((w) =>
    work({
      ...w,
      otherCompany: () =>
        w.one(
          `INSERT INTO companies (code, name, company_type, base_currency) VALUES ($1::varchar, $1::text, 'factory', 'USD') RETURNING id`,
          [`${w.tag}O${++seq}`]
        ),
      ledger: (name, type, opts = {}) =>
        w.one(
          `INSERT INTO ledger_accounts (company_id, code, name, account_type, sub_type, opening_balance, opening_balance_side)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [
            opts.companyId ?? w.companyId,
            `${w.tag}L${++seq}`,
            name,
            type,
            opts.subType ?? null,
            opts.opening ?? 0,
            opts.side === undefined ? "Dr" : opts.side,
          ]
        ),
      voucher: (type, date, opts = {}) =>
        w.one(
          `INSERT INTO vouchers (company_id, voucher_number, voucher_type, voucher_date, total_amount, optional, description, currency)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            opts.companyId ?? w.companyId,
            `${w.tag}V${++seq}`,
            type,
            date,
            opts.total ?? 0,
            opts.optional ?? false,
            opts.description ?? null,
            opts.currency ?? "USD",
          ]
        ),
      entry: async (voucherId, ledgerId, dr, cr) => {
        await w.q(
          `INSERT INTO voucher_entries (voucher_id, ledger_account_id, debit_amount, credit_amount) VALUES ($1, $2, $3, $4)`,
          [voucherId, ledgerId, dr, cr]
        );
      },
    })
  );
}

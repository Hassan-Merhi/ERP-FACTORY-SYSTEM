/**
 * FX agent EUR wallets: native balances kept beside the agent's historical USD
 * ledger valuation (docs/factory-fx-agent-wallets.md).
 *
 * Created by migrations/20261019_factory_fx_agent_wallets.sql, which is applied
 * by hand after review. Declared here so drizzle-kit and the type system see
 * the real schema; the definition matches that DDL column for column
 * (tests/runtime-declared-tables-ddl.test.ts).
 */
import {
  pgTable,
  bigint,
  bigserial,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  text,
  timestamp,
  unique,
  varchar,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { companies } from "../common";
import { ledgerAccounts } from "../accounting";
import { vouchers } from "../erp/vouchers";

export const factoryFxAgentWallets = pgTable(
  "factory_fx_agent_wallets",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    ledgerAccountId: integer("ledger_account_id").notNull(),
    openingUsd: numeric("opening_usd", { precision: 20, scale: 6 }).notNull(),
    confirmedNativeUsd: boolean("confirmed_native_usd").default(false).notNull(),
    activatedOn: date("activated_on").notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("factory_fx_agent_wallets_company_idx").using("btree", table.companyId),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "factory_fx_agent_wallets_company_id_fkey",
    }),
    foreignKey({
      columns: [table.ledgerAccountId],
      foreignColumns: [ledgerAccounts.id],
      name: "factory_fx_agent_wallets_ledger_account_id_fkey",
    }),
    unique("factory_fx_agent_wallets_company_id_ledger_account_id_key").on(table.companyId, table.ledgerAccountId),
    check("factory_fx_agent_wallets_opening_usd_check", sql`opening_usd >= 0`),
  ]
);

export const factoryFxAgentWalletOperations = pgTable(
  "factory_fx_agent_wallet_operations",
  {
    id: bigserial({ mode: "number" }).primaryKey().notNull(),
    companyId: integer("company_id").notNull(),
    walletId: bigint("wallet_id", { mode: "number" }).notNull(),
    effectiveDate: date("effective_date").notNull(),
    kind: text().notNull(),
    sourceCurrency: varchar("source_currency", { length: 3 }).notNull(),
    sourceAmount: numeric("source_amount", { precision: 20, scale: 6 }).notNull(),
    targetCurrency: varchar("target_currency", { length: 3 }).notNull(),
    targetAmount: numeric("target_amount", { precision: 20, scale: 6 }).notNull(),
    rateUsdPerEur: numeric("rate_usd_per_eur", { precision: 20, scale: 10 }).notNull(),
    sourceBookUsd: numeric("source_book_usd", { precision: 20, scale: 6 }).notNull(),
    fxGainUsd: numeric("fx_gain_usd", { precision: 20, scale: 6 })
      .default(sql`0`)
      .notNull(),
    targetKind: text("target_kind"),
    targetId: integer("target_id"),
    voucherId: integer("voucher_id"),
    requestKey: varchar("request_key", { length: 100 }).notNull(),
    narration: text(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("factory_fx_agent_wallet_ops_asof_idx").using(
      "btree",
      table.companyId,
      table.walletId,
      table.effectiveDate,
      table.id
    ),
    foreignKey({
      columns: [table.companyId],
      foreignColumns: [companies.id],
      name: "factory_fx_agent_wallet_operations_company_id_fkey",
    }),
    foreignKey({
      columns: [table.walletId],
      foreignColumns: [factoryFxAgentWallets.id],
      name: "factory_fx_agent_wallet_operations_wallet_id_fkey",
    }),
    foreignKey({
      columns: [table.voucherId],
      foreignColumns: [vouchers.id],
      name: "factory_fx_agent_wallet_operations_voucher_id_fkey",
    }),
    unique("factory_fx_agent_wallet_operations_company_id_request_key_key").on(table.companyId, table.requestKey),
    check("factory_fx_agent_wallet_operations_kind_check", sql`kind IN ('USD_TO_EUR', 'EUR_SETTLEMENT')`),
    check("factory_fx_agent_wallet_operations_source_amount_check", sql`source_amount > 0`),
    check("factory_fx_agent_wallet_operations_target_amount_check", sql`target_amount > 0`),
    check("factory_fx_agent_wallet_operations_rate_usd_per_eur_check", sql`rate_usd_per_eur > 0`),
    check("factory_fx_agent_wallet_operations_source_book_usd_check", sql`source_book_usd >= 0`),
    check(
      "factory_fx_agent_wallet_operations_target_kind_check",
      sql`target_kind IN ('factorySupplier', 'supplier', 'ledger')`
    ),
    check(
      "fx_agent_operation_shape",
      sql`(kind = 'USD_TO_EUR' AND source_currency = 'USD' AND target_currency = 'EUR' AND target_kind IS NULL AND target_id IS NULL AND voucher_id IS NULL) OR (kind = 'EUR_SETTLEMENT' AND source_currency = 'EUR' AND target_currency = 'USD' AND target_kind IS NOT NULL AND target_id IS NOT NULL AND voucher_id IS NOT NULL)`
    ),
  ]
);

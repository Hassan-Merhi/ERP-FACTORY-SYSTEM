-- FX agent wallets: native balances coexist with historical USD ledger valuation.
-- Apply in a reviewed migration / TablePlus before enabling the feature.
-- No historical voucher is rewritten.
CREATE TABLE IF NOT EXISTS factory_fx_agent_wallets (
 id BIGSERIAL PRIMARY KEY,
 company_id INTEGER NOT NULL REFERENCES companies(id),
 ledger_account_id INTEGER NOT NULL REFERENCES ledger_accounts(id),
 opening_usd NUMERIC(20,6) NOT NULL CHECK (opening_usd >= 0),
 confirmed_native_usd BOOLEAN NOT NULL DEFAULT false,
 activated_on DATE NOT NULL,
 created_by TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(company_id, ledger_account_id)
);
CREATE INDEX IF NOT EXISTS factory_fx_agent_wallets_company_idx ON factory_fx_agent_wallets(company_id);
CREATE TABLE IF NOT EXISTS factory_fx_agent_wallet_operations (
 id BIGSERIAL PRIMARY KEY,
 company_id INTEGER NOT NULL REFERENCES companies(id),
 wallet_id BIGINT NOT NULL REFERENCES factory_fx_agent_wallets(id),
 effective_date DATE NOT NULL,
 kind TEXT NOT NULL CHECK (kind IN ('USD_TO_EUR', 'EUR_SETTLEMENT')),
 source_currency VARCHAR(3) NOT NULL,
 source_amount NUMERIC(20,6) NOT NULL CHECK (source_amount > 0),
 target_currency VARCHAR(3) NOT NULL,
 target_amount NUMERIC(20,6) NOT NULL CHECK (target_amount > 0),
 rate_usd_per_eur NUMERIC(20,10) NOT NULL CHECK (rate_usd_per_eur > 0),
 source_book_usd NUMERIC(20,6) NOT NULL CHECK (source_book_usd >= 0),
 fx_gain_usd NUMERIC(20,6) NOT NULL DEFAULT 0,
 target_kind TEXT CHECK (target_kind IN ('factorySupplier','supplier','ledger')),
 target_id INTEGER,
 voucher_id INTEGER REFERENCES vouchers(id),
 request_key VARCHAR(100) NOT NULL,
 narration TEXT,
 created_by TEXT,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(company_id, request_key),
 CONSTRAINT fx_agent_operation_shape CHECK (
   (kind = 'USD_TO_EUR' AND source_currency = 'USD' AND target_currency = 'EUR' AND target_kind IS NULL AND target_id IS NULL AND voucher_id IS NULL)
   OR (kind = 'EUR_SETTLEMENT' AND source_currency = 'EUR' AND target_currency = 'USD' AND target_kind IS NOT NULL AND target_id IS NOT NULL AND voucher_id IS NOT NULL)
 )
);
CREATE INDEX IF NOT EXISTS factory_fx_agent_wallet_ops_asof_idx
 ON factory_fx_agent_wallet_operations(company_id, wallet_id, effective_date, id);

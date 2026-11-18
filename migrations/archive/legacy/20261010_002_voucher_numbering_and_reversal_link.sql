-- Accounting audit phase 22 (A), PE8/G9 and PE9: gapless voucher number
-- counters per company / number prefix (voucher type) / year, and the link of a
-- reversal voucher to the voucher it reverses. Additive and idempotent:
-- existing voucher numbers are never changed, and existing vouchers keep a NULL
-- link and posted_by_engine = false (the balance guard keeps its old
-- tolerance for them). Also applied at boot by ensureRuntimeSchema (server/startup).

CREATE TABLE IF NOT EXISTS voucher_number_sequences (
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  prefix VARCHAR(20) NOT NULL,
  year INTEGER NOT NULL,
  last_value BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMP NOT NULL DEFAULT now(),
  CONSTRAINT voucher_number_sequences_company_id_prefix_year_pk PRIMARY KEY (company_id, prefix, year)
);

ALTER TABLE vouchers
  ADD COLUMN IF NOT EXISTS reversal_of_voucher_id INTEGER REFERENCES vouchers(id),
  ADD COLUMN IF NOT EXISTS posted_by_engine BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS vouchers_reversal_of_live_unique
  ON vouchers (reversal_of_voucher_id)
  WHERE reversal_of_voucher_id IS NOT NULL AND deleted_at IS NULL;

ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS production_overview_valuation_mode text NOT NULL DEFAULT 'cost';

DO $$
BEGIN
  ALTER TABLE user_preferences
    ADD CONSTRAINT user_preferences_production_overview_valuation_mode_check
    CHECK (production_overview_valuation_mode IN ('cost', 'selling'));
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

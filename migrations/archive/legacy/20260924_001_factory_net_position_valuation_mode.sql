ALTER TABLE user_preferences
  ADD COLUMN IF NOT EXISTS factory_net_position_valuation_mode text NOT NULL DEFAULT 'cost';

ALTER TABLE user_preferences
  DROP CONSTRAINT IF EXISTS user_preferences_factory_net_position_valuation_mode_check;

ALTER TABLE user_preferences
  ADD CONSTRAINT user_preferences_factory_net_position_valuation_mode_check
  CHECK (factory_net_position_valuation_mode IN ('cost', 'selling'));

-- Phase 3 controlled extraction from 029-user-presence-compliance-indexes.ts.
-- Additive schema only. Does not post journals, rewrite valuation or touch history.
-- Requires reviewed manual migration release; no automatic production execution.

CREATE INDEX IF NOT EXISTS user_presence_last_seen_idx ON user_presence (last_seen);

CREATE INDEX IF NOT EXISTS user_presence_company_last_seen_idx ON user_presence (company_id, last_seen);

CREATE INDEX IF NOT EXISTS user_presence_user_last_seen_idx ON user_presence (user_id, last_seen);

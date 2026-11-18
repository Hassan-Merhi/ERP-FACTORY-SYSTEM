CREATE TABLE IF NOT EXISTS user_language_preferences (
  user_id varchar PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferred_language varchar(2) NOT NULL DEFAULT 'en',
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now(),
  CONSTRAINT user_language_preferences_language_check
    CHECK (preferred_language IN ('en', 'ar', 'fr'))
);

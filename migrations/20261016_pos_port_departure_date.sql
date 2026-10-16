-- Optional manual fallback for TablePlus. Automatic startup migration also applies this.
ALTER TABLE containers ADD COLUMN IF NOT EXISTS port_departure_date DATE;

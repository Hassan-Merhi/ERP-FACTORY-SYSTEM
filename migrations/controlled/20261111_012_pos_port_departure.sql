-- Phase 3: additive legacy startup schema extracted from 035-pos-port-departure-date.ts.
-- No data repair, DELETE, or UPDATE. Controlled approval required.

ALTER TABLE containers ADD COLUMN IF NOT EXISTS port_departure_date date;

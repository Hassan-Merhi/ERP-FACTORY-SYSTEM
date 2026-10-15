-- Fixed Production Planner: saved 20-ton allocations are company-wide and immutable while locked.
-- Live raw stock and OTW amounts are never persisted here.
CREATE TABLE IF NOT EXISTS factory_fixed_production_plans (
  company_id integer PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  allocations_20t jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_locked boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT factory_fixed_production_allocations_object
    CHECK (jsonb_typeof(allocations_20t) = 'object')
);

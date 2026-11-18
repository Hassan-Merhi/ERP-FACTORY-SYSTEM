-- Controlled migration 20261111_001: Fixed Production Planner schema.
-- Forward-only and additive; does not update accounting or inventory.
-- Same table definition as the existing compatibility bridge.
CREATE TABLE IF NOT EXISTS public.factory_fixed_production_plans (
  company_id integer PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  allocations_20t jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_locked boolean NOT NULL DEFAULT false,
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT factory_fixed_production_allocations_object CHECK (jsonb_typeof(allocations_20t) = 'object')
);

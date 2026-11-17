-- 0008_restore_defaults_the_code_relies_on.sql
--
-- Two columns where the application relies on a database default that the
-- deployed databases never had. Found by comparing every column default in the
-- Drizzle declarations with the deployed schema (manifest/schema.tsv).
-- Neither change reads or rewrites existing rows.
--
-- 1. factory_bales.cost_per_kg: the code declares DEFAULT 0, and the bale
--    pressing inserts (server/routes/factory/bales/balesPressingRoutes.ts) omit
--    it, but production has no default. Production has 0 NULL values in
--    49,439 bales (read-only check, 2026-11-17). Adding the default only
--    affects future inserts that omit the column.
ALTER TABLE public.factory_bales ALTER COLUMN cost_per_kg SET DEFAULT '0'::numeric;

-- 2. pressing_batches.id: declared serial, but production has no default,
--    identity or sequence, so every insert from the legacy production-bale
--    route (server/routes/productionBaleRoutes.ts) fails with a NOT NULL
--    violation. Production has 0 rows (read-only check, 2026-11-17). Give the
--    column the sequence a serial column has. setval starts it after any
--    existing id, so this is also safe if rows exist elsewhere.
CREATE SEQUENCE IF NOT EXISTS public.pressing_batches_id_seq AS integer OWNED BY public.pressing_batches.id;
ALTER TABLE public.pressing_batches ALTER COLUMN id SET DEFAULT nextval('public.pressing_batches_id_seq'::regclass);
SELECT setval('public.pressing_batches_id_seq', COALESCE((SELECT max(id) FROM public.pressing_batches), 0) + 1, false);

-- Phase 3: move security permissions schema creation out of startup.
-- Never DELETE duplicates, seed grants, or rewrite existing permissions.
-- If duplicate role assignments prevent the UNIQUE index, fail for manual
-- tenant-security review rather than silently revoking or merging permissions.
DO $ensure$
BEGIN
  IF to_regclass('public.users') IS NULL THEN
    RAISE EXCEPTION 'Required users table missing; cannot create security permissions';
  END IF;
END
$ensure$;

CREATE TABLE IF NOT EXISTS public.user_security_permissions (
  id serial PRIMARY KEY NOT NULL,
  user_id varchar NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  company_id integer NOT NULL,
  permission text NOT NULL,
  granted_by varchar REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamp DEFAULT now() NOT NULL,
  updated_at timestamp DEFAULT now() NOT NULL
);

ALTER TABLE public.user_security_permissions ADD COLUMN IF NOT EXISTS user_id varchar;
ALTER TABLE public.user_security_permissions ADD COLUMN IF NOT EXISTS company_id integer;
ALTER TABLE public.user_security_permissions ADD COLUMN IF NOT EXISTS permission text;
ALTER TABLE public.user_security_permissions ADD COLUMN IF NOT EXISTS granted_by varchar;
ALTER TABLE public.user_security_permissions ADD COLUMN IF NOT EXISTS created_at timestamp DEFAULT now();
ALTER TABLE public.user_security_permissions ADD COLUMN IF NOT EXISTS updated_at timestamp DEFAULT now();

CREATE UNIQUE INDEX IF NOT EXISTS user_security_permissions_unique
  ON public.user_security_permissions (user_id, company_id, permission);
CREATE INDEX IF NOT EXISTS user_security_permissions_company_user_idx
  ON public.user_security_permissions (company_id, user_id);

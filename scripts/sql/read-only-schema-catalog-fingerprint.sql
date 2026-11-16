-- Read-only metadata fingerprint for PostgreSQL 18.
-- Produces no table contents, row samples, user passwords or connection strings.
-- Use on every candidate ERP database, record database identity separately.
-- md5 here identifies catalog differences; it is NOT a provenance signature.
WITH objects AS (
  SELECT 'table' AS kind,c.relname AS name,
    md5(format('%s:%s:%s',c.relkind,c.relrowsecurity,c.relforcerowsecurity)) AS definition_hash
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind IN ('r','p')
  UNION ALL
  SELECT 'column',format('%s.%s',c.relname,a.attname),
    md5(format('%s:%s:%s:%s',format_type(a.atttypid,a.atttypmod),a.attnotnull,
      coalesce(pg_get_expr(d.adbin,d.adrelid),''),a.attidentity))
  FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
  WHERE n.nspname='public' AND c.relkind IN ('r','p') AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'index',i.indexname,md5(i.indexdef) FROM pg_indexes i WHERE schemaname='public'
  UNION ALL
  SELECT 'constraint',format('%s.%s',c.relname,con.conname),md5(pg_get_constraintdef(con.oid))
  FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'trigger',format('%s.%s',c.relname,t.tgname),md5(pg_get_triggerdef(t.oid))
  FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND NOT t.tgisinternal
  UNION ALL
  SELECT 'function',format('%s(%s)',p.proname,pg_get_function_identity_arguments(p.oid)),
    md5(pg_get_functiondef(p.oid))
  FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
  UNION ALL
  SELECT 'policy',format('%s.%s',c.relname,pol.polname),
    md5(format('%s:%s:%s',pol.polcmd,
      coalesce(pg_get_expr(pol.polqual,pol.polrelid),''),
      coalesce(pg_get_expr(pol.polwithcheck,pol.polrelid),'')))
  FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'
)
SELECT kind,count(*)::integer AS object_count,
  md5(string_agg(kind||':'||name||':'||definition_hash,E'\n' ORDER BY name,definition_hash))
    AS catalog_fingerprint
FROM objects GROUP BY kind ORDER BY kind;

-- 0009_retire_legacy_roles_and_reconcile_bonus_payment.sql
--
-- Two owner-approved data corrections (2026-11-17), both reported at every
-- startup on the live HMD database. Neither touches a voucher, a voucher line
-- or any balance.

-- ── 1. Retired roles ────────────────────────────────────────────────────────
-- POS1..POS6 became POS with a station number, and User became Normal User.
-- The former startup schema applied this conversion on every boot; it was
-- retired with the startup schema, but the Factory "Users & Access" create
-- route kept inserting role 'User' (fixed in the same change). Production had
-- 3 such rows: factory-only users P1, P2 and P3 of HMD INT GROUP - BEIRUT,
-- created 2026-10-27. For factory-only users the role does not change access
-- (their page list governs it), and 'User' is not a role any check recognises.
-- The mapping is the original one (git 925682037).
UPDATE public.user_company_roles SET role = 'POS', pos_station = 1 WHERE role = 'POS1';
UPDATE public.user_company_roles SET role = 'POS', pos_station = 2 WHERE role = 'POS2';
UPDATE public.user_company_roles SET role = 'POS', pos_station = 3 WHERE role = 'POS3';
UPDATE public.user_company_roles SET role = 'POS', pos_station = 4 WHERE role = 'POS4';
UPDATE public.user_company_roles SET role = 'POS', pos_station = 5 WHERE role = 'POS5';
UPDATE public.user_company_roles SET role = 'POS', pos_station = 6 WHERE role = 'POS6';
UPDATE public.user_company_roles SET role = 'Normal User' WHERE role = 'User';
UPDATE public.role_feature_permissions SET role = 'POS' WHERE role IN ('POS1', 'POS2', 'POS3', 'POS4', 'POS5', 'POS6');
UPDATE public.role_feature_permissions SET role = 'Normal User' WHERE role = 'User';

-- ── 2. Manual production bonus payment 1 (HMD, company 12) ─────────────────
-- Worker 58, week 2026-10-26: recorded at 27.00 USD with voucher
-- PV-12-2026-000101 (id 16893) on 2026-10-31. On 2026-11-02 the voucher was
-- edited to 26.00 USD from the ordinary voucher screen (audit_log 80098), which
-- did not update the bonus register. The owner confirmed 26.00 was paid. The
-- register is corrected to the posted amount; the voucher is left unchanged.
-- Guarded to that exact row and state, so it is a no-op on any other database
-- and on a re-run.
SELECT set_config('app.current_company_id', '12', true);

WITH target AS (
  SELECT p.id
    FROM public.factory_target_bonus_manual_payments p
    JOIN public.vouchers v ON v.id = p.payment_voucher_id AND v.company_id = p.company_id
   WHERE p.company_id = 12
     AND p.id = 1
     AND p.worker_id = 58
     AND p.week_start = DATE '2026-10-26'
     AND p.payment_voucher_id = 16893
     AND p.status = 'POSTED'
     AND p.amount_usd = 27
     AND v.voucher_number = 'PV-12-2026-000101'
     AND v.total_amount = 26
     AND v.deleted_at IS NULL
),
corrected AS (
  UPDATE public.factory_target_bonus_manual_payments p
     SET amount_usd = 26
    FROM target
   WHERE p.id = target.id
  RETURNING p.id
)
INSERT INTO public.audit_log (user_id, username, company_id, action, table_name, record_id, record_identifier, reason, changes)
SELECT 'system', 'system', 12, 'update', 'factory_target_bonus_manual_payments', corrected.id, corrected.id::text,
       'Owner-approved reconciliation (2026-11-17): bonus register matched to voucher PV-12-2026-000101, edited to 26.00 USD on 2026-11-02; voucher unchanged',
       jsonb_build_object('amount_usd', jsonb_build_object('old', '27.00', 'new', '26.00'), 'voucher_id', 16893)
  FROM corrected;

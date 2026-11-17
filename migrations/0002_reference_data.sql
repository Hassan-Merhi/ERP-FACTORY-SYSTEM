-- 0002_reference_data.sql
--
-- Reference rows the application expects to exist, formerly inserted on every
-- boot by server/startup-schema (004-post-deploy-tables, 010-security-
-- notifications-and-precision). Values are copied verbatim from those modules.
--
-- Idempotent (ON CONFLICT DO NOTHING): on an adopted production database whose
-- rows already exist, and whose settings operators may have edited, nothing is
-- inserted or changed.

-- Singleton settings rows read with WHERE id = 1 / id = 2.
INSERT INTO public.export_settings (id, gmail_user, gmail_app_password, schedule_enabled)
VALUES (1, '', '', false)
ON CONFLICT (id) DO NOTHING;

-- whatsapp_settings id=1: Green API credentials and enable toggles (off).
INSERT INTO public.whatsapp_settings (id, instance_id, api_token, enabled, monthly_auto_send, daily_auto_send)
VALUES (1, '', '', false, false, false)
ON CONFLICT (id) DO NOTHING;

-- whatsapp_settings id=2: optional POS-specific instance, enabled so the
-- fallback to id=1 works.
INSERT INTO public.whatsapp_settings (id, instance_id, api_token, enabled, monthly_auto_send, daily_auto_send)
VALUES (2, '', '', true, false, false)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.net_position_export_settings (id, frequency, send_hour, enabled, auto_send)
VALUES (1, 'daily', 18, false, false)
ON CONFLICT (id) DO NOTHING;

-- Default bale label colours.
INSERT INTO public.label_design_colors (slug, label, color_hex, sort_order, is_default) VALUES
  ('purple', 'Purple (#1)',   '#5B21B6', 1, true),
  ('green',  'Green (#2)',    '#047857', 2, true),
  ('gold',   'Gold (#3)',     '#B8860B', 3, true),
  ('white',  'White (#4)',    '#F5F5F5', 4, true),
  ('red',    'HMD Intl (#5)', '#B91C1C', 5, true)
ON CONFLICT (slug) DO NOTHING;

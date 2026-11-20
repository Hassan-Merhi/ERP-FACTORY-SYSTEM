-- 0012_offline_pc_record_map.sql
--
-- Full offline mode (Phase C1). A PC gives the customers it creates offline,
-- and the ledger accounts it opens for them, local ids (at or above
-- 1000000000). When the cloud creates its own customer for such an entry it
-- records here which cloud row each local id became, per PC, so later entries
-- from that PC naming them are translated before they are applied
-- (server/edge/phase9PcRecordMap.mjs). Rows are never changed or removed.
--
-- Additive only: one new table. No existing row is changed.

CREATE TABLE IF NOT EXISTS factory_edge_pc_record_map (
  site_id uuid NOT NULL,
  record_type text NOT NULL,
  local_id integer NOT NULL,
  cloud_id integer NOT NULL,
  company_id integer NOT NULL REFERENCES companies(id),
  operation_id uuid NOT NULL,
  mapped_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT factory_edge_pc_record_map_pkey PRIMARY KEY (site_id, record_type, local_id),
  CONSTRAINT factory_edge_pc_record_map_type_check CHECK (record_type IN ('customer', 'ledger_account')),
  CONSTRAINT factory_edge_pc_record_map_local_id_check CHECK (local_id >= 1000000000),
  CONSTRAINT factory_edge_pc_record_map_cloud_id_check CHECK (cloud_id > 0 AND cloud_id < 1000000000)
);

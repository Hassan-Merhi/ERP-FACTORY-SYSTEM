CREATE TABLE IF NOT EXISTS factory_container_vessel_tracking (
  id serial PRIMARY KEY,
  company_id integer NOT NULL,
  container_id integer NOT NULL REFERENCES factory_containers(id) ON DELETE CASCADE,
  vessel_name varchar(255),
  imo varchar(16),
  mmsi varchar(16),
  voyage_number varchar(100),
  carrier varchar(100),
  mapping_source varchar(50),
  mapping_confidence varchar(20) NOT NULL DEFAULT 'unknown',
  latitude numeric(10,7),
  longitude numeric(11,7),
  speed_knots numeric(8,3),
  course numeric(8,3),
  heading integer,
  navigation_status varchar(100),
  ais_destination text,
  ais_eta timestamptz,
  last_position_at timestamptz,
  last_ais_update_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS factory_container_vessel_tracking_container_unique
  ON factory_container_vessel_tracking(container_id);
CREATE INDEX IF NOT EXISTS factory_container_vessel_tracking_company_idx
  ON factory_container_vessel_tracking(company_id);
CREATE INDEX IF NOT EXISTS factory_container_vessel_tracking_mmsi_idx
  ON factory_container_vessel_tracking(mmsi);

ALTER TABLE factory_container_vessel_tracking
  DROP CONSTRAINT IF EXISTS factory_container_vessel_tracking_latitude_check;
ALTER TABLE factory_container_vessel_tracking
  ADD CONSTRAINT factory_container_vessel_tracking_latitude_check
  CHECK (latitude IS NULL OR latitude BETWEEN -90 AND 90);

ALTER TABLE factory_container_vessel_tracking
  DROP CONSTRAINT IF EXISTS factory_container_vessel_tracking_longitude_check;
ALTER TABLE factory_container_vessel_tracking
  ADD CONSTRAINT factory_container_vessel_tracking_longitude_check
  CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180);
